import { toUsd, type CurrencyCode, type UzsRates } from './currency';
import { type Dec, type DecInput, money } from './money';

/** Подтверждённая запись курса: сколько UZS за 1 единицу валюты, действует с effectiveDate (yyyy-mm-dd). */
export interface RateRecord { id: string; currency: CurrencyCode; uzsPerUnit: string; effectiveDate: string; source: string; confirmedAt?: string | null }

export interface RateUsed { id: string; currency: CurrencyCode; uzsPerUnit: string; effectiveDate: string; source: string }
export interface RateSet { asOf: string; uzsPerUnit: UzsRates; used: RateUsed[] }

export interface UsdValue {
  usd: Dec | null;
  /** USD за 1 единицу исходной валюты (8 знаков); для USD — «1». */
  rate: string | null;
  /** Дата действия использованного курса исходной валюты. */
  rateDate: string | null;
}

/**
 * Книга курсов. Для отчёта на дату D берётся последний ПОДТВЕРЖДЁННЫЙ курс с датой действия ≤ D
 * (при равных датах — подтверждённый позже). Курс «из будущего» не используется, поэтому появление новых курсов
 * не меняет уже построенные отчёты на более ранние даты. Нет курса — нет пересчёта (никогда не угадываем).
 */
export class RatesBook {
  private byCurrency = new Map<CurrencyCode, RateRecord[]>();

  constructor(records: RateRecord[]) {
    for (const r of records) {
      if (r.currency === 'UZS') continue; // UZS — базовая единица курсов
      this.byCurrency.set(r.currency, [...(this.byCurrency.get(r.currency) ?? []), r]);
    }
    for (const list of this.byCurrency.values()) {
      list.sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate) || (a.confirmedAt ?? '').localeCompare(b.confirmedAt ?? '') || a.id.localeCompare(b.id));
    }
  }

  asOf(date: string): RateSet {
    const uzsPerUnit: UzsRates = {};
    const used: RateUsed[] = [];
    for (const [cur, list] of this.byCurrency) {
      let pick: RateRecord | undefined;
      for (const r of list) if (r.effectiveDate <= date) pick = r; else break;
      if (pick) { uzsPerUnit[cur] = pick.uzsPerUnit; used.push({ id: pick.id, currency: cur, uzsPerUnit: pick.uzsPerUnit, effectiveDate: pick.effectiveDate, source: pick.source }); }
    }
    return { asOf: date, uzsPerUnit, used };
  }

  /** Эквивалент в USD или usd=null, если нужного курса на дату нет. */
  toUsd(amount: DecInput, currency: CurrencyCode, set: RateSet): UsdValue {
    if (currency === 'USD') return { usd: money(amount), rate: '1', rateDate: null };
    const have = currency === 'UZS' || set.uzsPerUnit[currency] !== undefined;
    if (!have || set.uzsPerUnit.USD === undefined) return { usd: null, rate: null, rateDate: null };
    const c = toUsd(amount, currency, set.uzsPerUnit);
    return { usd: c.usd, rate: c.rateUsed.toString(), rateDate: currency === 'UZS' ? (set.used.find((u) => u.currency === 'USD')?.effectiveDate ?? null) : (set.used.find((u) => u.currency === currency)?.effectiveDate ?? null) };
  }

  /** Валюты из списка, которые нельзя пересчитать в USD на эту дату. */
  missing(set: RateSet, currencies: Iterable<CurrencyCode>): CurrencyCode[] {
    const out: CurrencyCode[] = [];
    for (const c of new Set(currencies)) if (c !== 'USD' && !(set.uzsPerUnit.USD !== undefined && (c === 'UZS' || set.uzsPerUnit[c] !== undefined))) out.push(c);
    return out;
  }
}
