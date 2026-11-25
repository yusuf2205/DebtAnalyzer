import type { CurrencyCode } from '../currency';
import { parseDdMmYyyy } from './dates';
import { addr } from './reader';
import type { ControlTotal, RateCandidate, RateConflict, SheetData } from './types';

const LABELS: Record<string, CurrencyCode> = { евро: 'EUR', доллар: 'USD', рубль: 'RUB', eur: 'EUR', usd: 'USD', rub: 'RUB' };

/**
 * Ищет блоки «Курс валют»: заголовок -> подписи «Евро/Доллар/Рубль» -> строкой ниже значение (UZS за 1 единицу).
 * Ничего не выбирается автоматически: возвращаются ВСЕ кандидаты, конфликты помечаются отдельно.
 */
export function scanRates(sheets: SheetData[]): RateCandidate[] {
  const out: RateCandidate[] = [];
  for (const s of sheets) {
    for (let r = 1; r <= s.rowCount; r++) {
      for (let c = 1; c <= s.colCount; c++) {
        const cell = s.cell(r, c);
        if (cell.kind !== 'string' || !/курс валют/i.test(String(cell.value))) continue;
        let date = parseDdMmYyyy(String(cell.value));
        if (!date) {
          const below = s.cell(r + 1, c);
          if (below.kind === 'date') date = (below.value as Date).toISOString().slice(0, 10);
          else if (below.kind === 'string') date = parseDdMmYyyy(String(below.value));
        }
        for (let rr = r + 1; rr <= Math.min(r + 12, s.rowCount); rr++) {
          const lab = s.cell(rr, c);
          if (lab.kind !== 'string') continue;
          const cur = LABELS[String(lab.value).trim().toLowerCase()];
          if (!cur) continue;
          const val = s.cell(rr + 1, c + 1);
          if (val.kind === 'number' && typeof val.value === 'number' && val.value > 0) {
            out.push({ sheet: s.name, currency: cur, uzsPerUnit: String(val.value), date, cell: addr(rr + 1, c + 1), label: String(lab.value).trim() });
          }
        }
      }
    }
  }
  return out;
}

export function findRateConflicts(rates: RateCandidate[]): RateConflict[] {
  const by = new Map<CurrencyCode, RateCandidate[]>();
  for (const r of rates) by.set(r.currency, [...(by.get(r.currency) ?? []), r]);
  const out: RateConflict[] = [];
  for (const [currency, candidates] of by) {
    if (new Set(candidates.map((c) => c.uzsPerUnit)).size > 1) out.push({ currency, candidates });
  }
  return out;
}

/** Контрольные итоги самого источника («Итоговые суммы по каждой валюте отдельно») — для сверки с нашим пересчётом. */
export function scanControlTotals(sheets: SheetData[]): ControlTotal[] {
  const out: ControlTotal[] = [];
  for (const s of sheets) {
    for (let r = 1; r <= s.rowCount; r++) {
      for (let c = 1; c <= s.colCount; c++) {
        const cell = s.cell(r, c);
        if (cell.kind !== 'string' || !/итоговые суммы по каждой валюте/i.test(String(cell.value))) continue;
        for (let rr = r + 1; rr <= Math.min(r + 8, s.rowCount); rr++) {
          const code = s.cell(rr, c);
          const val = s.cell(rr, c + 1);
          if (code.kind === 'string' && /^[A-Z]{3}$/.test(String(code.value).trim()) && val.kind === 'number') {
            out.push({ currency: String(code.value).trim(), sourceValue: String(val.value), sheet: s.name, cell: addr(rr, c + 1) });
          }
        }
      }
    }
  }
  // Один и тот же блок повторяется на нескольких листах; дубликаты по (sheet, currency) не нужны.
  return out;
}
