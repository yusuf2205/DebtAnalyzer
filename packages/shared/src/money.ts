import Decimal from 'decimal.js';

// Все финансовые расчёты — только Decimal. ROUND_HALF_UP соответствует бухгалтерской практике (0.005 -> 0.01).
export const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export type Dec = Decimal;
export type DecInput = Decimal.Value;

/** Безопасное создание Decimal. number -> через строку, чтобы не тащить двоичный шум. */
export function dec(v: DecInput | null | undefined): Dec {
  if (v === null || v === undefined || v === '') return new D(0);
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`Non-finite number: ${v}`);
    return new D(v.toString());
  }
  return new D(v);
}

/** Округление до 2 знаков — только на границе отображения/хранения, не в промежуточных вычислениях. */
export function money(v: DecInput): Dec {
  return dec(v).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

export function sum(values: DecInput[]): Dec {
  return values.reduce<Dec>((acc, v) => acc.plus(dec(v)), new D(0));
}

export function fmt(v: DecInput, places = 2): string {
  return money(v).toFixed(places);
}
