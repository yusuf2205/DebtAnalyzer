import { BadRequestException, Body, ConflictException, Controller, Delete, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { cleanDisplayName, CURRENCIES, extractTaxId, supplierExactKey, supplierMatchKey } from '@pf/shared';
import { AuditService } from '../audit/audit.service';
import { ClientIp, CurrentUser, RequirePermission } from '../auth/decorators';
import type { AuthUser } from '../common/types';
import { contractDebt, netPaidMap, summarize, type CurrencyTotals } from '../common/metrics';
import { sendXlsx } from '../common/xlsx';
import { parse } from '../common/zod';
import { PrismaService } from '../prisma/prisma.service';

const listQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(['ACTIVE', 'ARCHIVED', 'ALL']).default('ACTIVE'),
  currency: z.enum(CURRENCIES).optional(),
  executor: z.string().trim().max(100).optional(),
  hasDebt: z.enum(['true', 'false']).optional(),
  sort: z.enum(['name', 'contracts', 'amount', 'paid', 'debt', 'planned']).default('name'),
  dir: z.enum(['asc', 'desc']).default('asc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
});

interface SupplierRow {
  id: string; name: string; taxId: string | null; status: string; aliasCount: number; contracts: number;
  byCurrency: CurrencyTotals[]; executors: string[];
}

@Controller('suppliers')
export class SuppliersController {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  /** Список с агрегатами. Суммы всегда по валютам; сортировка по суммам требует валюты (по умолчанию USD). */
  private async build(q: z.infer<typeof listQuery>): Promise<{ rows: SupplierRow[]; totals: CurrencyTotals[] }> {
    const where: Prisma.SupplierWhereInput = {
      ...(q.status !== 'ALL' ? { status: q.status } : {}),
      ...(q.q ? { OR: [{ name: { contains: q.q, mode: 'insensitive' } }, { taxId: { contains: q.q } }, { aliases: { some: { alias: { contains: q.q, mode: 'insensitive' } } } }] } : {}),
    };
    const suppliers = await this.prisma.supplier.findMany({ where, include: { _count: { select: { aliases: true } } } });
    const ids = suppliers.map((s) => s.id);
    const contracts = await this.prisma.contract.findMany({ where: { supplierId: { in: ids }, status: 'ACTIVE' }, select: { id: true, supplierId: true, currency: true, amount: true, openingPaid: true, executor: true } });
    const plans = await this.prisma.planEntry.groupBy({ by: ['contractId'], where: { contract: { supplierId: { in: ids }, status: 'ACTIVE' } }, _sum: { amount: true } });
    const planBy = new Map(plans.map((p) => [p.contractId, p._sum.amount]));
    const net = await netPaidMap(this.prisma, contracts.map((c) => c.id));
    const bySup = new Map<string, typeof contracts>();
    for (const c of contracts) bySup.set(c.supplierId, [...(bySup.get(c.supplierId) ?? []), c]);

    let rows: SupplierRow[] = suppliers.map((s) => {
      const cs = bySup.get(s.id) ?? [];
      const scoped = q.currency ? cs.filter((c) => c.currency === q.currency) : cs;
      return {
        id: s.id, name: s.name, taxId: s.taxId, status: s.status, aliasCount: s._count.aliases, contracts: scoped.length,
        byCurrency: summarize(scoped.map((c) => ({ ...c, planned: planBy.get(c.id) ?? null, newPaid: net.get(c.id) ?? null }))),
        executors: [...new Set(scoped.map((c) => c.executor?.trim()).filter(Boolean) as string[])].sort(),
      };
    });
    if (q.currency || q.executor || q.hasDebt) {
      rows = rows.filter((r) => {
        if (q.executor && !r.executors.some((e) => e.toLowerCase().includes(q.executor!.toLowerCase()))) return false;
        if (q.hasDebt) { const d = r.byCurrency.some((c) => Number(c.debt) > 0); if (d !== (q.hasDebt === 'true')) return false; }
        return q.currency ? r.contracts > 0 : true;
      });
    }
    const cur = q.currency ?? 'USD';
    const val = (r: SupplierRow) => (q.sort === 'name' ? 0 : q.sort === 'contracts' ? r.contracts : Number(r.byCurrency.find((c) => c.currency === cur)?.[q.sort] ?? 0));
    rows.sort((a, b) => (q.sort === 'name' ? a.name.localeCompare(b.name, 'ru') : val(a) - val(b)) * (q.dir === 'asc' ? 1 : -1) || a.name.localeCompare(b.name, 'ru'));
    return { rows, totals: summarize(contracts.filter((c) => rows.some((r) => r.id === c.supplierId) && (!q.currency || c.currency === q.currency)).map((c) => ({ ...c, planned: planBy.get(c.id) ?? null, newPaid: net.get(c.id) ?? null }))) };
  }

