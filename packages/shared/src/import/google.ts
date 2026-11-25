import type { Cell, SheetData } from './types';

/** Поля ответа Sheets API, которые мы запрашиваем (минимум данных: значения, формулы, форматы дат, объединения). */
export const SHEETS_FIELDS =
  'properties.title,sheets(properties(sheetId,title,hidden),merges,data(startRow,startColumn,rowData(values(effectiveValue,userEnteredValue,effectiveFormat.numberFormat.type))))';

const ERR: Record<string, string> = { REF: '#REF!', DIV_ZERO: '#DIV/0!', VALUE: '#VALUE!', NAME: '#NAME?', NA: '#N/A', NUM: '#NUM!', NULL: '#NULL!' };
const EMPTY: Cell = { kind: 'empty', value: null };

class GridSheet implements SheetData {
  cells = new Map<number, Cell>();
  rowCount = 0;
  colCount = 0;
  constructor(public name: string, public hidden: boolean, public merges: string[]) {}
  set(r: number, c: number, cell: Cell) { this.cells.set(r * 100000 + c, cell); if (r > this.rowCount) this.rowCount = r; if (c > this.colCount) this.colCount = c; }
  cell(r: number, c: number): Cell { return this.cells.get(r * 100000 + c) ?? EMPTY; }
}

function serialToDate(n: number): Date { return new Date(Math.round((n - 25569) * 86400_000)); }

function convert(v: any): Cell {
  const ev = v?.effectiveValue;
  const formula: string | undefined = typeof v?.userEnteredValue?.formulaValue === 'string' ? v.userEnteredValue.formulaValue : undefined;
  const withF = (c: Cell): Cell => (formula ? { ...c, formula } : c);
  if (!ev) return formula ? { kind: 'empty', value: null, formula } : EMPTY;
  if (ev.errorValue) return withF({ kind: 'error', value: null, error: ERR[ev.errorValue.type] ?? '#ERROR!' });
  if (typeof ev.numberValue === 'number') {
    const t = v?.effectiveFormat?.numberFormat?.type;
    if (t === 'DATE' || t === 'DATE_TIME') return withF({ kind: 'date', value: serialToDate(ev.numberValue) });
    return withF({ kind: 'number', value: ev.numberValue });
  }
  if (typeof ev.boolValue === 'boolean') return withF({ kind: 'boolean', value: ev.boolValue });
  if (typeof ev.stringValue === 'string') {
    if (ev.stringValue === '') return formula ? { kind: 'empty', value: null, formula } : EMPTY;
    return withF({ kind: 'string', value: ev.stringValue });
  }
  return EMPTY;
}

function colName(n: number): string { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }

/**
 * Ответ spreadsheets.get (includeGridData) -> SheetData[]. Объединённые ячейки заполняются значением
 * верхней левой, как это делает чтение XLSX, — движок импорта не должен различать источники.
 */
export function sheetsApiToSheetData(json: any): { title: string; sheets: SheetData[] } {
  const sheets: SheetData[] = (json.sheets ?? []).map((sh: any) => {
    const merges: string[] = (sh.merges ?? []).map((m: any) => `${colName(m.startColumnIndex + 1)}${m.startRowIndex + 1}:${colName(m.endColumnIndex)}${m.endRowIndex}`);
    const g = new GridSheet(sh.properties?.title ?? 'Sheet', !!sh.properties?.hidden, merges);
    for (const block of sh.data ?? []) {
      const r0 = block.startRow ?? 0, c0 = block.startColumn ?? 0;
      (block.rowData ?? []).forEach((row: any, ri: number) => (row.values ?? []).forEach((v: any, ci: number) => {
        const cell = convert(v);
        if (cell.kind !== 'empty' || cell.formula) g.set(r0 + ri + 1, c0 + ci + 1, cell);
      }));
    }
    for (const m of sh.merges ?? []) {
      const master = g.cell(m.startRowIndex + 1, m.startColumnIndex + 1);
      if (master.kind === 'empty') continue;
      for (let r = m.startRowIndex + 1; r <= m.endRowIndex; r++) for (let c = m.startColumnIndex + 1; c <= m.endColumnIndex; c++) if (r !== m.startRowIndex + 1 || c !== m.startColumnIndex + 1) g.set(r, c, { ...master, formula: undefined });
    }
    return g;
  });
  return { title: json.properties?.title ?? 'Google Sheets', sheets };
}

// ---- Снимок листов (JSON): позволяет повторно анализировать данные, полученные через API, без исходного файла ----

interface SnapSheet { name: string; hidden: boolean; merges: string[]; rows: number; cols: number; cells: [number, number, Cell][] }

export function serializeSheets(sheets: SheetData[]): string {
  const out: SnapSheet[] = sheets.map((s) => {
    const cells: [number, number, Cell][] = [];
    for (let r = 1; r <= s.rowCount; r++) for (let c = 1; c <= s.colCount; c++) { const cell = s.cell(r, c); if (cell.kind !== 'empty' || cell.formula) cells.push([r, c, cell]); }
    return { name: s.name, hidden: s.hidden, merges: s.merges, rows: s.rowCount, cols: s.colCount, cells };
  });
  return JSON.stringify({ v: 1, sheets: out }, (_k, val) => (val instanceof Date ? { $date: val.toISOString() } : val));
}

export function deserializeSheets(text: string): SheetData[] {
  const data = JSON.parse(text, (_k, val) => (val && typeof val === 'object' && '$date' in val ? new Date(val.$date) : val));
  if (data?.v !== 1) throw new Error('Неизвестный формат снимка таблицы');
  return (data.sheets as SnapSheet[]).map((s) => {
    const g = new GridSheet(s.name, s.hidden, s.merges);
    for (const [r, c, cell] of s.cells) g.set(r, c, cell);
    g.rowCount = Math.max(g.rowCount, s.rows); g.colCount = Math.max(g.colCount, s.cols);
    return g;
  });
}
