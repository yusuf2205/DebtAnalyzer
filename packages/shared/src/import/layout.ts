import type { FieldKey, LayoutMapping, SheetData, WeekColumn } from './types';

export const REQUIRED_FIELDS: FieldKey[] = ['supplier', 'contractNo', 'amount', 'currency'];

const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Синонимы заголовков. Сопоставление — по нормализованному тексту; пользователь может переопределить в мастере импорта. */
const SYNONYMS: Record<FieldKey, RegExp> = {
  project: /^проект$/,
  contractNo: /^(номер (контракта|договора)|№ (контракта|договора)|контракт|договор)$/,
  supplier: /^(наименование контрагента|контрагент|поставщик|наименование поставщика)$/,
  goods: /^(наименовани[яе] товара|товар|наименование)$/,
  amount: /^(сумма (контракта|договора)|сумма)$/,
  paid: /^оплачено$/,
  debt: /^остаток суммы/,
  currency: /^валюта$/,
  notes: /^примечани[ея]$/,
  executor: /^исполнитель$/,
};

const MONTHS: Record<string, number> = {
  январь: 1, февраль: 2, март: 3, апрель: 4, май: 5, июнь: 6, июль: 7, август: 8,
  сентябрь: 9, октябрь: 10, ноябрь: 11, декабрь: 12,
};

export function detectLayout(sheet: SheetData, maxScanRows = 40): LayoutMapping | null {
  let headerRow = 0;
  for (let r = 1; r <= Math.min(sheet.rowCount, maxScanRows) && !headerRow; r++) {
    let hits = 0;
    for (let c = 1; c <= sheet.colCount; c++) {
      const t = norm(sheet.cell(r, c).value);
      if (!t) continue;
      if (SYNONYMS.amount.test(t) || SYNONYMS.supplier.test(t) || SYNONYMS.currency.test(t) || SYNONYMS.paid.test(t)) hits++;
    }
    if (hits >= 3) headerRow = r;
  }
  if (!headerRow) return null;

  const fields: Partial<Record<FieldKey, number>> = {};
  for (let c = 1; c <= sheet.colCount; c++) {
    const t = norm(sheet.cell(headerRow, c).value);
    if (!t) continue;
    for (const key of Object.keys(SYNONYMS) as FieldKey[]) {
      if (fields[key] === undefined && SYNONYMS[key].test(t)) { fields[key] = c; break; }
    }
  }

  // Недельные колонки: строка над заголовком содержит W1..W4, строкой выше — название месяца.
  const weekColumns: WeekColumn[] = [];
  const wRow = headerRow - 1, mRow = headerRow - 2;
  if (wRow >= 1) {
    for (let c = 1; c <= sheet.colCount; c++) {
      const w = /^w([1-4])$/i.exec(String(sheet.cell(wRow, c).value ?? '').trim());
      if (!w) continue;
      const month = mRow >= 1 ? MONTHS[norm(sheet.cell(mRow, c).value)] : undefined;
      if (month) weekColumns.push({ col: c, month, week: Number(w[1]) as 1 | 2 | 3 | 4 });
    }
  }

  const missing = REQUIRED_FIELDS.filter((f) => fields[f] === undefined);
  return { headerRow, fields, weekColumns, missing };
}
