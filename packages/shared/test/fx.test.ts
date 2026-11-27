import { describe, expect, it } from 'vitest';
import { RatesBook, type RateRecord } from '../src';

const rec = (id: string, currency: any, uzs: string, date: string, confirmedAt = '2026-01-01T00:00:00Z'): RateRecord => ({ id, currency, uzsPerUnit: uzs, effectiveDate: date, source: 'ЦБ', confirmedAt });

describe('Книга курсов: выбор курса на дату', () => {
  const book = new RatesBook([
    rec('u1', 'USD', '11850', '2026-08-20'), rec('u2', 'USD', '12085', '2026-10-19'),
    rec('e1', 'EUR', '13950', '2026-08-20'), rec('e2', 'EUR', '13470', '2026-10-19'),
    rec('r1', 'RUB', '136', '2026-08-20'),
  ]);

  it('берётся последний курс с датой не позже отчётной', () => {
    expect(book.asOf('2026-09-30').uzsPerUnit).toEqual({ USD: '11850', EUR: '13950', RUB: '136' });
    expect(book.asOf('2026-10-19').uzsPerUnit.USD).toBe('12085');
    expect(book.asOf('2026-12-31').uzsPerUnit).toMatchObject({ USD: '12085', EUR: '13470', RUB: '136' });
  });

  it('до первого курса курсов нет — пересчёта нет', () => {
    const set = book.asOf('2026-01-01');
    expect(set.used).toEqual([]);
    expect(book.toUsd('100', 'EUR', set).usd).toBeNull();
    expect(book.toUsd('100', 'UZS', set).usd).toBeNull();
  });

  it('USD не требует курсов; остальные — требуют курс USD и свой курс', () => {
    const empty = book.asOf('2000-01-01');
    expect(book.toUsd('100.50', 'USD', empty)).toMatchObject({ usd: expect.anything(), rate: '1', rateDate: null });
    const only = new RatesBook([rec('e', 'EUR', '13000', '2026-01-01')]).asOf('2026-06-01');
    expect(new RatesBook([rec('e', 'EUR', '13000', '2026-01-01')]).toUsd('1', 'EUR', only).usd).toBeNull(); // нет курса USD
  });

  it('результат: эквивалент, использованный курс и его дата', () => {
    const set = book.asOf('2026-10-19');
    const v = book.toUsd('12085000', 'UZS', set);
    expect(v.usd!.toString()).toBe('1000');
    expect(v.rateDate).toBe('2026-10-19'); // для UZS — дата курса USD
    const e = book.toUsd('100', 'EUR', set);
    expect(e.usd!.toString()).toBe('111.46');
    expect(Number(e.rate)).toBeCloseTo(13470 / 12085, 7);
    expect(e.rateDate).toBe('2026-10-19');
  });

  it('исторический отчёт не меняется при появлении более позднего курса', () => {
    const before = new RatesBook([rec('u1', 'USD', '11850', '2026-08-20')]);
    const after = new RatesBook([rec('u1', 'USD', '11850', '2026-08-20'), rec('u2', 'USD', '13000', '2026-11-01')]);
    const a = before.toUsd('1000000', 'UZS', before.asOf('2026-09-30')).usd!.toString();
    const b = after.toUsd('1000000', 'UZS', after.asOf('2026-09-30')).usd!.toString();
    expect(a).toBe(b);
    expect(after.toUsd('1000000', 'UZS', after.asOf('2026-11-30')).usd!.toString()).not.toBe(a);
  });

  it('при равных датах побеждает курс, подтверждённый позже', () => {
    const b = new RatesBook([rec('a', 'USD', '11000', '2026-05-01', '2026-05-02T00:00:00Z'), rec('b', 'USD', '11100', '2026-05-01', '2026-05-03T00:00:00Z')]);
    expect(b.asOf('2026-05-10').uzsPerUnit.USD).toBe('11100');
  });

  it('missing перечисляет валюты без возможности пересчёта', () => {
    const b = new RatesBook([rec('u', 'USD', '12000', '2026-01-01'), rec('e', 'EUR', '13000', '2026-01-01')]);
    const set = b.asOf('2026-06-01');
    expect(b.missing(set, ['USD', 'UZS', 'EUR', 'RUB'])).toEqual(['RUB']);
    expect(b.missing(b.asOf('2025-01-01'), ['USD', 'UZS', 'EUR'])).toEqual(['UZS', 'EUR']);
  });

  it('UZS в записях игнорируется (базовая единица)', () => {
    const b = new RatesBook([rec('z', 'UZS', '1', '2026-01-01'), rec('u', 'USD', '12000', '2026-01-01')]);
    expect(b.asOf('2026-06-01').used.map((u) => u.currency)).toEqual(['USD']);
  });
});

describe('Эквивалент в UZS', () => {
  const book = new RatesBook([rec('u', 'USD', '12085', '2026-10-19'), rec('e', 'EUR', '13470.5', '2026-10-19')]);
  const set = book.asOf('2026-11-01');
  it('UZS не требует курсов; остальные — прямое умножение на UZS за единицу', () => {
    expect(book.toUzs('1000.50', 'UZS', book.asOf('2000-01-01')).uzs?.toFixed(2)).toBe('1000.50');
    expect(book.toUzs('2', 'USD', set).uzs?.toFixed(2)).toBe('24170.00');
    expect(book.toUzs('0.1', 'EUR', set).uzs?.toFixed(2)).toBe('1347.05');
  });
  it('нет курса — нет пересчёта и валюта попадает в список недостающих', () => {
    expect(book.toUzs('5', 'RUB', set).uzs).toBeNull();
    expect(book.missingUzs(set, ['UZS', 'USD', 'RUB', 'EUR'])).toEqual(['RUB']);
    expect(book.missingUzs(book.asOf('2000-01-01'), ['UZS'])).toEqual([]);
  });
});
