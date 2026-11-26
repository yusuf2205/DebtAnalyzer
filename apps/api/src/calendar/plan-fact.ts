import { dec, isWeekPast, money, weekOfDate, weekRange, type Dec, type Week, type WeekBounds } from '@pf/shared';

/** Ячейка «план/факт»: договор × год × месяц × неделя. Единый расчёт для календаря, дашборда и отчётов. */
export interface Cell { contractId: string; year: number; month: number; week: Week; currency: string; plan: Dec; fact: Dec }
export const cellKey = (contractId: string, year: number, month: number, week: number) => `${contractId}|${year}|${month}|${week}`;

export interface PlanLike { contractId: string; year: number; month: number; week: number; currency: string; amount: { toString(): string } }
export interface PaymentLike { contractId: string; paymentDate: Date; currency: string; signedAmount: { toString(): string } | null }

/** Факт — чистая сумма ПОДТВЕРЖДЁННЫХ платежей (оплаты − возвраты − сторно) по дате платежа; неделя — по настраиваемым границам. */
export function buildCells(plans: PlanLike[], payments: PaymentLike[], b: WeekBounds): Map<string, Cell> {
  const map = new Map<string, Cell>();
  const get = (contractId: string, year: number, month: number, week: Week, currency: string) => {
    const k = cellKey(contractId, year, month, week);
    let c = map.get(k);
    if (!c) { c = { contractId, year, month, week, currency, plan: dec(0), fact: dec(0) }; map.set(k, c); }
    return c;
  };
  for (const p of plans) get(p.contractId, p.year, p.month, p.week as Week, p.currency).plan = dec(p.amount.toString());
  for (const p of payments) {
    const w = weekOfDate(p.paymentDate.toISOString().slice(0, 10), b);
    const c = get(p.contractId, w.year, w.month, w.week, p.currency);
    c.fact = c.fact.plus(p.signedAmount?.toString() ?? 0);
  }
  return map;
}

/** Остаток плана = невыполненная часть (план − факт, если > 0); «сверх плана» — отдельно. Считается по ячейкам, а не по итогу. */
export function aggregate(cells: Iterable<Cell>) {
  let plan = dec(0), fact = dec(0), remaining = dec(0), over = dec(0);
  for (const c of cells) {
    plan = plan.plus(c.plan); fact = fact.plus(c.fact);
    const d = c.plan.minus(c.fact);
    if (d.gt(0)) remaining = remaining.plus(d); else over = over.minus(d);
  }
  return { plan, fact, remaining, over };
}
export const fmtAgg = (a: ReturnType<typeof aggregate>) => ({
  planned: money(a.plan).toFixed(2), actual: money(a.fact).toFixed(2), remaining: money(a.remaining).toFixed(2), over: money(a.over).toFixed(2),
});

/**
 * Просрочено = невыполненный план ПРОШЕДШИХ недель, но не больше текущего долга по договору (хронологически, нарастающим итогом).
 * Если долга нет (договор оплачен, плановая сумма — история из таблицы), просрочки нет.
 */
export function overdueByCell(cells: Iterable<Cell>, debt: Map<string, Dec>, today: string, b: WeekBounds): Map<string, Dec> {
  const out = new Map<string, Dec>();
  const byContract = new Map<string, Cell[]>();
  for (const c of cells) byContract.set(c.contractId, [...(byContract.get(c.contractId) ?? []), c]);
  for (const [id, list] of byContract) {
    let allowance = debt.get(id) ?? dec(0);
    for (const c of list.sort((x, y) => x.year - y.year || x.month - y.month || x.week - y.week)) {
      const raw = c.plan.minus(c.fact);
      if (!isWeekPast(c.year, c.month, c.week, today, b) || raw.lte(0) || allowance.lte(0)) continue;
      const take = raw.lt(allowance) ? raw : allowance;
      out.set(cellKey(c.contractId, c.year, c.month, c.week), take);
      allowance = allowance.minus(take);
    }
  }
  return out;
}

/** Первый день недели (ISO) — для сортировки «предстоящих» платежей. */
export function weekStartIso(year: number, month: number, week: Week, b: WeekBounds): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(weekRange(year, month, week, b).from).padStart(2, '0')}`;
}
export function weekEndIso(year: number, month: number, week: Week, b: WeekBounds): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(weekRange(year, month, week, b).to).padStart(2, '0')}`;
}
