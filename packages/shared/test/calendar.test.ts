import { describe, expect, it } from 'vitest';
import { DEFAULT_WEEK_BOUNDS, daysInMonth, isWeekPast, validateBounds, weekOfDate, weekOfDay, weekRange } from '../src';

describe('Календарь: недели W1–W4 с настраиваемыми границами', () => {
  it('границы по умолчанию: 1–7, 8–14, 15–21, 22–конец месяца', () => {
    expect([1, 7, 8, 14, 15, 21, 22, 31].map((d) => weekOfDay(d))).toEqual([1, 1, 2, 2, 3, 3, 4, 4]);
    expect(weekRange(2026, 2, 4)).toEqual({ from: 22, to: 28 }); // февраль: W4 до конца месяца
    expect(weekRange(2024, 2, 4)).toEqual({ from: 22, to: 29 }); // високосный год
    expect(weekRange(2026, 7, 4)).toEqual({ from: 22, to: 31 });
  });

  it('недели покрывают месяц без пропусков и пересечений при любых допустимых границах', () => {
    for (const b of [DEFAULT_WEEK_BOUNDS, { w1End: 5, w2End: 12, w3End: 25 }, { w1End: 1, w2End: 2, w3End: 3 }, { w1End: 9, w2End: 18, w3End: 27 }]) {
      for (const [y, m] of [[2026, 2], [2024, 2], [2026, 6], [2026, 12]]) {
        const seen: number[] = [];
        for (const w of [1, 2, 3, 4] as const) { const { from, to } = weekRange(y, m, w, b); for (let d = from; d <= to; d++) seen.push(d); }
        expect(seen).toEqual(Array.from({ length: daysInMonth(y, m) }, (_, i) => i + 1));
        for (let d = 1; d <= daysInMonth(y, m); d++) { const w = weekOfDay(d, b); const r = weekRange(y, m, w, b); expect(d >= r.from && d <= r.to).toBe(true); }
      }
    }
  });

  it('другая настройка границ меняет отнесение даты к неделе', () => {
    expect(weekOfDate('2026-03-10')).toEqual({ year: 2026, month: 3, week: 2 });
    expect(weekOfDate('2026-03-10', { w1End: 10, w2End: 17, w3End: 24 })).toEqual({ year: 2026, month: 3, week: 1 });
  });

  it('валидация границ', () => {
    expect(validateBounds(DEFAULT_WEEK_BOUNDS)).toBeNull();
    expect(validateBounds({ w1End: 14, w2End: 7, w3End: 21 })).toMatch(/возрастать/);
    expect(validateBounds({ w1End: 7, w2End: 14, w3End: 28 })).toMatch(/27/);
    expect(validateBounds({ w1End: 0, w2End: 14, w3End: 21 })).toMatch(/возрастать/);
    expect(validateBounds({ w1End: 7.5, w2End: 14, w3End: 21 })).toMatch(/целыми/);
  });

  it('просроченная неделя определяется по её последнему дню', () => {
    expect(isWeekPast(2026, 3, 1, '2026-03-08')).toBe(true);
    expect(isWeekPast(2026, 3, 1, '2026-03-07')).toBe(false); // последний день недели ещё не прошёл
    expect(isWeekPast(2026, 3, 4, '2026-04-01')).toBe(true);
  });
});
