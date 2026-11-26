/**
 * Недели платёжного календаря W1–W4. В исходном файле у недель нет дат, поэтому границы — настройка:
 * w1End / w2End / w3End — последний день месяца, входящий в W1 / W2 / W3. W4 — от следующего дня до конца месяца.
 * По умолчанию 7/14/21 (условно: 1–7, 8–14, 15–21, 22–конец месяца); организация вправе задать свои.
 */
export interface WeekBounds { w1End: number; w2End: number; w3End: number }
export type Week = 1 | 2 | 3 | 4;

export const DEFAULT_WEEK_BOUNDS: WeekBounds = { w1End: 7, w2End: 14, w3End: 21 };

/** null — границы корректны, иначе текст ошибки. */
export function validateBounds(b: WeekBounds): string | null {
  const v = [b.w1End, b.w2End, b.w3End];
  if (!v.every((n) => Number.isInteger(n))) return 'Границы недель должны быть целыми числами';
  if (!(b.w1End >= 1 && b.w1End < b.w2End && b.w2End < b.w3End && b.w3End <= 27)) return 'Границы должны возрастать: 1 ≤ W1 < W2 < W3 ≤ 27 (последняя неделя — до конца месяца)';
  return null;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function weekOfDay(day: number, b: WeekBounds = DEFAULT_WEEK_BOUNDS): Week {
  return day <= b.w1End ? 1 : day <= b.w2End ? 2 : day <= b.w3End ? 3 : 4;
}

/** Дни месяца, входящие в неделю (включительно). */
export function weekRange(year: number, month: number, week: Week, b: WeekBounds = DEFAULT_WEEK_BOUNDS): { from: number; to: number } {
  const last = daysInMonth(year, month);
  if (week === 1) return { from: 1, to: b.w1End };
  if (week === 2) return { from: b.w1End + 1, to: b.w2End };
  if (week === 3) return { from: b.w2End + 1, to: b.w3End };
  return { from: b.w3End + 1, to: last };
}

export function weekOfDate(iso: string, b: WeekBounds = DEFAULT_WEEK_BOUNDS): { year: number; month: number; week: Week } {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) throw new Error(`Некорректная дата: ${iso}`);
  return { year: Number(m[1]), month: Number(m[2]), week: weekOfDay(Number(m[3]), b) };
}

/** Неделя полностью в прошлом относительно today (ISO yyyy-mm-dd). Для просроченных плановых платежей. */
export function isWeekPast(year: number, month: number, week: Week, today: string, b: WeekBounds = DEFAULT_WEEK_BOUNDS): boolean {
  const { to } = weekRange(year, month, week, b);
  return `${year}-${String(month).padStart(2, '0')}-${String(to).padStart(2, '0')}` < today;
}
