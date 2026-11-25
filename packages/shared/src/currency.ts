import { D, dec, money, type Dec, type DecInput } from './money';

export const CURRENCIES = ['USD', 'UZS', 'RUB', 'EUR'] as const;
export type CurrencyCode = (typeof CURRENCIES)[number];

/** Известные алиасы написания валюты. Каждое применение алиаса попадает в отчёт импорта (не молчаливая правка). */
export const CURRENCY_ALIASES: Record<string, CurrencyCode> = {
  USD: 'USD', UZS: 'UZS', RUB: 'RUB', EUR: 'EUR',
  EURO: 'EUR', 'ЕВРО': 'EUR',
};

export function parseCurrency(raw: unknown): { code: CurrencyCode | null; aliasUsed: boolean; unknown: boolean; empty: boolean } {
  const s = raw === null || raw === undefined ? '' : String(raw).trim().toUpperCase();
  if (!s) return { code: null, aliasUsed: false, unknown: false, empty: true };
  const code = CURRENCY_ALIASES[s];
  if (!code) return { code: null, aliasUsed: false, unknown: true, empty: false };
  return { code, aliasUsed: s !== code, unknown: false, empty: false };
}

/**
 * Курс: сколько UZS стоит 1 единица валюты (UZS = 1) — так курсы заданы в исходной таблице.
 * Перевод в USD идёт через UZS-пивот без промежуточного округления.
 */
export type UzsRates = Partial<Record<CurrencyCode, DecInput>>;

export interface Conversion {
  original: Dec;
  currency: CurrencyCode;
  usd: Dec;
  /** USD за 1 единицу исходной валюты (справочно, 8 знаков). */
  rateUsed: Dec;
}

export function toUsd(amount: DecInput, currency: CurrencyCode, rates: UzsRates): Conversion {
  const a = dec(amount);
  if (currency === 'USD') return { original: a, currency, usd: money(a), rateUsed: new D(1) };
  const cur = currency === 'UZS' ? new D(1) : rates[currency] !== undefined ? dec(rates[currency]) : null;
  const usd = rates.USD !== undefined ? dec(rates.USD) : null;
  if (!cur || cur.lte(0)) throw new Error(`Нет курса для ${currency}`);
  if (!usd || usd.lte(0)) throw new Error('Нет курса USD');
  const result = a.times(cur).div(usd);
  return { original: a, currency, usd: money(result), rateUsed: cur.div(usd).toDecimalPlaces(8) };
}