  @Get()
  @RequirePermission('suppliers.view')
  async list(@Query() raw: Record<string, string>) {
    const q = parse(listQuery, raw);
    const { rows, totals } = await this.build(q);
    const start = (q.page - 1) * q.pageSize;
    return { total: rows.length, page: q.page, pageSize: q.pageSize, totals, items: rows.slice(start, start + q.pageSize) };
  }

  @Get('export')
  @RequirePermission('reports.export')
  async export(@Query() raw: Record<string, string>, @Res() res: Response, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) {
    const q = parse(listQuery, raw);
    const { rows, totals } = await this.build(q);
    await this.audit.log({ userId: u.id, userEmail: u.email, action: 'export.suppliers', entity: 'Supplier', meta: { filters: q, rows: rows.length }, ip });
    const flat = rows.flatMap((r) => (r.byCurrency.length ? r.byCurrency : [{ currency: '', contracts: 0, amount: '', paid: '', debt: '', overpaid: '', planned: '' }]).map((c) => ({
      name: r.name, taxId: r.taxId ?? '', currency: c.currency, contracts: c.contracts, amount: c.amount, paid: c.paid, debt: c.debt, overpaid: c.overpaid, planned: c.planned, executors: r.executors.join(', '),
    })));
    await sendXlsx(res, 'Контрагенты.xlsx', 'Контрагенты', [
      { header: 'Контрагент', key: 'name', width: 46 }, { header: 'ИНН', key: 'taxId', width: 14 }, { header: 'Валюта', key: 'currency', width: 9 },
      { header: 'Договоров', key: 'contracts', width: 11, type: 'int' }, { header: 'Сумма контрактов', key: 'amount', width: 20, type: 'money' },
      { header: 'Оплачено', key: 'paid', width: 20, type: 'money' }, { header: 'Долг', key: 'debt', width: 20, type: 'money' },
      { header: 'Переплата', key: 'overpaid', width: 16, type: 'money' }, { header: 'План', key: 'planned', width: 20, type: 'money' }, { header: 'Исполнители', key: 'executors', width: 30 },
    ], flat, totals.map((t) => ({ name: 'ИТОГО по валюте', currency: t.currency, contracts: t.contracts, amount: t.amount, paid: t.paid, debt: t.debt, overpaid: t.overpaid, planned: t.planned })));
  }

