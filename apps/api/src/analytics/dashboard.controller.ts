import { Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import { CURRENCIES, dec, isWeekPast, money, plantState, type CurrencyCode, type Dec, type Week } from '@pf/shared';
import { RequirePermission } from '../auth/decorators';
import { parse } from '../common/zod';
import { buildCells, overdueByCell, weekEndIso, weekStartIso, type Cell } from '../calendar/plan-fact';
import { AnalyticsService, periodFilters, portfolioFilters, todayIso } from './analytics.service';

const query = portfolioFilters.merge(periodFilters).extend({ horizon: z.coerce.number().int().min(1).max(365).default(30) });
const addDays = (iso: string, n: number) => new Date(new Date(iso).getTime() + n * 86400_000).toISOString().slice(0, 10);
const monthIdx = (y: number, m: number) => y * 12 + (m - 1);

@Controller('dashboard')
export class DashboardController {
  constructor(private analytics: AnalyticsService) {}

  @Get()
  @RequirePermission('dashboard.view')
  async get(@Query() raw: Record<string, string>) {
    const q = parse(query, raw);
    const today = todayIso();
    const [book, bounds] = await Promise.all([this.analytics.book(), this.analytics.weekBounds()]);
    const set = book.asOf(today);
    await this.analytics.captureSnapshot(today); // ежедневный снимок для графика динамики (идемпотентно)
    const facts = await this.analytics.portfolio(q);
    const currencies = CURRENCIES.filter((c) => facts.some((f) => f.currency === c));
    const missing = book.missing(set, currencies);
    const usd = (amount: Dec | string, cur: CurrencyCode) => book.toUsd(amount, cur, set).usd;
    const fmt = (d: Dec | null) => (d ? money(d).toFixed(2) : null);
    /** Сумма эквивалентов только по тем валютам, для которых есть курс (пересчитывается итог по валюте, а не каждая строка). */
    const usdSum = (byCur: { currency: CurrencyCode; v: Dec }[]) => {
      const parts = byCur.map((x) => usd(x.v, x.currency)).filter(Boolean) as Dec[];
      return parts.length ? money(parts.reduce((a, b) => a.plus(b), dec(0))).toFixed(2) : null;
    };

    // Эквивалент в UZS: основная валюта отображения (курсы заданы как UZS за 1 единицу — пересчёт прямой, без промежуточных округлений).
    const missingUzs = book.missingUzs(set, currencies);
    const uzs = (amount: Dec | string, cur: CurrencyCode) => book.toUzs(amount, cur, set).uzs;
    const uzsSum = (byCur: { currency: CurrencyCode; v: Dec }[]) => {
      const parts = byCur.map((x) => uzs(x.v, x.currency)).filter(Boolean) as Dec[];
      return parts.length ? money(parts.reduce((a, b) => a.plus(b), dec(0))).toFixed(2) : null;
    };

    // ---- KPI по валютам ----
    const sumBy = (cur: CurrencyCode, k: 'amount' | 'paid' | 'debt' | 'overpaid' | 'planned') => facts.filter((f) => f.currency === cur).reduce((a, f) => a.plus(f[k]), dec(0));
    const kpiRows = currencies.map((cur) => {
      const row: Record<string, Dec> = { amount: sumBy(cur, 'amount'), paid: sumBy(cur, 'paid'), debt: sumBy(cur, 'debt'), overpaid: sumBy(cur, 'overpaid'), planned: sumBy(cur, 'planned') };
      const u = book.toUsd(row.debt, cur, set);
      return {
        currency: cur, contracts: facts.filter((f) => f.currency === cur).length,
        ...Object.fromEntries(Object.entries(row).map(([k, v]) => [k, money(v).toFixed(2)])),
        usd: u.usd ? Object.fromEntries(Object.entries(row).map(([k, v]) => [k, fmt(usd(v, cur))])) : null, rate: u.rate, rateDate: u.rateDate,
        uzs: missingUzs.includes(cur) ? null : Object.fromEntries(Object.entries(row).map(([k, v]) => [k, fmt(uzs(v, cur))])),
      };
    });
    const totalUsd = (k: 'amount' | 'paid' | 'debt' | 'overpaid' | 'planned') => usdSum(currencies.map((cur) => ({ currency: cur, v: sumBy(cur, k) })));
    const kpi = {
      contracts: facts.length, suppliers: new Set(facts.map((f) => f.supplier.id)).size, byCurrency: kpiRows,
      totalUsd: { amount: totalUsd('amount'), paid: totalUsd('paid'), debt: totalUsd('debt'), overpaid: totalUsd('overpaid'), planned: totalUsd('planned') },
      totalUzs: Object.fromEntries((['amount', 'paid', 'debt', 'overpaid', 'planned'] as const).map((k) => [k, uzsSum(currencies.map((cur) => ({ currency: cur, v: sumBy(cur, k) })))])),
    };

    // ---- план/факт: просрочено, предстоящие, помесячный ряд ----
    const ids = facts.map((f) => f.id);
    const { plans, payments } = await this.analytics.planAndPayments(ids);
    const cells = buildCells(plans, payments, bounds);
    const factById = new Map(facts.map((f) => [f.id, f]));
    const debtMap = new Map(facts.map((f) => [f.id, f.debt]));
    const overdue = overdueByCell(cells.values(), debtMap, today, bounds);

    const overdueByContract = new Map<string, Dec>();
    for (const [k, v] of overdue) { const id = k.split('|')[0]; overdueByContract.set(id, (overdueByContract.get(id) ?? dec(0)).plus(v)); }
    const overdueItems = [...overdueByContract].map(([id, v]) => ({ f: factById.get(id)!, v }));
    const overdueBlock = {
      byCurrency: currencies.map((cur) => ({ currency: cur, contracts: overdueItems.filter((x) => x.f.currency === cur).length, amount: money(overdueItems.filter((x) => x.f.currency === cur).reduce((a, x) => a.plus(x.v), dec(0))).toFixed(2) })).filter((r) => Number(r.amount) > 0),
      items: overdueItems.sort((a, b) => a.f.currency.localeCompare(b.f.currency) || b.v.comparedTo(a.v)).slice(0, 15).map((x) => ({ contractId: x.f.id, number: x.f.number, supplier: x.f.supplier, currency: x.f.currency, amount: money(x.v).toFixed(2), debt: money(x.f.debt).toFixed(2) })),
    };
    (overdueBlock as any).totalUsd = usdSum(overdueBlock.byCurrency.map((r) => ({ currency: r.currency as CurrencyCode, v: dec(r.amount) })));
    (overdueBlock as any).totalUzs = uzsSum(overdueBlock.byCurrency.map((r) => ({ currency: r.currency as CurrencyCode, v: dec(r.amount) })));

    // Предстоящие: невыполненный план не прошедших недель в горизонте, но не больше долга за вычетом просрочки.
    type Upcoming = { f: (typeof facts)[number]; year: number; month: number; week: Week; amount: Dec; start: string; end: string };
    const perContract = new Map<string, Cell[]>();
    for (const c of cells.values()) perContract.set(c.contractId, [...(perContract.get(c.contractId) ?? []), c]);
    const collectUpcoming = (horizonDays: number): Upcoming[] => {
      const horizonEnd = addDays(today, horizonDays);
      const out: Upcoming[] = [];
      for (const [id, list] of perContract) {
        const f = factById.get(id)!;
        let allowance = f.debt.minus(overdueByContract.get(id) ?? dec(0));
        for (const c of [...list].sort((a, b) => a.year - b.year || a.month - b.month || a.week - b.week)) {
          const raw = c.plan.minus(c.fact);
          if (isWeekPast(c.year, c.month, c.week, today, bounds) || raw.lte(0) || allowance.lte(0)) continue;
          const start = weekStartIso(c.year, c.month, c.week, bounds);
          if (start > horizonEnd) continue;
          const take = raw.lt(allowance) ? raw : allowance;
          out.push({ f, year: c.year, month: c.month, week: c.week, amount: take, start, end: weekEndIso(c.year, c.month, c.week, bounds) });
          allowance = allowance.minus(take);
        }
      }
      return out;
    };
    const upcomingItems = collectUpcoming(q.horizon);
    const upcomingBlock = {
      horizonDays: q.horizon,
      byCurrency: currencies.map((cur) => ({ currency: cur, amount: money(upcomingItems.filter((x) => x.f.currency === cur).reduce((a, x) => a.plus(x.amount), dec(0))).toFixed(2) })).filter((r) => Number(r.amount) > 0),
      items: upcomingItems.sort((a, b) => a.start.localeCompare(b.start) || a.f.currency.localeCompare(b.f.currency)).slice(0, 15)
        .map((x) => ({ contractId: x.f.id, number: x.f.number, supplier: x.f.supplier, currency: x.f.currency, year: x.year, month: x.month, week: x.week, from: x.start, to: x.end, amount: money(x.amount).toFixed(2) })),
    };
    (upcomingBlock as any).totalUsd = usdSum(upcomingBlock.byCurrency.map((r) => ({ currency: r.currency as CurrencyCode, v: dec(r.amount) })));
    (upcomingBlock as any).totalUzs = uzsSum(upcomingBlock.byCurrency.map((r) => ({ currency: r.currency as CurrencyCode, v: dec(r.amount) })));

    // ---- переплаты ----
    const over = facts.filter((f) => f.overpaid.gt(0));
    const overpaid = {
      byCurrency: currencies.map((cur) => ({ currency: cur, contracts: over.filter((f) => f.currency === cur).length, amount: money(over.filter((f) => f.currency === cur).reduce((a, f) => a.plus(f.overpaid), dec(0))).toFixed(2) })).filter((r) => r.contracts > 0),
      items: over.sort((a, b) => a.currency.localeCompare(b.currency) || b.overpaid.comparedTo(a.overpaid)).slice(0, 10).map((f) => ({ contractId: f.id, number: f.number, supplier: f.supplier, currency: f.currency, amount: money(f.overpaid).toFixed(2) })),
    };
    (overpaid as any).totalUsd = usdSum(overpaid.byCurrency.map((r) => ({ currency: r.currency as CurrencyCode, v: dec(r.amount) })));
    (overpaid as any).totalUzs = uzsSum(overpaid.byCurrency.map((r) => ({ currency: r.currency as CurrencyCode, v: dec(r.amount) })));

    // ---- графики ----
    const bySupplier = new Map<string, { id: string; name: string; byCurrency: Record<string, { amount: Dec; paid: Dec; debt: Dec }> }>();
    for (const f of facts) {
      const s = bySupplier.get(f.supplier.id) ?? { id: f.supplier.id, name: f.supplier.name, byCurrency: {} };
      const c = (s.byCurrency[f.currency] ??= { amount: dec(0), paid: dec(0), debt: dec(0) });
      c.amount = c.amount.plus(f.amount); c.paid = c.paid.plus(f.paid); c.debt = c.debt.plus(f.debt);
      bySupplier.set(f.supplier.id, s);
    }
    const suppliers = [...bySupplier.values()].map((s) => {
      const curs = Object.keys(s.byCurrency) as CurrencyCode[];
      const u = (k: 'amount' | 'paid' | 'debt') => usdSum(curs.map((cur) => ({ currency: cur, v: s.byCurrency[cur][k] })));
      const uz = (k: 'amount' | 'paid' | 'debt') => uzsSum(curs.map((cur) => ({ currency: cur, v: s.byCurrency[cur][k] })));
      return {
        id: s.id, name: s.name,
        byCurrency: Object.fromEntries(curs.map((cur) => [cur, { amount: money(s.byCurrency[cur].amount).toFixed(2), paid: money(s.byCurrency[cur].paid).toFixed(2), debt: money(s.byCurrency[cur].debt).toFixed(2) }])),
        // эквивалент в USD — только если ВСЕ валюты поставщика пересчитываются (иначе сравнение с другими поставщиками было бы неверным)
        usd: curs.every((c) => !missing.includes(c)) ? { amount: u('amount'), paid: u('paid'), debt: u('debt') } : null,
        uzs: curs.every((c) => !missingUzs.includes(c)) ? { amount: uz('amount'), paid: uz('paid'), debt: uz('debt') } : null,
      };
    });

    const now = new Date();
    const from = q.from ?? `${new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, 1)).toISOString().slice(0, 7)}-01`;
    const to = q.to ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 4, 0)).toISOString().slice(0, 10);
    const fromIdx = monthIdx(Number(from.slice(0, 4)), Number(from.slice(5, 7))), toIdx = monthIdx(Number(to.slice(0, 4)), Number(to.slice(5, 7)));
    const monthMap = new Map<number, Record<string, { planned: Dec; actual: Dec }>>();
    for (let i = fromIdx; i <= Math.min(toIdx, fromIdx + 36); i++) monthMap.set(i, {});
    for (const c of cells.values()) {
      const idx = monthIdx(c.year, c.month);
      const m = monthMap.get(idx);
      if (!m) continue;
      const x = (m[c.currency] ??= { planned: dec(0), actual: dec(0) });
      x.planned = x.planned.plus(c.plan); x.actual = x.actual.plus(c.fact);
    }
    const months = [...monthMap].map(([idx, m]) => {
      const curs = Object.keys(m) as CurrencyCode[];
      return {
        year: Math.floor(idx / 12), month: (idx % 12) + 1,
        byCurrency: Object.fromEntries(curs.map((cur) => [cur, { planned: money(m[cur].planned).toFixed(2), actual: money(m[cur].actual).toFixed(2) }])),
        usd: curs.length && curs.every((c) => !missing.includes(c)) ? { planned: usdSum(curs.map((cur) => ({ currency: cur, v: m[cur].planned }))), actual: usdSum(curs.map((cur) => ({ currency: cur, v: m[cur].actual }))) } : curs.length ? null : { planned: '0.00', actual: '0.00' },
        uzs: curs.every((c) => !missingUzs.includes(c)) ? { planned: uzsSum(curs.map((cur) => ({ currency: cur, v: m[cur].planned }))) ?? '0.00', actual: uzsSum(curs.map((cur) => ({ currency: cur, v: m[cur].actual }))) ?? '0.00' } : null,
      };
    });

    const snaps = await this.analytics.snapshotsSince(addDays(today, -180));
    const dyn = new Map<string, { byCurrency: Record<string, string>; usd: Dec; complete: boolean }>();
    for (const s of snaps) {
      const k = s.date.toISOString().slice(0, 10);
      const d = dyn.get(k) ?? { byCurrency: {}, usd: dec(0), complete: true };
      d.byCurrency[s.currency] = s.debt.toFixed(2);
      if (s.debtUsd) d.usd = d.usd.plus(s.debtUsd.toString()); else d.complete = false;
      dyn.set(k, d);
    }
    // UZS-эквивалент каждого дня — по курсам, действовавшим на дату снимка (как и эквивалент в USD).
    const dynamics = [...dyn].map(([date, d]) => {
      const daySet = book.asOf(date);
      const curs = Object.keys(d.byCurrency) as CurrencyCode[];
      const complete = book.missingUzs(daySet, curs).length === 0;
      const total = curs.reduce((a, cur) => a.plus(book.toUzs(d.byCurrency[cur]!, cur, daySet).uzs ?? dec(0)), dec(0));
      return { date, byCurrency: d.byCurrency, totalUsd: money(d.usd).toFixed(2), usdComplete: d.complete, totalUzs: money(total).toFixed(2), uzsComplete: complete };
    });

    // «Цветок» отражает дисциплину платежей по всему портфелю (фильтры на него не влияют).
    const pl = await this.analytics.plantInputs();
    const anyDebt = (await this.analytics.portfolio({ status: 'ACTIVE' })).some((f) => f.debt.gt(0));
    const plant = plantState({ today, start: pl.start ?? today, paymentDates: pl.paymentDates, hasDebt: anyDebt });

    // ---- прогноз платежей по неделям (8 недель): невыполненный план в пределах долга; в UZS-эквиваленте по текущим курсам ----
    const WEEKS = 8;
    const fc = Array.from({ length: WEEKS }, (_, i) => ({ from: addDays(today, i * 7), to: addDays(today, i * 7 + 6), items: [] as Upcoming[] }));
    for (const it of collectUpcoming(WEEKS * 7)) {
      const days = Math.floor((new Date(it.start).getTime() - new Date(today).getTime()) / 86400_000);
      fc[Math.min(WEEKS - 1, Math.max(0, Math.floor(days / 7)))]!.items.push(it);
    }
    const forecast = {
      weeks: fc.map((w) => {
        const curs = CURRENCIES.filter((c) => w.items.some((x) => x.f.currency === c));
        const byCurrency = curs.map((cur) => ({ currency: cur, amount: money(w.items.filter((x) => x.f.currency === cur).reduce((a, x) => a.plus(x.amount), dec(0))).toFixed(2) }));
        return { from: w.from, to: w.to, count: w.items.length, byCurrency, uzs: curs.some((c) => missingUzs.includes(c)) ? null : uzsSum(byCurrency.map((r) => ({ currency: r.currency as CurrencyCode, v: dec(r.amount) }))) ?? '0.00' };
      }),
      overdueUzs: (overdueBlock as any).totalUzs ?? null,
    };

    // ---- разрезы: долг по проектам и исполнителям (топ-8 в UZS-эквиваленте) ----
    const breakdownBy = (keyOf: (f: (typeof facts)[number]) => string) => {
      const m = new Map<string, { name: string; uzs: Dec; incomplete: boolean; contracts: number; byCurrency: Map<CurrencyCode, Dec> }>();
      for (const f of facts) {
        if (!f.debt.gt(0)) continue;
        const name = keyOf(f).trim() || '(не указан)';
        const k = name.toLocaleLowerCase('ru');
        const row = m.get(k) ?? { name, uzs: dec(0), incomplete: false, contracts: 0, byCurrency: new Map() };
        const u = uzs(f.debt, f.currency);
        if (u) row.uzs = row.uzs.plus(u); else row.incomplete = true;
        row.contracts++; row.byCurrency.set(f.currency, (row.byCurrency.get(f.currency) ?? dec(0)).plus(f.debt));
        m.set(k, row);
      }
      return [...m.values()].sort((a, b) => b.uzs.comparedTo(a.uzs)).slice(0, 8)
        .map((r) => ({ name: r.name, contracts: r.contracts, uzs: money(r.uzs).toFixed(2), incomplete: r.incomplete, byCurrency: [...r.byCurrency].map(([currency, v]) => ({ currency, amount: money(v).toFixed(2) })) }));
    };
    const breakdown = { projects: breakdownBy((f) => f.project ?? '(без проекта)'), executors: breakdownBy((f) => f.executor ?? '(не указан)') };

    // ---- динамика долга за ~30 дней (по снимкам всего портфеля; нужен снимок не младше 30 дней) ----
    const snapDays = dynamics.filter((x) => x.uzsComplete);
    const lastSnap = snapDays.at(-1);
    const prevSnap = lastSnap ? [...snapDays].reverse().find((x) => x.date <= addDays(lastSnap.date, -28)) : undefined;
    const debtTrend = lastSnap && prevSnap ? { from: prevSnap.date, to: lastSnap.date, prevUzs: prevSnap.totalUzs, nowUzs: lastSnap.totalUzs } : null;

    return {
      asOf: today, plant, forecast, breakdown, debtTrend, filters: { currency: q.currency ?? null, supplierId: q.supplierId ?? null, project: q.project ?? null, executor: q.executor ?? null, status: q.status },
      period: { from, to },
      rates: { used: set.used, missing, usdComplete: missing.length === 0, missingUzs, uzsComplete: missingUzs.length === 0, uzsNote: missingUzs.length ? `Нет подтверждённого курса для: ${missingUzs.join(', ')}. Подтвердите курсы в разделе «Курсы валют».` : null, note: missing.length ? `Нет подтверждённого курса для: ${missing.join(', ')}. Итоги в USD неполные — подтвердите курсы в разделе «Курсы валют».` : null },
      kpi, overdue: overdueBlock, upcoming: upcomingBlock, overpaid, charts: { suppliers, months, dynamics },
      notes: [
        'Суммы договоров, оплаты и долг — на текущий момент (фильтры: валюта, проект, контрагент, исполнитель, статус).',
        'Период влияет на график «план и факт». Факт — подтверждённые платежи приложения с датой; историческая оплата из файла без дат в него не входит.',
        'Основная валюта итогов — UZS: сумма в исходной валюте × подтверждённый курс (UZS за 1 единицу) на текущую дату. Валюты не смешиваются без курса.',
        'Эквивалент в USD считается по подтверждённым курсам на текущую дату; график динамики хранит эквивалент по курсам на дату каждого снимка.',
        'Динамика задолженности накапливается ежедневными снимками с момента запуска — историю до первого снимка восстановить нельзя.',
      ],
    };
  }
}
