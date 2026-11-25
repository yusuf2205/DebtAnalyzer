import ExcelJS from 'exceljs';
import type { Response } from 'express';

export interface Col { header: string; key: string; width: number; type?: 'text' | 'int' | 'money' | 'date' }

const FMT = { int: '#,##0', money: '#,##0.00', date: 'dd.mm.yyyy' } as const;

/** Excel с форматированием: закреплённый заголовок, автофильтр, числовые форматы (суммы — числами, не текстом). */
export async function sendXlsx(res: Response, filename: string, sheetName: string, cols: Col[], rows: Record<string, unknown>[], footer?: Record<string, unknown>[]) {
  const wb = new ExcelJS.Workbook();
  wb.created = new Date();
  const ws = wb.addWorksheet(sheetName, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = cols.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  const head = ws.getRow(1);
  head.font = { bold: true };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } };
  const add = (r: Record<string, unknown>) => {
    const row = ws.addRow(Object.fromEntries(cols.map((c) => [c.key, c.type === 'money' || c.type === 'int' ? (r[c.key] === null || r[c.key] === undefined || r[c.key] === '' ? null : Number(r[c.key])) : r[c.key]])));
    cols.forEach((c, i) => { if (c.type && c.type !== 'text') row.getCell(i + 1).numFmt = FMT[c.type]; });
    return row;
  };
  rows.forEach(add);
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
  if (footer?.length) {
    ws.addRow([]);
    footer.forEach((f) => { const r = add(f); r.font = { bold: true }; });
  }
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="export.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  await wb.xlsx.write(res);
  res.end();
}