  /** Предложения по объединению. Ничего не объединяется автоматически — решение за пользователем. */
  @Get('suggestions')
  @RequirePermission('suppliers.view')
  async suggestions() {
    const sups = await this.prisma.supplier.findMany({ where: { status: 'ACTIVE' }, include: { aliases: true, _count: { select: { contracts: true } } } });
    const parent = new Map<string, string>(sups.map((s) => [s.id, s.id]));
    const find = (x: string): string => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x)!)), parent.get(x)!));
    const reasons = new Map<string, Set<string>>();
    const link = (a: string, b: string, why: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); (reasons.get(find(a)) ?? reasons.set(find(a), new Set()).get(find(a))!).add(why); };
    const byKey = new Map<string, string>(), byTax = new Map<string, string>();
    for (const s of sups) {
      const keys = new Set([supplierMatchKey(s.name), ...s.aliases.map((a) => supplierMatchKey(a.alias))].filter((k) => k.length >= 4));
      for (const k of keys) { const o = byKey.get(k); if (o && o !== s.id) link(o, s.id, 'похожее название'); else byKey.set(k, s.id); }
      if (s.taxId) { const o = byTax.get(s.taxId); if (o && o !== s.id) link(o, s.id, 'одинаковый ИНН'); else byTax.set(s.taxId, s.id); }
    }
    const groups = new Map<string, typeof sups>();
    for (const s of sups) groups.set(find(s.id), [...(groups.get(find(s.id)) ?? []), s]);
    return [...groups.entries()].filter(([, g]) => g.length > 1).map(([root, g]) => ({
      reasons: [...(reasons.get(root) ?? [])],
      suppliers: g.map((s) => ({ id: s.id, name: s.name, taxId: s.taxId, contracts: s._count.contracts, aliases: s.aliases.map((a) => a.alias) })),
    }));
  }

  @Post()
  @RequirePermission('suppliers.manage')
  async create(@CurrentUser() u: AuthUser, @Body() body: unknown, @ClientIp() ip: string | null) {
    const d = parse(z.object({ name: z.string().trim().min(2).max(300), taxId: z.string().trim().regex(/^\d{9,14}$/).optional() }), body);
    const name = cleanDisplayName(d.name), exactKey = supplierExactKey(name);
    const clash = await this.prisma.supplierAlias.findUnique({ where: { exactKey }, include: { supplier: true } });
    if (clash) throw new ConflictException(`Такое написание уже принадлежит поставщику «${clash.supplier.name}»`);
    const s = await this.prisma.supplier.create({ data: { name, taxId: d.taxId ?? extractTaxId(name), aliases: { create: { alias: name, exactKey, source: 'MANUAL' } } } });
    await this.audit.log({ userId: u.id, userEmail: u.email, action: 'supplier.create', entity: 'Supplier', entityId: s.id, after: s, ip });
    return s;
  }

  @Get(':id')
  @RequirePermission('suppliers.view')
  async get(@Param('id', ParseUUIDPipe) id: string) {
    const s = await this.prisma.supplier.findUnique({ where: { id }, include: { aliases: { orderBy: { createdAt: 'asc' } }, mergedInto: { select: { id: true, name: true } }, mergedFrom: { select: { id: true, name: true } } } });
    if (!s) throw new NotFoundException('Поставщик не найден');
    const contracts = await this.prisma.contract.findMany({ where: { supplierId: id }, orderBy: [{ status: 'asc' }, { createdAt: 'desc' }], include: { plans: { select: { amount: true } } } });
    const net = await netPaidMap(this.prisma, contracts.map((c) => c.id));
    const items = contracts.map((c) => {
      const planned = c.plans.reduce((a, p) => a.plus(p.amount), new Prisma.Decimal(0));
      const d = contractDebt({ ...c, newPaid: net.get(c.id) });
      return { id: c.id, number: c.number, project: c.project, goods: c.goods, contractDate: c.contractDate, currency: c.currency, amount: c.amount, openingPaid: c.openingPaid, newPaid: (net.get(c.id) ?? new Prisma.Decimal(0)).toFixed(2), debt: d.debt.toFixed(2), overpaid: d.overpaid.toFixed(2), state: d.state, planned: planned.toFixed(2), executor: c.executor, status: c.status };
    });
    const active = contracts.filter((c) => c.status === 'ACTIVE').map((c) => ({ ...c, planned: c.plans.reduce((a, p) => a.plus(p.amount), new Prisma.Decimal(0)), newPaid: net.get(c.id) ?? null }));
    const history = await this.prisma.auditLog.findMany({ where: { entity: 'Supplier', entityId: id }, orderBy: { id: 'desc' }, take: 50 });
    return { ...s, totals: summarize(active), contracts: items, history: history.map((h) => ({ ...h, id: h.id.toString() })) };
  }

  @Patch(':id')
  @RequirePermission('suppliers.manage')
  async update(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @ClientIp() ip: string | null) {
    const d = parse(z.object({ name: z.string().trim().min(2).max(300).optional(), taxId: z.string().trim().regex(/^\d{9,14}$/).nullable().optional() }), body);
    const before = await this.prisma.supplier.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Поставщик не найден');
    if (before.status === 'ARCHIVED') throw new BadRequestException('Поставщик архивирован (объединён) — изменения невозможны');
    const name = d.name ? cleanDisplayName(d.name) : undefined;
    const after = await this.prisma.$transaction(async (tx) => {
      if (name) {
        const key = supplierExactKey(name);
        const clash = await tx.supplierAlias.findUnique({ where: { exactKey: key } });
        if (clash && clash.supplierId !== id) throw new ConflictException('Это написание принадлежит другому поставщику — используйте объединение');
        if (!clash) await tx.supplierAlias.create({ data: { supplierId: id, alias: name, exactKey: key, source: 'MANUAL' } });
      }
      return tx.supplier.update({ where: { id }, data: { name, taxId: d.taxId } });
    });
    await this.audit.log({ userId: u.id, userEmail: u.email, action: 'supplier.update', entity: 'Supplier', entityId: id, before, after, ip });
    return after;
  }

  @Post(':id/aliases')
  @RequirePermission('suppliers.manage')
  async addAlias(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @ClientIp() ip: string | null) {
    const { alias } = parse(z.object({ alias: z.string().trim().min(2).max(300) }), body);
    const s = await this.prisma.supplier.findUnique({ where: { id } });
    if (!s || s.status !== 'ACTIVE') throw new NotFoundException('Активный поставщик не найден');
    const clean = cleanDisplayName(alias), exactKey = supplierExactKey(clean);
    const clash = await this.prisma.supplierAlias.findUnique({ where: { exactKey }, include: { supplier: true } });
    if (clash) throw new ConflictException(clash.supplierId === id ? 'Такое написание уже есть' : `Это написание принадлежит поставщику «${clash.supplier.name}». Если это одна компания — объедините карточки.`);
    const a = await this.prisma.supplierAlias.create({ data: { supplierId: id, alias: clean, exactKey, source: 'MANUAL' } });
    await this.audit.log({ userId: u.id, userEmail: u.email, action: 'supplier.alias_add', entity: 'Supplier', entityId: id, after: a, ip });
    return a;
  }

  @Delete(':id/aliases/:aliasId')
  @RequirePermission('suppliers.manage')
  async removeAlias(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('aliasId', ParseUUIDPipe) aliasId: string, @ClientIp() ip: string | null) {
    const a = await this.prisma.supplierAlias.findFirst({ where: { id: aliasId, supplierId: id } });
    if (!a) throw new NotFoundException('Написание не найдено');
    if ((await this.prisma.supplierAlias.count({ where: { supplierId: id } })) <= 1) throw new BadRequestException('Нельзя удалить последнее написание поставщика');
    await this.prisma.supplierAlias.delete({ where: { id: aliasId } });
    await this.audit.log({ userId: u.id, userEmail: u.email, action: 'supplier.alias_remove', entity: 'Supplier', entityId: id, before: a, ip });
    return { ok: true };
  }

  /** Объединение: договоры и написания переходят к целевому поставщику, исходные архивируются (физически не удаляются). */
  @Post('merge')
  @RequirePermission('suppliers.merge')
  async merge(@CurrentUser() u: AuthUser, @Body() body: unknown, @ClientIp() ip: string | null) {
    const d = parse(z.object({ targetId: z.string().uuid(), sourceIds: z.array(z.string().uuid()).min(1).max(20), confirm: z.literal(true) }), body);
    if (d.sourceIds.includes(d.targetId) || new Set(d.sourceIds).size !== d.sourceIds.length) throw new BadRequestException('Некорректный набор поставщиков для объединения');
    const result = await this.prisma.$transaction(async (tx) => {
      const all = await tx.supplier.findMany({ where: { id: { in: [d.targetId, ...d.sourceIds] } }, include: { aliases: true } });
      if (all.length !== d.sourceIds.length + 1) throw new NotFoundException('Поставщик не найден');
      if (all.some((s) => s.status !== 'ACTIVE')) throw new BadRequestException('Объединять можно только активных поставщиков');
      const moved = await tx.contract.findMany({ where: { supplierId: { in: d.sourceIds } }, select: { id: true, supplierId: true } });
      await tx.contract.updateMany({ where: { supplierId: { in: d.sourceIds } }, data: { supplierId: d.targetId } });
      await tx.supplierAlias.updateMany({ where: { supplierId: { in: d.sourceIds } }, data: { supplierId: d.targetId } });
      await tx.supplier.updateMany({ where: { id: { in: d.sourceIds } }, data: { status: 'ARCHIVED', mergedIntoId: d.targetId } });
      const target = all.find((s) => s.id === d.targetId)!;
      if (!target.taxId) { const tax = all.map((s) => s.taxId).find(Boolean); if (tax) await tx.supplier.update({ where: { id: d.targetId }, data: { taxId: tax } }); }
      // В аудит пишем всё нужное для ручного отката: какие договоры и написания откуда переехали.
      await this.audit.log({
        userId: u.id, userEmail: u.email, action: 'supplier.merge', entity: 'Supplier', entityId: d.targetId, ip,
        before: all.map((s) => ({ id: s.id, name: s.name, taxId: s.taxId, aliases: s.aliases.map((a) => ({ id: a.id, alias: a.alias })) })),
        meta: { targetId: d.targetId, sourceIds: d.sourceIds, movedContracts: moved },
      }, tx);
      return { targetId: d.targetId, mergedSuppliers: d.sourceIds.length, movedContracts: moved.length };
    });
    return result;
  }
}
