import { BadRequestException, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { CURRENCIES, dec, money, type CurrencyCode, type Dec, type RateSet, type RatesBook, type WeekBounds } from '@pf/shared';
import { AnalyticsService, periodFilters, portfolioFilters, todayIso, type Fact } from '../analytics/analytics.service';
import { aggregate, buildCells, overdueByCell, type Cell } from '../calendar/plan-fact';
import { PrismaService } from '../prisma/prisma.service';
import { CATALOG, type Column, type ReportResult, type Row } from './report-types';

export const reportQuery = portfolioFilters.merge(periodFilters).extend({
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  onlyDebt: z.enum(['true', 'false']).optional(),
});
export type ReportQuery = z.infer<typeof reportQuery>;

const f2 = (d: Dec | null | undefined) => (d ? money(d).toFixed(2) : null);
const sum = (xs: Dec[]) => xs.reduce((a, b) => a.plus(b), dec(0));
const KIND: Record<string, string> = { PAYMENT: 'Оплата', REFUND: 'Возврат', REVERSAL: 'Сторно' };
const MONTH = (y: number, m: number) => `${y}-${String(m).padStart(2, '0')}`;
const NO_PROJECT = '(без проекта)', NO_EXEC = '(не указан)';

const C = {
  text: (key: string, header: string, width = 24): Column => ({ key, header, type: 'text', width }),
  int: (key: string, header: string, width = 10): Column => ({ key, header, type: 'int', width }),
  money: (key: string, header: string, width = 18): Column => ({ key, header, type: 'money', width }),
  date: (key: string, header: string, width = 12): Column => ({ key, header, type: 'date', width }),
  rate: (key: string, header: string, width = 14): Column => ({ key, header, type: 'rate', width }),
  pct: (key: string, header: string, width = 10): Column => ({ key, header, type: 'percent', width }),
};
const USD_COLS = (label = 'Эквивалент USD'): Column[] => [C.money('usd', label, 18), C.rate('rate', 'Курс, USD за 1 ед.', 14), C.date('rateDate', 'Дата курса', 12)];

interface Ctx { q: ReportQuery; asOf: string; book: RatesBook; set: RateSet; bounds: WeekBounds }

@Injectable()
export class ReportsService {
  constructor(private analytics: AnalyticsService, private prisma: PrismaService) {}

  /** Эквивалент в USD, использованный курс и его дата для одной суммы. */
  private usd(ctx: Ctx, cur: CurrencyCode, amount: Dec | string, set = ctx.set) {
    const v = ctx.book.toUsd(amount, cur, set);
    return { usd: f2(v.usd), rate: v.rate, rateDate: v.rateDate };
  }

  /**
   * Итоги: по каждой валюте — сумма в исходной валюте (валюты не смешиваются); затем строка «в USD-эквиваленте».
   * usdKey — колонка, эквивалент которой выводится в колонку usd; usdAll — пересчитать в USD все перечисленные суммы.
   */
  private totals(ctx: Ctx, rows: Row[], labelKey: string, sumKeys: string[], o: { usdKey?: string; usdAll?: boolean; usdFromRows?: boolean } = {}): Row[] {
    const curs = CURRENCIES.filter((c) => rows.some((r) => r.currency === c));
    const out: Row[] = [];
    const natives = new Map<CurrencyCode, Record<string, Dec>>();
    for (const cur of curs) {
      const mine = rows.filter((r) => r.currency === cur);
      const s: Record<string, Dec> = Object.fromEntries(sumKeys.map((k) => [k, sum(mine.map((r) => dec((r[k] as string | number | null) ?? 0)))]));
      natives.set(cur, s);
      const row: Row = { [labelKey]: `ИТОГО ${cur}`, currency: cur, ...Object.fromEntries(sumKeys.map((k) => [k, k === 'contracts' ? Number(s[k]) : f2(s[k])])) };
      if (o.usdKey && !o.usdFromRows) Object.assign(row, this.usd(ctx, cur, s[o.usdKey]));
      out.push(row);
    }
    if (!curs.length) return out;
    const usdRow: Row = { [labelKey]: 'ИТОГО в USD-эквиваленте', currency: null };
    let any = false;
    if (o.usdFromRows && o.usdKey) { // курсы зависят от даты строки — итог = сумма эквивалентов строк
      const vals = rows.map((r) => r.usd).filter((v) => v !== null && v !== undefined) as string[];
      if (vals.length) { usdRow.usd = f2(sum(vals.map((v) => dec(v)))); any = true; }
    } else if (o.usdAll) {
      for (const k of sumKeys.filter((x) => x !== 'contracts')) {
        const parts = curs.map((c) => ctx.book.toUsd(natives.get(c)![k], c, ctx.set).usd).filter(Boolean) as Dec[];
        if (parts.length) { usdRow[k] = f2(sum(parts)); any = true; }
      }
    } else if (o.usdKey) {
      const parts = curs.map((c) => ctx.book.toUsd(natives.get(c)![o.usdKey!], c, ctx.set).usd).filter(Boolean) as Dec[];
      if (parts.length) { usdRow.usd = f2(sum(parts)); any = true; }
    }
    if (any) out.push(usdRow);
    return out;
  }

  private groupFacts(facts: Fact[], keyOf: (f: Fact) => string) {
    const m = new Map<string, Fact[]>();
    for (const f of facts) { const k = `${keyOf(f)}\u0000${f.currency}`; m.set(k, [...(m.get(k) ?? []), f]); }
    return [...m].map(([k, list]) => ({ key: k.split('\u0000')[0], currency: list[0].currency, list }))
      .sort((a, b) => a.key.localeCompare(b.key, 'ru') || a.currency.localeCompare(b.currency));
  }
  private sums(list: Fact[]) {
    return { contracts: list.length, amount: sum(list.map((f) => f.amount)), paid: sum(list.map((f) => f.paid)), debt: sum(list.map((f) => f.debt)), overpaid: sum(list.map((f) => f.overpaid)), planned: sum(list.map((f) => f.planned)) };
  }

  private async describe(q: ReportQuery, asOf: string): Promise<string[]> {
    const out = [`Дата расчёта: ${asOf}`];
    if (q.currency) out.push(`Валюта: ${q.currency}`);
    if (q.supplierId) out.push(`Контрагент: ${(await this.prisma.supplier.findUnique({ where: { id: q.supplierId }, select: { name: true } }))?.name ?? q.supplierId}`);
    if (q.project) out.push(`Проект содержит: ${q.project}`);
    if (q.executor) out.push(`Исполнитель содержит: ${q.executor}`);
    out.push(`Договоры: ${{ ACTIVE: 'активные', ARCHIVED: 'архивные', ALL: 'все' }[q.status]}`);
    if (q.from || q.to) out.push(`Период: ${q.from ?? '…'} — ${q.to ?? '…'}`);
    return out;
  }

  async build(id: string, q: ReportQuery): Promise<ReportResult> {
    const info = CATALOG.find((c) => c.id === id);
    if (!info) throw new BadRequestException('Неизвестный отчёт');
    const asOf = q.asOf ?? todayIso();
    const [book, bounds] = await Promise.all([this.analytics.book(), this.analytics.weekBounds()]);
    const ctx: Ctx = { q, asOf, book, set: book.asOf(asOf), bounds };
    const res: ReportResult = {
      ...info, asOf, generatedAt: new Date().toISOString(), filters: await this.describe(q, asOf), columns: [], rows: [], totals: [],
      rates: { used: ctx.set.used, missing: [] }, warnings: [],
    };
    const onlyDebt = (def: boolean) => (q.onlyDebt ? q.onlyDebt === 'true' : def);
    let currencies = new Set<CurrencyCode>();

    switch (id) {
      case 'total-debt': {
        const facts = await this.analytics.portfolio(q); currencies = new Set(facts.map((f) => f.currency));
        res.columns = [C.text('label', 'Валюта', 14), C.text('currency', 'Код', 8), C.int('contracts', 'Договоров'), C.money('amount', 'Сумма договоров'), C.money('paid', 'Оплачено'), C.money('debt', 'Долг'), C.money('overpaid', 'Переплата'), ...USD_COLS('Долг в USD')];
        res.rows = CURRENCIES.filter((c) => currencies.has(c)).map((cur) => { const s = this.sums(facts.filter((f) => f.currency === cur)); return { label: cur, currency: cur, contracts: s.contracts, amount: f2(s.amount), paid: f2(s.paid), debt: f2(s.debt), overpaid: f2(s.overpaid), ...this.usd(ctx, cur, s.debt) }; });
        res.totals = this.totals(ctx, res.rows, 'label', ['contracts', 'amount', 'paid', 'debt', 'overpaid'], { usdKey: 'debt' });
        break;
      }
      case 'debt-by-supplier': case 'debt-by-project': case 'debt-by-executor': {
        const facts = await this.analytics.portfolio(q); currencies = new Set(facts.map((f) => f.currency));
        const keyOf = id === 'debt-by-supplier' ? (f: Fact) => f.supplier.name : id === 'debt-by-project' ? (f: Fact) => f.project?.trim() || NO_PROJECT : (f: Fact) => f.executor?.trim() || NO_EXEC;
        const head = { 'debt-by-supplier': 'Контрагент', 'debt-by-project': 'Проект', 'debt-by-executor': 'Исполнитель' }[id];
        res.columns = [C.text('name', head, 44), C.text('currency', 'Валюта', 8), C.int('contracts', 'Договоров'), C.money('amount', 'Сумма договоров'), C.money('paid', 'Оплачено'), C.money('debt', 'Долг'), C.money('overpaid', 'Переплата'), ...USD_COLS('Долг в USD')];
        res.rows = this.groupFacts(facts, keyOf).map((g) => ({ g, s: this.sums(g.list) })).filter(({ s }) => !onlyDebt(true) || s.debt.gt(0))
          .map(({ g, s }) => ({ name: g.key, currency: g.currency, contracts: s.contracts, amount: f2(s.amount), paid: f2(s.paid), debt: f2(s.debt), overpaid: f2(s.overpaid), ...this.usd(ctx, g.currency, s.debt) }));
        res.totals = this.totals(ctx, res.rows, 'name', ['contracts', 'amount', 'paid', 'debt', 'overpaid'], { usdKey: 'debt' });
        if (id === 'debt-by-executor') res.warnings.push('Исполнители сгруппированы по написанию как в таблице: варианты вроде «Миракмал» и «Миракмал.» считаются разными.');
        if (onlyDebt(true)) res.warnings.push('Показаны только строки с долгом (параметр onlyDebt=false покажет все).');
        break;
      }
      case 'debt-by-contract': {
        const facts = (await this.analytics.portfolio(q)).filter((f) => !onlyDebt(true) || f.debt.gt(0)); currencies = new Set(facts.map((f) => f.currency));
        res.columns = [C.text('supplier', 'Контрагент', 40), C.text('number', 'Договор', 44), C.text('project', 'Проект', 26), C.text('executor', 'Исполнитель', 16), C.text('currency', 'Валюта', 8), C.money('amount', 'Сумма'), C.money('paid', 'Оплачено'), C.money('debt', 'Долг'), C.money('overpaid', 'Переплата'), ...USD_COLS('Долг в USD')];
        res.rows = facts.sort((a, b) => a.supplier.name.localeCompare(b.supplier.name, 'ru') || (a.number ?? '').localeCompare(b.number ?? '', 'ru'))
          .map((f) => ({ supplier: f.supplier.name, number: f.number, project: f.project, executor: f.executor, currency: f.currency, amount: f2(f.amount), paid: f2(f.paid), debt: f2(f.debt), overpaid: f2(f.overpaid), ...this.usd(ctx, f.currency, f.debt) }));
        res.totals = this.totals(ctx, res.rows, 'supplier', ['amount', 'paid', 'debt', 'overpaid'], { usdKey: 'debt' });
        break;
      }
      case 'payments': {
        const from = q.from ?? `${asOf.slice(0, 4)}-01-01`, to = q.to ?? asOf;
        res.filters.push(`Период платежей: ${from} — ${to}`);
        const ids = await this.analytics.contractIds(q);
        const ps = await this.prisma.payment.findMany({
          where: { status: 'APPROVED', paymentDate: { gte: new Date(from), lte: new Date(to) }, contractId: { in: ids } },
          include: { contract: { select: { number: true, supplier: { select: { name: true } } } } }, orderBy: [{ paymentDate: 'asc' }, { createdAt: 'asc' }], take: 20000,
        });
        const users = await this.prisma.user.findMany({ where: { id: { in: [...new Set(ps.map((p) => p.approvedById).filter(Boolean) as string[])] } }, select: { id: true, name: true } });
        const uname = new Map(users.map((u) => [u.id, u.name]));
        currencies = new Set(ps.map((p) => p.currency));
        res.columns = [C.date('date', 'Дата платежа'), C.text('supplier', 'Контрагент', 38), C.text('number', 'Договор', 36), C.text('kind', 'Тип', 9), C.text('currency', 'Валюта', 8), C.money('amount', 'Сумма'), C.money('signed', 'Влияние на оплату'), ...USD_COLS('Эквивалент USD (влияние)'), C.text('bank', 'Банковский документ', 20), C.text('tx', 'Номер транзакции', 20), C.text('approver', 'Подтвердил', 16), C.date('approvedAt', 'Дата подтверждения', 14)];
        res.rows = ps.map((p) => {
          const date = p.paymentDate.toISOString().slice(0, 10);
          return { date, supplier: p.contract.supplier.name, number: p.contract.number, kind: KIND[p.kind], currency: p.currency, amount: f2(dec(p.amount.toString())), signed: f2(dec(p.signedAmount?.toString() ?? 0)), ...this.usd(ctx, p.currency, p.signedAmount?.toString() ?? '0', book.asOf(date)), bank: p.bankDocument, tx: p.transactionNo, approver: p.approvedById ? uname.get(p.approvedById) ?? null : null, approvedAt: p.approvedAt?.toISOString().slice(0, 10) ?? null };
        });
        res.totals = this.totals(ctx, res.rows, 'supplier', ['signed'], { usdKey: 'signed', usdFromRows: true });
        res.warnings.push('Эквивалент в USD каждого платежа — по курсу на дату платежа. Историческая оплата из импортированного файла (без дат) в отчёт не входит.');
        break;
      }
      case 'plan': {
        const base = new Date(`${asOf.slice(0, 7)}-01`);
        const from = q.from ?? `${asOf.slice(0, 7)}-01`, to = q.to ?? new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 6, 0)).toISOString().slice(0, 10);
        res.filters.push(`Период плана: ${from.slice(0, 7)} — ${to.slice(0, 7)}`);
        const fi = Number(from.slice(0, 4)) * 12 + Number(from.slice(5, 7)), ti = Number(to.slice(0, 4)) * 12 + Number(to.slice(5, 7));
        const plans = (await this.prisma.planEntry.findMany({ where: { contractId: { in: await this.analytics.contractIds(q) }, year: { gte: Number(from.slice(0, 4)), lte: Number(to.slice(0, 4)) } }, include: { contract: { select: { number: true, project: true, supplier: { select: { name: true } } } } } }))
          .filter((p) => p.year * 12 + p.month >= fi && p.year * 12 + p.month <= ti).sort((a, b) => a.year - b.year || a.month - b.month || a.week - b.week || a.contract.supplier.name.localeCompare(b.contract.supplier.name, 'ru'));
        currencies = new Set(plans.map((p) => p.currency));
        res.columns = [C.text('period', 'Период', 10), C.text('week', 'Неделя', 8), C.text('supplier', 'Контрагент', 38), C.text('number', 'Договор', 36), C.text('project', 'Проект', 24), C.text('currency', 'Валюта', 8), C.money('amount', 'Плановая сумма'), ...USD_COLS(), C.text('source', 'Источник', 10), C.text('note', 'Комментарий', 30)];
        res.rows = plans.map((p) => ({ period: MONTH(p.year, p.month), week: `W${p.week}`, supplier: p.contract.supplier.name, number: p.contract.number, project: p.contract.project, currency: p.currency, amount: f2(dec(p.amount.toString())), ...this.usd(ctx, p.currency, p.amount.toString()), source: p.source === 'IMPORT' ? 'импорт' : 'вручную', note: p.note }));
        res.totals = this.totals(ctx, res.rows, 'supplier', ['amount'], { usdKey: 'amount' });
        res.warnings.push('План — намерение платить: он не уменьшает долг.');
        break;
      }
      case 'plan-vs-fact': {
        const from = q.from ?? `${asOf.slice(0, 4)}-01-01`, to = q.to ?? `${asOf.slice(0, 4)}-12-31`;
        res.filters.push(`Период: ${from.slice(0, 7)} — ${to.slice(0, 7)}`);
        const facts = await this.analytics.portfolio(q); currencies = new Set(facts.map((f) => f.currency));
        const byId = new Map(facts.map((f) => [f.id, f]));
        const { plans, payments } = await this.analytics.planAndPayments(facts.map((f) => f.id));
        const cells = buildCells(plans, payments, bounds);
        const overdue = overdueByCell(cells.values(), new Map(facts.map((f) => [f.id, f.debt])), asOf, bounds);
        const fi = Number(from.slice(0, 4)) * 12 + Number(from.slice(5, 7)), ti = Number(to.slice(0, 4)) * 12 + Number(to.slice(5, 7));
        const groups = new Map<string, Cell[]>();
        for (const c of cells.values()) { const idx = c.year * 12 + c.month; if (idx < fi || idx > ti) continue; const k = `${c.contractId}|${c.year}|${c.month}`; groups.set(k, [...(groups.get(k) ?? []), c]); }
        res.columns = [C.text('period', 'Месяц', 10), C.text('supplier', 'Контрагент', 38), C.text('number', 'Договор', 36), C.text('currency', 'Валюта', 8), C.money('planned', 'План'), C.money('actual', 'Факт'), C.money('remaining', 'Остаток плана'), C.money('over', 'Сверх плана'), C.money('overdue', 'Просрочено')];
        res.rows = [...groups].map(([k, list]) => {
          const f = byId.get(k.split('|')[0])!, a = aggregate(list);
          const od = sum(list.map((c) => overdue.get(`${c.contractId}|${c.year}|${c.month}|${c.week}`) ?? dec(0)));
          return { period: MONTH(list[0].year, list[0].month), supplier: f.supplier.name, number: f.number, currency: f.currency, planned: f2(a.plan), actual: f2(a.fact), remaining: f2(a.remaining), over: f2(a.over), overdue: f2(od) };
        }).sort((a, b) => String(a.period).localeCompare(String(b.period)) || String(a.supplier).localeCompare(String(b.supplier), 'ru'));
        res.totals = this.totals(ctx, res.rows, 'supplier', ['planned', 'actual', 'remaining', 'over', 'overdue'], { usdAll: true });
        res.warnings.push('Факт — только подтверждённые платежи приложения с датой. Остаток плана считается по договору и неделе, а не по итогу.');
        break;
      }
      case 'overdue': {
        const facts = await this.analytics.portfolio(q); currencies = new Set(facts.map((f) => f.currency));
        const byId = new Map(facts.map((f) => [f.id, f]));
        const { plans, payments } = await this.analytics.planAndPayments(facts.map((f) => f.id));
        const cells = buildCells(plans, payments, bounds);
        const od = overdueByCell(cells.values(), new Map(facts.map((f) => [f.id, f.debt])), asOf, bounds);
        const per = new Map<string, { sum: Dec; since: string }>();
        for (const [k, v] of od) {
          const [cid, y, m, w] = k.split('|'); const since = `${MONTH(Number(y), Number(m))} W${w}`;
          const cur = per.get(cid); per.set(cid, { sum: (cur?.sum ?? dec(0)).plus(v), since: cur && cur.since < since ? cur.since : since });
        }
        res.columns = [C.text('supplier', 'Контрагент', 40), C.text('number', 'Договор', 40), C.text('currency', 'Валюта', 8), C.money('debt', 'Долг'), C.money('overdue', 'Просрочено'), C.text('since', 'С периода', 14), ...USD_COLS('Просрочено в USD')];
        res.rows = [...per].map(([cid, x]) => ({ f: byId.get(cid)!, x })).sort((a, b) => a.f.currency.localeCompare(b.f.currency) || b.x.sum.comparedTo(a.x.sum))
          .map(({ f, x }) => ({ supplier: f.supplier.name, number: f.number, currency: f.currency, debt: f2(f.debt), overdue: f2(x.sum), since: x.since, ...this.usd(ctx, f.currency, x.sum) }));
        res.totals = this.totals(ctx, res.rows, 'supplier', ['debt', 'overdue'], { usdKey: 'overdue' });
        res.warnings.push('Просрочено = невыполненный план прошедших недель, но не больше текущего долга по договору.');
        break;
      }
      case 'overpayments': {
        const facts = (await this.analytics.portfolio(q)).filter((f) => f.overpaid.gt(0)); currencies = new Set(facts.map((f) => f.currency));
        res.columns = [C.text('supplier', 'Контрагент', 40), C.text('number', 'Договор', 44), C.text('currency', 'Валюта', 8), C.money('amount', 'Сумма договора'), C.money('paid', 'Оплачено'), C.money('overpaid', 'Переплата'), ...USD_COLS('Переплата в USD')];
        res.rows = facts.sort((a, b) => a.currency.localeCompare(b.currency) || b.overpaid.comparedTo(a.overpaid)).map((f) => ({ supplier: f.supplier.name, number: f.number, currency: f.currency, amount: f2(f.amount), paid: f2(f.paid), overpaid: f2(f.overpaid), ...this.usd(ctx, f.currency, f.overpaid) }));
        res.totals = this.totals(ctx, res.rows, 'supplier', ['amount', 'paid', 'overpaid'], { usdKey: 'overpaid' });
        break;
      }
      case 'currency-analytics': {
        const facts = await this.analytics.portfolio(q); currencies = new Set(facts.map((f) => f.currency));
        res.columns = [C.text('currency', 'Валюта', 8), C.int('contracts', 'Договоров'), C.money('amount', 'Сумма договоров'), C.money('paid', 'Оплачено'), C.money('debt', 'Долг'), C.money('overpaid', 'Переплата'), C.money('planned', 'План'),
          C.rate('rate', 'Курс, USD за 1 ед.'), C.date('rateDate', 'Дата курса'), C.money('usdAmount', 'Сумма, USD'), C.money('usdPaid', 'Оплачено, USD'), C.money('usdDebt', 'Долг, USD'), C.money('usdOverpaid', 'Переплата, USD'), C.money('usdPlanned', 'План, USD'), C.pct('share', 'Доля в долге')];
        const rows = CURRENCIES.filter((c) => currencies.has(c)).map((cur) => {
          const s = this.sums(facts.filter((f) => f.currency === cur)); const u = (v: Dec) => ctx.book.toUsd(v, cur, ctx.set);
          const dU = u(s.debt);
          return { cur, s, dU, row: { currency: cur, contracts: s.contracts, amount: f2(s.amount), paid: f2(s.paid), debt: f2(s.debt), overpaid: f2(s.overpaid), planned: f2(s.planned), rate: dU.rate, rateDate: dU.rateDate, usdAmount: f2(u(s.amount).usd), usdPaid: f2(u(s.paid).usd), usdDebt: f2(dU.usd), usdOverpaid: f2(u(s.overpaid).usd), usdPlanned: f2(u(s.planned).usd), share: null as number | null } };
        });
        const totalDebtUsd = sum(rows.map((r) => r.dU.usd).filter(Boolean) as Dec[]);
        for (const r of rows) r.row.share = r.dU.usd && totalDebtUsd.gt(0) ? Number(r.dU.usd.div(totalDebtUsd).times(100).toDecimalPlaces(1)) : null;
        res.rows = rows.map((r) => r.row);
        const t: Row = { currency: 'ИТОГО в USD-эквиваленте' };
        for (const k of ['usdAmount', 'usdPaid', 'usdDebt', 'usdOverpaid', 'usdPlanned']) { const vals = res.rows.map((r) => r[k]).filter(Boolean) as string[]; if (vals.length) t[k] = f2(sum(vals.map((v) => dec(v)))); }
        res.totals = res.rows.length ? [t] : [];
        break;
      }
    }

    const missing = book.missing(ctx.set, currencies);
    res.rates.missing = missing;
    if (missing.length && res.columns.some((c) => c.key === 'usd' || c.key.startsWith('usd'))) res.warnings.unshift(`Нет подтверждённого курса на ${asOf} для: ${missing.join(', ')} — эквивалент в USD по ним не рассчитан (подтвердите курсы в разделе «Курсы валют»).`);
    return res;
  }
}
