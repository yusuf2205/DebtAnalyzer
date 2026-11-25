import ExcelJS from 'exceljs';
import { deserializeSheets } from './google';
import type { Cell, SheetData, SheetInfo } from './types';

const EXCEL_ERROR = /^#(REF!|N\/A|VALUE!|DIV\/0!|NAME\?|NUM!|NULL!)$/;
const EMPTY: Cell = { kind: 'empty', value: null };

class MapSheet implements SheetData {
  private cells = new Map<number, Cell>();
  rowCount = 0;
  colCount = 0;
  constructor(public name: string, public hidden: boolean, public merges: string[]) {}
  private key(r: number, c: number) { return r * 100000 + c; }
  set(r: number, c: number, cell: Cell) {
    this.cells.set(this.key(r, c), cell);
    if (r > this.rowCount) this.rowCount = r;
    if (c > this.colCount) this.colCount = c;
  }
  cell(r: number, c: number): Cell { return this.cells.get(this.key(r, c)) ?? EMPTY; }
  get size() { return this.cells.size; }
}

function toCell(v: ExcelJS.CellValue): Cell {
  if (v === null || v === undefined) return EMPTY;
  if (typeof v === 'number') return { kind: 'number', value: v };
  if (typeof v === 'boolean') return { kind: 'boolean', value: v };
  if (v instanceof Date) return { kind: 'date', value: v };
  if (typeof v === 'string') {
    if (EXCEL_ERROR.test(v.trim())) return { kind: 'error', value: null, error: v.trim() };
    return v === '' ? EMPTY : { kind: 'string', value: v };
  }
  const o = v as unknown as Record<string, any>;
  if (o.richText) return { kind: 'string', value: o.richText.map((t: any) => t.text).join('') };
  if (o.error) return { kind: 'error', value: null, error: String(o.error) };
  if (o.formula !== undefined || o.sharedFormula !== undefined) {
    const formula = o.formula !== undefined ? String(o.formula) : `=shared(${o.sharedFormula})`;
    const r = o.result;
    if (r === undefined || r === null) return { kind: 'empty', value: null, formula, noCachedValue: r === undefined };
    if (typeof r === 'object' && r && 'error' in r) return { kind: 'error', value: null, error: String(r.error), formula };
    const base = toCell(r as ExcelJS.CellValue);
    return { ...base, formula };
  }
  if (o.text !== undefined) return { kind: 'string', value: String(o.text) }; // hyperlink
  return EMPTY;
}

export async function readXlsx(buf: Buffer | ArrayBuffer | Uint8Array): Promise<SheetData[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as any);
  return wb.worksheets.map((ws) => {
    const s = new MapSheet(ws.name, ws.state !== 'visible', ws.model.merges ?? []);
    ws.eachRow({ includeEmpty: false }, (row, rn) => {
      row.eachCell({ includeEmpty: false }, (c, cn) => {
        const cell = toCell(c.value);
        if (cell.kind !== 'empty' || cell.formula) s.set(rn, cn, cell);
      });
    });
    return s;
  });
}

function detectDelimiter(text: string): string {
  const head = text.split(/\r?\n/).slice(0, 10).join('\n');
  const counts = [';', ',', '\t'].map((d) => [d, head.split(d).length - 1] as const);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ',';
}

export function parseCsvText(text: string): string[][] {
  const delim = detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === delim) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export function readCsv(buf: Buffer | Uint8Array, name = 'CSV'): SheetData[] {
  let text = Buffer.from(buf).toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const s = new MapSheet(name, false, []);
  parseCsvText(text).forEach((r, ri) =>
    r.forEach((v, ci) => {
      if (v === '') return;
      const t = v.trim();
      if (/^-?\d+(\.\d+)?$/.test(t)) s.set(ri + 1, ci + 1, { kind: 'number', value: Number(t) });
      else s.set(ri + 1, ci + 1, EXCEL_ERROR.test(t) ? { kind: 'error', value: null, error: t } : { kind: 'string', value: v });
    }),
  );
  return [s];
}

export async function readWorkbook(buf: Buffer, filename: string): Promise<SheetData[]> {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.gsheet.json')) return deserializeSheets(buf.toString('utf8')); // снимок, полученный через Google Sheets API
  const ext = lower.split('.').pop();
  if (ext === 'xlsx' || ext === 'xlsm') return readXlsx(buf);
  if (ext === 'csv') return readCsv(buf, filename);
  if (ext === 'xls') throw new Error('Формат XLS (BIFF) пока не поддерживается: сохраните файл как XLSX. Поддержка XLS запланирована через конвертацию LibreOffice в worker.');
  throw new Error(`Неподдерживаемый формат файла: .${ext}`);
}

export function describeSheets(sheets: SheetData[]): SheetInfo[] {
  return sheets.map((s) => {
    let n = 0;
    for (let r = 1; r <= s.rowCount; r++) for (let c = 1; c <= s.colCount; c++) if (s.cell(r, c).kind !== 'empty') n++;
    return { name: s.name, hidden: s.hidden, rowCount: s.rowCount, colCount: s.colCount, nonEmptyCells: n, empty: n === 0 };
  });
}

export function colLetter(n: number): string {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
export function addr(r: number, c: number): string { return `${colLetter(c)}${r}`; }
