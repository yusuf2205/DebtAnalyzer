import ExcelJS from 'exceljs';
import type { Response } from 'express';
import PDFDocument from 'pdfkit';
import type { Cellv, Column, ReportResult, Row } from './report-types';

const FONT = () => ({ regular: require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf'), bold: require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf') });
const safeName = (r: ReportResult) => `${r.title}_${r.asOf}`.replace(/[\\/:*?"<>|]/g, '_');
const cd = (name: string, ext: string, res: Response) => res.setHeader('Content-Disposition', `attachment; filename="report.${ext}"; filename*=UTF-8''${encodeURIComponent(`${name}.${ext}`)}`);
const hasValue = (v: Cellv | undefined) => v !== null && v !== undefined && v !== '';

// ---------------- CSV ----------------
/** CSV: UTF-8 с BOM (Excel открывает кириллицу корректно), разделитель «;», числа с точкой — пригодно для машинной обработки. */
export function toCsv(r: ReportResult): string {
  const esc = (v: Cellv | undefined) => { const s = v === null || v === undefined ? '' : String(v); return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const line = (row: Row) => r.columns.map((c) => esc(row[c.key])).join(';');
  const out = [r.columns.map((c) => esc(c.header)).join(';'), ...r.rows.map(line), ...r.totals.map(line)];
  return '﻿' + out.join('\r\n') + '\r\n';
}
export function sendCsv(res: Response, r: ReportResult) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8'); cd(safeName(r), 'csv', res); res.send(toCsv(r));
}

// ---------------- XLSX ----------------
const XFMT: Record<string, string> = { int: '#,##0', money: '#,##0.00', date: 'dd.mm.yyyy', rate: '0.00000000', percent: '0.0"%"' };

function cellValue(c: Column, v: Cellv | undefined): ExcelJS.CellValue {
  if (!hasValue(v)) return null;
  if (c.type === 'text') return String(v);
  if (c.type === 'date') { const d = new Date(String(v)); return Number.isNaN(d.getTime()) ? String(v) : d; }
  const n = Number(v);
  return Number.isFinite(n) ? n : String(v); // суммы — числами, не текстом
}

export async function sendXlsx(res: Response, r: ReportResult) {
  const wb = new ExcelJS.Workbook();
  wb.created = new Date(); wb.title = r.title;
  const ws = wb.addWorksheet(r.title.slice(0, 31));
  const n = r.columns.length;
  const put = (row: number, text: string, o: { bold?: boolean; size?: number; color?: string } = {}) => {
    const cell = ws.getCell(row, 1); cell.value = text; cell.font = { bold: o.bold, size: o.size, color: o.color ? { argb: o.color } : undefined };
    ws.mergeCells(row, 1, row, Math.max(n, 2)); cell.alignment = { wrapText: true, vertical: 'top' };
  };
  let row = 1;
  put(row++, r.title, { bold: true, size: 14 });
  put(row++, `Сформирован: ${new Date(r.generatedAt).toLocaleString('ru-RU')}`, { color: 'FF666666' });
  put(row++, r.filters.join(' · '), { color: 'FF666666' });
  if (r.rates.used.length) put(row++, `Использованные курсы (UZS за 1 ед.): ${r.rates.used.map((u) => `${u.currency} ${u.uzsPerUnit} от ${u.effectiveDate}`).join('; ')}`, { color: 'FF666666' });
  for (const w of r.warnings) put(row++, `⚠ ${w}`, { color: 'FFB45309' });
  row++;
  const headerRow = row;
  r.columns.forEach((c, i) => { ws.getColumn(i + 1).width = c.width; const cell = ws.getCell(headerRow, i + 1); cell.value = c.header; cell.font = { bold: true }; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } }; cell.alignment = { wrapText: true, vertical: 'middle', horizontal: c.type === 'text' ? 'left' : 'right' }; cell.border = { bottom: { style: 'thin' } }; });
  const addRow = (data: Row, bold = false) => {
    row++;
    r.columns.forEach((c, i) => { const cell = ws.getCell(row, i + 1); cell.value = cellValue(c, data[c.key]); if (c.type !== 'text') cell.numFmt = XFMT[c.type]; if (bold) { cell.font = { bold: true }; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } }; } });
  };
  r.rows.forEach((d) => addRow(d));
  const lastData = row;
  if (r.totals.length) { row++; r.totals.forEach((d) => addRow(d, true)); }
  ws.views = [{ state: 'frozen', ySplit: headerRow, xSplit: 0 }];
  if (r.rows.length) ws.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: lastData, column: n } };
  ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: `${headerRow}:${headerRow}` };
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); cd(safeName(r), 'xlsx', res);
  await wb.xlsx.write(res); res.end();
}

