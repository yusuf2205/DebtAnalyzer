import { BadRequestException, Body, ConflictException, Controller, Delete, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { Prisma, type PlanEntry } from '@prisma/client';
import { z } from 'zod';
import {
  CURRENCIES, DEFAULT_WEEK_BOUNDS, dec, isWeekPast, money, validateBounds, weekOfDate, weekRange, type Dec, type Week, type WeekBounds,
} from '@pf/shared';
import { AuditService } from '../audit/audit.service';
import { ClientIp, CurrentUser, RequirePermission } from '../auth/decorators';
import type { AuthUser } from '../common/types';
import { contractDebt, netPaidMap } from '../common/metrics';
import { parse } from '../common/zod';
import { aggregate, buildCells, cellKey, fmtAgg, overdueByCell, type Cell } from './plan-fact';
import { PrismaService } from '../prisma/prisma.service';

const BOUNDS_KEY = 'weekBounds';
const money2 = z.string().regex(/^\d{1,20}(\.\d{1,2})?$/, 'Сумма: число не более чем с 2 знаками после запятой').refine((s) => Number(s) > 0, 'Сумма должна быть больше нуля');
const cell = { year: z.number().int().min(2000).max(2100), month: z.number().int().min(1).max(12), week: z.number().int().min(1).max(4) };
const todayIso = () => new Date().toISOString().slice(0, 10);

const filters = z.object({
  currency: z.enum(CURRENCIES).optional(), supplierId: z.string().uuid().optional(), contractId: z.string().uuid().optional(),
  executor: z.string().trim().max(100).optional(), q: z.string().trim().max(100).optional(),
});
const monthQuery = filters.extend({ year: z.coerce.number().int().min(2000).max(2100), month: z.coerce.number().int().min(1).max(12) });
const yearQuery = filters.extend({ year: z.coerce.number().int().min(2000).max(2100) });


@Controller('calendar')
export class CalendarController {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  // ---------- настройки границ недель ----------
  private async bounds(): Promise<WeekBounds> {
    const s = await this.prisma.appSetting.findUnique({ where: { key: BOUNDS_KEY } });
    const v = s?.value as unknown as WeekBounds | undefined;
    return v && !validateBounds(v) ? v : DEFAULT_WEEK_BOUNDS;
  }

  @Get('settings')
  @RequirePermission('plans.view')
  async settings() {
    const s = await this.prisma.appSetting.findUnique({ where: { key: BOUNDS_KEY } });
    return { bounds: await this.bounds(), isDefault: !s, note: 'W4 — от следующего дня после границы W3 до конца месяца. В исходном файле даты недель не заданы: границы задаёт организация.' };
  }

  @Put('settings')
  @RequirePermission('settings.manage')
  async saveSettings(@CurrentUser() u: AuthUser, @Body() body: unknown, @ClientIp() ip: string | null) {
    const b = parse(z.object({ w1End: z.number(), w2End: z.number(), w3End: z.number() }).strict(), body);
    const err = validateBounds(b);
    if (err) throw new BadRequestException(err);
    const before = await this.bounds();
    await this.prisma.appSetting.upsert({ where: { key: BOUNDS_KEY }, create: { key: BOUNDS_KEY, value: b, updatedById: u.id }, update: { value: b, updatedById: u.id } });
    await this.audit.log({ userId: u.id, userEmail: u.email, action: 'calendar.settings', entity: 'AppSetting', entityId: BOUNDS_KEY, before, after: b, meta: { note: 'Изменение границ меняет отнесение фактических платежей к неделям в отчётах «план/факт»' }, ip });
    return { bounds: b, isDefault: false };
  }

  // ---------- выборки ----------
  private contractWhere(q: z.infer<typeof filters>): Prisma.ContractWhereInput {
    return {
      status: 'ACTIVE', currency: q.currency, supplierId: q.supplierId, id: q.contractId,
      ...(q.executor ? { executor: { contains: q.executor, mode: 'insensitive' } } : {}),
      ...(q.q ? { OR: [{ number: { contains: q.q, mode: 'insensitive' } }, { project: { contains: q.q, mode: 'insensitive' } }, { supplier: { name: { contains: q.q, mode: 'insensitive' } } }] } : {}),
    };
  }

  /** План и факт по ячейкам (договор × месяц × неделя). Факт — чистая сумма ПОДТВЕРЖДЁННЫХ платежей приложения по дате платежа. */
  private async cells(from: string, to: string, planWhere: Prisma.PlanEntryWhereInput, cw: Prisma.ContractWhereInput, b: WeekBounds) {
    const [plans, payments] = await Promise.all([
      this.prisma.planEntry.findMany({ where: { ...planWhere, contract: cw }, include: { contract: { select: { id: true } } } }),
      this.prisma.payment.findMany({ where: { status: 'APPROVED', paymentDate: { gte: new Date(from), lte: new Date(to) }, contract: cw }, select: { contractId: true, paymentDate: true, signedAmount: true, currency: true } }),
    ]);
    const map = buildCells(plans, payments, b);
    return { map, plans };
  }

  /** Остаток плана = невыполненная часть (план − факт, если > 0); «сверх плана» — отдельно. Считается по договору и неделе, а не по итогу. */
  private agg(items: Iterable<Cell>) { return fmtAgg(aggregate(items)); }

  @Get('month')
  @RequirePermission('plans.view')
  async month(@Query() raw: Record<string, string>) {
    const q = parse(monthQuery, raw);
    const b = await this.bounds();
    const last = new Date(Date.UTC(q.year, q.month, 0)).getUTCDate();
    const from = `${q.year}-${String(q.month).padStart(2, '0')}-01`, to = `${q.year}-${String(q.month).padStart(2, '0')}-${last}`;
    const { map } = await this.cells(from, to, { year: q.year, month: q.month }, this.contractWhere(q), b);
    const today = todayIso();
    const weeks = ([1, 2, 3, 4] as Week[]).map((w) => ({ week: w, ...weekRange(q.year, q.month, w, b), past: isWeekPast(q.year, q.month, w, today, b) }));

    const ids = [...new Set([...map.values()].map((c) => c.contractId))];
    const contracts = await this.prisma.contract.findMany({ where: { id: { in: ids } }, include: { supplier: { select: { id: true, name: true } } } });
    const net = await netPaidMap(this.prisma, ids);
    const planRows = await this.prisma.planEntry.findMany({ where: { contractId: { in: ids }, year: q.year, month: q.month } });
    const planByKey = new Map(planRows.map((p) => [`${p.contractId}|${p.week}`, p]));
    const allPlanSum = await this.prisma.planEntry.groupBy({ by: ['contractId'], where: { contractId: { in: ids } }, _sum: { amount: true } });
    const planSum = new Map(allPlanSum.map((r) => [r.contractId, dec(r._sum.amount?.toString() ?? 0)]));

    const debtOf = new Map(contracts.map((c) => [c.id, contractDebt({ ...c, newPaid: net.get(c.id) }).debt]));
    const overdue = overdueByCell(map.values(), debtOf, today, b);
    const rows = contracts.map((c) => {
      const d = contractDebt({ ...c, newPaid: net.get(c.id) });
      const cellsOf = weeks.map((w) => {
        const a = map.get(cellKey(c.id, q.year, q.month, w.week));
        const p = planByKey.get(`${c.id}|${w.week}`);
        const plan = a?.plan ?? dec(0), fact = a?.fact ?? dec(0), diff = plan.minus(fact);
        return {
          week: w.week, planId: p?.id ?? null, planned: p ? money(plan).toFixed(2) : null, source: p?.source ?? null, note: p?.note ?? null, actual: money(fact).toFixed(2),
          remaining: diff.gt(0) ? money(diff).toFixed(2) : '0.00', over: diff.lt(0) ? money(diff.neg()).toFixed(2) : '0.00', overdue: money(overdue.get(cellKey(c.id, q.year, q.month, w.week)) ?? dec(0)).toFixed(2),
        };
      });
      return {
        contract: { id: c.id, number: c.number, project: c.project }, supplier: c.supplier, currency: c.currency, debt: d.debt.toFixed(2), state: d.state,
        // План всего по договору больше долга — вероятно, это история платежей, а не будущий план (информативно).
        planExceedsDebt: (planSum.get(c.id) ?? dec(0)).gt(d.debt),
        cells: cellsOf, plannedTotal: money(cellsOf.reduce((a, x) => a.plus(x.planned ?? 0), dec(0))).toFixed(2), actualTotal: money(cellsOf.reduce((a, x) => a.plus(x.actual), dec(0))).toFixed(2),
      };
    }).sort((a, b2) => a.supplier.name.localeCompare(b2.supplier.name, 'ru') || (a.contract.number ?? '').localeCompare(b2.contract.number ?? '', 'ru'));

    // Итоги строго по валютам и неделям.
    const totals = CURRENCIES.map((cur) => {
      const mine = [...map.values()].filter((c) => c.currency === cur);
      if (!mine.length) return null;
      const byWeek = weeks.map((w) => {
        const inWeek = mine.filter((c) => c.week === w.week), a = this.agg(inWeek);
        const od = inWeek.reduce((x, c) => x.plus(overdue.get(cellKey(c.contractId, c.year, c.month, c.week)) ?? 0), dec(0));
        return { week: w.week, ...a, overdue: money(od).toFixed(2) };
      });
      const odTotal = byWeek.reduce((x, w) => x.plus(w.overdue), dec(0));
      return { currency: cur, weeks: byWeek, total: { ...this.agg(mine), overdue: money(odTotal).toFixed(2) } };
    }).filter(Boolean);

    return {
      year: q.year, month: q.month, bounds: b, weeks, today, totals, rows,
      note: 'Факт — только подтверждённые платежи приложения с датой. Историческая оплата из импортированного файла (без дат) в факт не входит. План на задолженность не влияет.',
    };
  }

  @Get('year')
  @RequirePermission('plans.view')
  async year(@Query() raw: Record<string, string>) {
    const q = parse(yearQuery, raw);
    const b = await this.bounds();
    const { map } = await this.cells(`${q.year}-01-01`, `${q.year}-12-31`, { year: q.year }, this.contractWhere(q), b);
    const today = todayIso();
    const ids = [...new Set([...map.values()].map((c) => c.contractId))];
    const contracts = await this.prisma.contract.findMany({ where: { id: { in: ids } } });
    const net = await netPaidMap(this.prisma, ids);
    const debtOf = new Map(contracts.map((c) => [c.id, contractDebt({ ...c, newPaid: net.get(c.id) }).debt]));
    const overdue = overdueByCell(map.values(), debtOf, today, b);
    const months = Array.from({ length: 12 }, (_, i) => i + 1).map((m) => ({
      month: m,
      currencies: CURRENCIES.map((cur) => {
        const mine = [...map.values()].filter((c) => c.month === m && c.currency === cur);
        if (!mine.length) return null;
        const a = this.agg(mine);
        const od = mine.reduce((x, c) => x.plus(overdue.get(cellKey(c.contractId, c.year, c.month, c.week)) ?? 0), dec(0));
        return { currency: cur, ...a, overdue: money(od).toFixed(2) };
      }).filter(Boolean),
    }));
    const totals = CURRENCIES.map((cur) => {
      const mine = [...map.values()].filter((c) => c.currency === cur);
      const od = mine.reduce((x, c) => x.plus(overdue.get(cellKey(c.contractId, c.year, c.month, c.week)) ?? 0), dec(0));
      return mine.length ? { currency: cur, ...this.agg(mine), overdue: money(od).toFixed(2) } : null;
    }).filter(Boolean);
    return { year: q.year, bounds: b, months, totals };
  }

  /** Договоры с долгом, по которым нет плана на текущую и будущие недели. */
  @Get('unplanned')
  @RequirePermission('plans.view')
  async unplanned(@Query() raw: Record<string, string>) {
    const q = parse(filters, raw);
    const b = await this.bounds();
    const today = todayIso();
    const contracts = await this.prisma.contract.findMany({ where: this.contractWhere(q), include: { supplier: { select: { id: true, name: true } }, plans: true } });
    const net = await netPaidMap(this.prisma, contracts.map((c) => c.id));
    const rows = contracts.map((c) => ({ c, d: contractDebt({ ...c, newPaid: net.get(c.id) }) }))
      .filter(({ c, d }) => d.debt.gt(0) && !c.plans.some((p) => p.amount.gt(0) && !isWeekPast(p.year, p.month, p.week as Week, today, b)));
    const totals = CURRENCIES.map((cur) => { const m = rows.filter((r) => r.c.currency === cur); return m.length ? { currency: cur, contracts: m.length, debt: money(m.reduce((s, r) => s.plus(r.d.debt), dec(0))).toFixed(2) } : null; }).filter(Boolean);
    return {
      totals,
      items: rows.sort((x, y) => x.c.currency.localeCompare(y.c.currency) || y.d.debt.comparedTo(x.d.debt)).slice(0, 200)
        .map(({ c, d }) => ({ contractId: c.id, number: c.number, supplier: c.supplier, currency: c.currency, debt: d.debt.toFixed(2) })),
    };
  }

  // ---------- операции с планом ----------
  private async contract(id: string) {
    const c = await this.prisma.contract.findUnique({ where: { id } });
    if (!c) throw new BadRequestException('Договор не найден');
    if (c.status !== 'ACTIVE') throw new BadRequestException('Договор в архиве — планировать платежи нельзя');
    return c;
  }
  private async plan(id: string) {
    const p = await this.prisma.planEntry.findUnique({ where: { id }, include: { contract: true } });
    if (!p) throw new NotFoundException('Плановая запись не найдена');
    if (p.contract.status !== 'ACTIVE') throw new BadRequestException('Договор в архиве');
    return p;
  }
  private snap = (p: PlanEntry) => ({ id: p.id, contractId: p.contractId, year: p.year, month: p.month, week: p.week, amount: p.amount.toFixed(2), source: p.source, note: p.note });

  @Post('plans')
  @RequirePermission('plans.manage')
  async create(@CurrentUser() u: AuthUser, @Body() body: unknown, @ClientIp() ip: string | null) {
    const d = parse(z.object({ contractId: z.string().uuid(), ...cell, amount: money2, note: z.string().trim().max(500).optional() }), body);
    const c = await this.contract(d.contractId);
    const exists = await this.prisma.planEntry.findUnique({ where: { contractId_year_month_week: { contractId: c.id, year: d.year, month: d.month, week: d.week } } });
    if (exists) throw new ConflictException({ message: 'На эту неделю по договору план уже есть — измените его', code: 'PLAN_EXISTS', planId: exists.id });
    const p = await this.prisma.planEntry.create({ data: { contractId: c.id, year: d.year, month: d.month, week: d.week, amount: d.amount, currency: c.currency, source: 'MANUAL', note: d.note || null } });
    await this.audit.log({ userId: u.id, userEmail: u.email, action: 'plan.create', entity: 'PlanEntry', entityId: p.id, after: this.snap(p), meta: { contractId: c.id }, ip });
    return this.snap(p);
  }

  /** Правка суммы/комментария. Импортированная запись становится ручной — повторный импорт её не перезапишет. */
  @Patch('plans/:id')
  @RequirePermission('plans.manage')
  async update(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @ClientIp() ip: string | null) {
    const d = parse(z.object({ amount: money2.optional(), note: z.string().trim().max(500).nullable().optional() }).strict(), body);
    const before = await this.plan(id);
    const after = await this.prisma.planEntry.update({ where: { id }, data: { ...(d.amount ? { amount: d.amount } : {}), ...('note' in d ? { note: d.note || null } : {}), source: 'MANUAL' } });
    await this.audit.log({ userId: u.id, userEmail: u.email, action: 'plan.update', entity: 'PlanEntry', entityId: id, before: this.snap(before), after: this.snap(after), meta: { contractId: before.contractId }, ip });
    return this.snap(after);
  }

  @Delete('plans/:id')
  @RequirePermission('plans.manage')
  async remove(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip: string | null) {
    const before = await this.plan(id);
    await this.prisma.planEntry.delete({ where: { id } });
    await this.audit.log({ userId: u.id, userEmail: u.email, action: 'plan.delete', entity: 'PlanEntry', entityId: id, before: this.snap(before), meta: { contractId: before.contractId }, ip });
    return { ok: true };
  }

  /** Перенос всей суммы на другую неделю. Если там уже есть план по этому договору, суммы складываются. */
  @Post('plans/:id/move')
  @RequirePermission('plans.manage')
  async move(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @ClientIp() ip: string | null) {
    const t = parse(z.object({ ...cell }), body);
    const src = await this.plan(id);
    if (src.year === t.year && src.month === t.month && src.week === t.week) throw new BadRequestException('Выберите другую неделю');
    const res = await this.prisma.$transaction(async (tx) => {
      const target = await tx.planEntry.findUnique({ where: { contractId_year_month_week: { contractId: src.contractId, year: t.year, month: t.month, week: t.week } } });
      let after: PlanEntry;
      if (target) {
        after = await tx.planEntry.update({ where: { id: target.id }, data: { amount: dec(target.amount.toString()).plus(src.amount.toString()).toFixed(2), source: 'MANUAL' } });
        await tx.planEntry.delete({ where: { id: src.id } });
      } else after = await tx.planEntry.update({ where: { id: src.id }, data: { year: t.year, month: t.month, week: t.week, source: 'MANUAL' } });
      await this.audit.log({ userId: u.id, userEmail: u.email, action: 'plan.move', entity: 'PlanEntry', entityId: after.id, before: this.snap(src), after: this.snap(after), meta: { contractId: src.contractId, merged: !!target }, ip }, tx);
      return after;
    });
    return this.snap(res);
  }

  /** Разделение суммы между неделями: сумма частей строго равна исходной. */
  @Post('plans/:id/split')
  @RequirePermission('plans.manage')
  async split(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @ClientIp() ip: string | null) {
    const { parts } = parse(z.object({ parts: z.array(z.object({ ...cell, amount: money2 })).min(2).max(12) }), body);
    const src = await this.plan(id);
    const keys = parts.map((p) => `${p.year}-${p.month}-${p.week}`);
    if (new Set(keys).size !== keys.length) throw new BadRequestException('Недели в частях не должны повторяться');
    const total = parts.reduce((a, p) => a.plus(p.amount), dec(0));
    if (!total.eq(src.amount.toString())) throw new BadRequestException(`Сумма частей (${money(total).toFixed(2)}) должна равняться исходной сумме (${src.amount.toFixed(2)})`);
    const out = await this.prisma.$transaction(async (tx) => {
      const result: PlanEntry[] = [];
      let keptOriginal = false;
      for (const p of parts) {
        const same = p.year === src.year && p.month === src.month && p.week === src.week;
        if (same) { result.push(await tx.planEntry.update({ where: { id: src.id }, data: { amount: p.amount, source: 'MANUAL' } })); keptOriginal = true; continue; }
        const existing = await tx.planEntry.findUnique({ where: { contractId_year_month_week: { contractId: src.contractId, year: p.year, month: p.month, week: p.week } } });
        result.push(existing
          ? await tx.planEntry.update({ where: { id: existing.id }, data: { amount: dec(existing.amount.toString()).plus(p.amount).toFixed(2), source: 'MANUAL' } })
          : await tx.planEntry.create({ data: { contractId: src.contractId, year: p.year, month: p.month, week: p.week, amount: p.amount, currency: src.currency, source: 'MANUAL', note: src.note } }));
      }
      if (!keptOriginal) await tx.planEntry.delete({ where: { id: src.id } });
      await this.audit.log({ userId: u.id, userEmail: u.email, action: 'plan.split', entity: 'PlanEntry', entityId: src.id, before: this.snap(src), after: result.map((r) => this.snap(r)), meta: { contractId: src.contractId }, ip }, tx);
      return result;
    });
    return out.map((r) => this.snap(r));
  }
}
