import { effectiveOrigin } from '@pf/shared';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { CURRENCIES, DEFAULT_WEEK_BOUNDS, dec, money, RatesBook, validateBounds, type CurrencyCode, type Dec, type WeekBounds } from '@pf/shared';
import { contractDebt, netPaidMap } from '../common/metrics';
import { PrismaService } from '../prisma/prisma.service';

export const todayIso = () => new Date().toISOString().slice(0, 10);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => !Number.isNaN(Date.parse(s)), 'Некорректная дата');

/** Общие фильтры портфеля договоров (дашборд и отчёты). */
export const portfolioFilters = z.object({
  currency: z.enum(CURRENCIES).optional(),
  origin: z.enum(['LOCAL', 'FOREIGN', 'UNSET']).optional(), // местный / зарубежный (по действующему значению)
  supplierId: z.string().uuid().optional(),
  project: z.string().trim().max(100).optional(),
  executor: z.string().trim().max(100).optional(),
  status: z.enum(['ACTIVE', 'ARCHIVED', 'ALL']).default('ACTIVE'),
});
export type PortfolioFilters = z.infer<typeof portfolioFilters>;
export const periodFilters = z.object({ from: isoDate.optional(), to: isoDate.optional() });

export interface Fact {
  id: string; number: string | null; project: string | null; executor: string | null; supplier: { id: string; name: string };
  currency: CurrencyCode; amount: Dec; paid: Dec; debt: Dec; overpaid: Dec; planned: Dec; status: string;
}

@Injectable()
export class AnalyticsService {
  constructor(private prisma: PrismaService) {}