// ---------------- PDF ----------------
const ruNum = (v: Cellv | undefined, c: Column): string => {
  if (!hasValue(v)) return '';
  if (c.type === 'text') return String(v);
  if (c.type === 'date') { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v)); return m ? `${m[3]}.${m[2]}.${m[1]}` : String(v); }
  const n = Number(v); if (!Number.isFinite(n)) return String(v);
  if (c.type === 'int') return n.toLocaleString('ru-RU');
  if (c.type === 'rate') return n.toLocaleString('ru-RU', { maximumFractionDigits: 6 });
  if (c.type === 'percent') return `${n.toLocaleString('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`;
  return n.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

export function sendPdf(res: Response, r: ReportResult) {
  const f = FONT();
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 28, bufferPages: true, info: { Title: r.title, Producer: 'Procurement Finance' } });
  doc.registerFont('R', f.regular); doc.registerFont('B', f.bold);
  res.setHeader('Content-Type', 'application/pdf'); cd(safeName(r), 'pdf', res);
  doc.pipe(res);

  const W = doc.page.width - 56, left = 28, rowH = 15, size = r.columns.length > 12 ? 6.2 : r.columns.length > 9 ? 7 : 8;
  const totalW = r.columns.reduce((a, c) => a + c.width, 0);
  const xs: number[] = []; const ws: number[] = [];
  let x = left; for (const c of r.columns) { const w = (c.width / totalW) * W; xs.push(x); ws.push(w); x += w; }

  doc.font('B').fontSize(14).fillColor('#111').text(r.title, left, 28, { width: W });
  doc.font('R').fontSize(8).fillColor('#555').text(`Сформирован: ${new Date(r.generatedAt).toLocaleString('ru-RU')}`, { width: W });
  doc.text(r.filters.join(' · '), { width: W });
  if (r.rates.used.length) doc.text(`Курсы (UZS за 1 ед.): ${r.rates.used.map((u) => `${u.currency} ${u.uzsPerUnit} от ${u.effectiveDate}`).join('; ')}`, { width: W });
  for (const w of r.warnings) doc.fillColor('#b45309').text(`⚠ ${w}`, { width: W });
  doc.fillColor('#111').moveDown(0.5);

  const header = (y: number) => {
    const hh = rowH * 2; // заголовки переносятся на две строки
    doc.rect(left, y, W, hh + 2).fill('#e5e7eb'); doc.fillColor('#111').font('B').fontSize(size);
    r.columns.forEach((c, i) => doc.text(c.header, xs[i] + 2, y + 3, { width: ws[i] - 4, height: hh - 2, ellipsis: true, align: c.type === 'text' ? 'left' : 'right' }));
    return y + hh + 4;
  };
  let y = header(doc.y);
  const draw = (row: Row, bold: boolean, shade: boolean) => {
    if (y + rowH > doc.page.height - 36) { doc.addPage(); y = header(28); }
    if (shade) doc.rect(left, y - 1, W, rowH).fill('#f3f4f6');
    doc.fillColor('#111').font(bold ? 'B' : 'R').fontSize(size);
    r.columns.forEach((c, i) => doc.text(ruNum(row[c.key], c), xs[i] + 2, y + 2, { width: ws[i] - 4, height: rowH, ellipsis: true, lineBreak: false, align: c.type === 'text' ? 'left' : 'right' }));
    doc.moveTo(left, y + rowH - 1).lineTo(left + W, y + rowH - 1).lineWidth(0.25).strokeColor('#ddd').stroke();
    y += rowH;
  };
  r.rows.forEach((row, i) => draw(row, false, i % 2 === 1));
  if (!r.rows.length) { doc.font('R').fontSize(9).fillColor('#666').text('Данных за выбранные условия нет.', left, y + 4); }
  if (r.totals.length) { y += 4; r.totals.forEach((row) => draw(row, true, true)); }

  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc.font('R').fontSize(7).fillColor('#888').text(`Procurement Finance · ${r.title} · стр. ${i + 1} из ${range.count}`, left, doc.page.height - 22, { width: W, align: 'right', lineBreak: false });
  }
  doc.end();
}
