import { describe, expect, it } from 'vitest';
import { analyzeSheet, deserializeSheets, readWorkbook, serializeSheets, sheetsApiToSheetData } from '../src/import';

const s = (v: string) => ({ effectiveValue: { stringValue: v } });
const n = (v: number) => ({ effectiveValue: { numberValue: v } });
const E = {};

/** Минимальный ответ Sheets API со структурой реального реестра (заголовок в строке 5, недели над ним). */
function apiResponse(rows: any[][], extraSheets: any[] = []) {
  const header = ['', s('№'), s('Проект'), s('Номер контракта'), s('Наименование контрагента'), s('Наименования товара'), s('Сумма контракта'), s('Оплачено'), s('Остаток суммы (ДОЛГ)'), s('Валюта'), E, E];
  const monthRow = [E, E, E, E, E, E, E, E, E, E, s('Июнь'), E]; // K3:L3 объединены
  const weekRow = [E, E, E, E, E, E, E, E, E, E, s('W1'), s('W2')];
  const norm = (r: any[]) => r.map((x) => (x === '' ? {} : x));
  return {
    properties: { title: 'Реестр' },
    sheets: [
      {
        properties: { sheetId: 1, title: 'Реестр договоров' },
        merges: [{ sheetId: 1, startRowIndex: 2, endRowIndex: 3, startColumnIndex: 10, endColumnIndex: 12 }],
        data: [{ startRow: 0, startColumn: 0, rowData: [{ values: [] }, { values: [] }, ...[monthRow, weekRow, header, ...rows].map((r) => ({ values: norm(r) }))] }],
      },
      ...extraSheets,
    ],
  };
}
const row = (sup: string, amount: number, paid: number, cur: string | null, extra: any[] = []) =>
  [E, n(1), s('P'), s('Договор №1 от 01.02.2026'), s(sup), s('Кабель'), n(amount), n(paid), amount - paid ? n(amount - paid) : E, cur ? s(cur) : E, ...extra];

describe('Google Sheets API -> SheetData', () => {
  it('даёт тот же результат анализа, что и XLSX: поля, недели, суммы', () => {
    const { sheets, title } = sheetsApiToSheetData(apiResponse([row('ACME MCHJ', 1000, 400, 'USD', [n(300), n(200)])]));
    expect(title).toBe('Реестр');
    const a = analyzeSheet(sheets[0], { allSheets: sheets });
    expect(a.mapping.headerRow).toBe(5);
    expect(a.mapping.weekColumns).toEqual([{ col: 11, month: 6, week: 1 }, { col: 12, month: 6, week: 2 }]); // объединённая «Июнь» заполнила K3 и L3
    expect(a.rows[0]).toMatchObject({ status: 'OK', amount: '1000.00', openingPaid: '400.00', currency: 'USD', contractDate: '2026-02-01' });
    expect(a.rows[0].plan.map((p) => p.amount)).toEqual(['300', '200']);
  });

  it('ошибки ячеек (#REF!) и формулы сохраняются и блокируют строку', () => {
    const bad = row('ACME', 1, 0, 'USD');
    bad[6] = { effectiveValue: { errorValue: { type: 'REF' } }, userEnteredValue: { formulaValue: '=B704' } };
    const { sheets } = sheetsApiToSheetData(apiResponse([bad]));
    const a = analyzeSheet(sheets[0], { allSheets: sheets });
    expect(a.rows[0].status).toBe('BLOCKED');
    expect(a.rows[0].raw.G6).toMatchObject({ v: '#REF!', f: '=B704' });
  });

  it('формула «Оплачено» даёт значение и текст формулы', () => {
    const r = row('ACME', 100, 100, 'USD');
    r[7] = { effectiveValue: { numberValue: 100 }, userEnteredValue: { formulaValue: '=60+40' } };
    const { sheets } = sheetsApiToSheetData(apiResponse([r]));
    const a = analyzeSheet(sheets[0], { allSheets: sheets });
    expect(a.rows[0].openingPaid).toBe('100.00');
    expect(a.rows[0].openingPaidFormula).toBe('=60+40');
  });

  it('скрытый лист и блок курсов с датой-ячейкой', () => {
    const rates = {
      properties: { sheetId: 2, title: 'Расчёт' },
      data: [{ startRow: 2, startColumn: 1, rowData: [
        { values: [s('Курс валют')] },
        { values: [{ effectiveValue: { numberValue: 46314 }, effectiveFormat: { numberFormat: { type: 'DATE' } } }] },
        { values: [s('Доллар'), s('Сумм')] },
        { values: [n(1), n(12085)] },
      ] }],
    };
    const hidden = { properties: { sheetId: 3, title: 'Лист4', hidden: true }, data: [] };
    const { sheets } = sheetsApiToSheetData(apiResponse([row('ACME', 1, 0, 'USD')], [rates, hidden]));
    expect(sheets[2].hidden).toBe(true);
    const a = analyzeSheet(sheets[0], { allSheets: sheets });
    expect(a.rates).toEqual([expect.objectContaining({ currency: 'USD', uzsPerUnit: '12085', date: '2026-10-19' })]);
  });

  it('снимок сериализуется и читается обратно без потерь (включая даты и формулы)', async () => {
    const { sheets } = sheetsApiToSheetData(apiResponse([row('ACME', 5, 1, 'USD', [n(4)])], []));
    const text = serializeSheets(sheets);
    const back = await readWorkbook(Buffer.from(text), 'x.gsheet.json');
    const a1 = analyzeSheet(sheets[0], { allSheets: sheets }), a2 = analyzeSheet(back[0], { allSheets: back });
    expect(a2.rows.map((r) => r.fingerprint)).toEqual(a1.rows.map((r) => r.fingerprint));
    expect(deserializeSheets(text)[0].name).toBe('Реестр договоров');
  });
});