  /** Данные для «цветка»: даты подтверждённых оплат (без возвратов и отменённых сторно) и запуск системы (самый ранний договор). */
  async plantInputs(): Promise<{ start: string | null; paymentDates: string[] }> {
    const [first, reversals, pays] = await Promise.all([
      this.prisma.contract.findFirst({ orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
      this.prisma.payment.findMany({ where: { status: 'APPROVED', kind: 'REVERSAL', reversesPaymentId: { not: null } }, select: { reversesPaymentId: true } }),
      this.prisma.payment.findMany({ where: { status: 'APPROVED', kind: 'PAYMENT' }, select: { id: true, paymentDate: true } }),
    ]);
    const reversed = new Set(reversals.map((r) => r.reversesPaymentId));
    const dates = pays.filter((p) => !reversed.has(p.id)).map((p) => p.paymentDate.toISOString().slice(0, 10));
    const startCandidates = [first?.createdAt.toISOString().slice(0, 10), ...dates].filter(Boolean) as string[];
    return { start: startCandidates.length ? startCandidates.sort()[0]! : null, paymentDates: dates };
  }

  /** Только ПОДТВЕРЖДЁННЫЕ курсы с датой действия. Выбор курса на дату — RatesBook. */
  async book(): Promise<RatesBook> {
    const rows = await this.prisma.fxRate.findMany({ where: { status: 'CONFIRMED', effectiveDate: { not: null } } });
    return new RatesBook(rows.map((r) => ({ id: r.id, currency: r.currency, uzsPerUnit: r.uzsPerUnit.toString(), effectiveDate: r.effectiveDate!.toISOString().slice(0, 10), source: r.source, confirmedAt: r.confirmedAt?.toISOString() ?? null })));
  }

  async weekBounds(): Promise<WeekBounds> {
    const s = await this.prisma.appSetting.findUnique({ where: { key: 'weekBounds' } });
    const v = s?.value as unknown as WeekBounds | undefined;
    return v && !validateBounds(v) ? v : DEFAULT_WEEK_BOUNDS;
  }

  where(f: PortfolioFilters): Prisma.ContractWhereInput {
    return {
      ...(f.status !== 'ALL' ? { status: f.status } : {}), currency: f.currency, supplierId: f.supplierId,
    };
  }

  /** Текстовые фильтры — в приложении, а не в БД: регистронезависимый поиск по кириллице не должен зависеть от локали PostgreSQL. */
  private textMatch<T extends { project: string | null; executor: string | null; origin?: 'LOCAL' | 'FOREIGN' | null; currency?: string; supplier?: { name: string; taxId?: string | null } }>(f: PortfolioFilters, c: T) {
    const lc = (x?: string | null) => (x ?? '').toLocaleLowerCase('ru');
    const originOk = !f.origin || (() => { const v = effectiveOrigin({ origin: c.origin ?? null, currency: c.currency ?? '', supplierName: c.supplier?.name, supplierTaxId: c.supplier?.taxId }).value; return f.origin === 'UNSET' ? v === null : v === f.origin; })();
    return originOk && (!f.project || lc(c.project).includes(lc(f.project))) && (!f.executor || lc(c.executor).includes(lc(f.executor)));
  }

  /** Идентификаторы договоров, подходящих под все фильтры. */
  async contractIds(f: PortfolioFilters): Promise<string[]> {
    const rows = await this.prisma.contract.findMany({ where: this.where(f), select: { id: true, project: true, executor: true, origin: true, currency: true, supplier: { select: { name: true, taxId: true } } } });
    return rows.filter((c) => this.textMatch(f, c)).map((c) => c.id);
  }

  /** Договоры с рассчитанными суммами: оплачено = начальный остаток + подтверждённые платежи; долг ≥ 0; переплата отдельно. */
  async portfolio(f: PortfolioFilters): Promise<Fact[]> {
    const contracts = (await this.prisma.contract.findMany({ where: this.where(f), include: { supplier: { select: { id: true, name: true, taxId: true } } } })).filter((c) => this.textMatch(f, c));
    const ids = contracts.map((c) => c.id);
    const [net, plans] = await Promise.all([
      netPaidMap(this.prisma, ids),
      this.prisma.planEntry.groupBy({ by: ['contractId'], where: { contractId: { in: ids } }, _sum: { amount: true } }),
    ]);
    const planned = new Map(plans.map((p) => [p.contractId, dec(p._sum.amount?.toString() ?? 0)]));
    return contracts.map((c) => {
      const d = contractDebt({ ...c, newPaid: net.get(c.id) });
      return { id: c.id, number: c.number, project: c.project, executor: c.executor, supplier: c.supplier, currency: c.currency, amount: d.contractAmount, paid: d.totalPaid, debt: d.debt, overpaid: d.overpaid, planned: planned.get(c.id) ?? dec(0), status: c.status };
    });
  }

  snapshotsSince(date: string) { return this.prisma.debtSnapshot.findMany({ where: { date: { gte: new Date(date) } }, orderBy: { date: 'asc' } }); }

  /** План и подтверждённые платежи по договорам — вход для buildCells. */
  async planAndPayments(contractIds: string[]) {
    const [plans, payments] = await Promise.all([
      this.prisma.planEntry.findMany({ where: { contractId: { in: contractIds } }, select: { contractId: true, year: true, month: true, week: true, currency: true, amount: true } }),
      this.prisma.payment.findMany({ where: { contractId: { in: contractIds }, status: 'APPROVED' }, select: { contractId: true, paymentDate: true, currency: true, signedAmount: true } }),
    ]);
    return { plans, payments };
  }

  /**
   * Ежедневный снимок портфеля (только активные договоры, без фильтров). Идемпотентен: один снимок на дату и валюту,
   * существующий не перезаписывается — эквивалент в USD по курсам на дату снимка остаётся неизменным.
   */
  async captureSnapshot(date = todayIso()): Promise<{ created: number }> {
    const day = new Date(date);
    if (await this.prisma.debtSnapshot.count({ where: { date: day } })) return { created: 0 };
    const facts = await this.portfolio({ status: 'ACTIVE' });
    const book = await this.book(), set = book.asOf(date);
    let created = 0;
    for (const cur of CURRENCIES) {
      const mine = facts.filter((f) => f.currency === cur);
      if (!mine.length) continue;
      const sum = (k: 'amount' | 'paid' | 'debt' | 'overpaid' | 'planned') => mine.reduce((a, f) => a.plus(f[k]), dec(0));
      const debt = sum('debt'), u = book.toUsd(debt, cur, set);
      try {
        await this.prisma.debtSnapshot.create({
          data: { date: day, currency: cur, contracts: mine.length, amount: money(sum('amount')).toFixed(2), paid: money(sum('paid')).toFixed(2), debt: money(debt).toFixed(2), overpaid: money(sum('overpaid')).toFixed(2), planned: money(sum('planned')).toFixed(2), debtUsd: u.usd ? u.usd.toFixed(2) : null, rateUsed: u.rate },
        });
        created++;
      } catch (e) { if ((e as { code?: string }).code !== 'P2002') throw e; } // параллельный запрос уже создал
    }
    return { created };
  }
}
