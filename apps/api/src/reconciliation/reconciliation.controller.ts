import { BadRequestException, Body, ConflictException, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { dec, money } from '@pf/shared';
import { AuditService } from '../audit/audit.service';
import { ClientIp, CurrentUser, RequirePermission } from '../auth/decorators';
import type { AuthUser } from '../common/types';
import { parse } from '../common/zod';
import { PrismaService } from '../prisma/prisma.service';

interface Change { field: 'openingPaid' | 'amount' | 'currency'; from: string | null; to: string | null }
const cents = (v: { toString(): string }) => Math.round(Number(v.toString()) * 100);

/** Точное совпадение набора платежей с приростом «Оплачено» в источнике (до 20 кандидатов; предпочитаем меньше платежей). */
function suggestSubset(cands: { id: string; amount: Prisma.Decimal }[], target: number): string[] | null {
  if (target <= 0 || cands.length > 20) return null;
  const c = cands.map((x) => ({ id: x.id, v: cents(x.amount) })).sort((a, b) => b.v - a.v);
  let best: string[] | null = null;
  const go = (i: number, left: number, picked: string[]) => {
    if (left === 0) { if (!best || picked.length < best.length) best = [...picked]; return; }
    if (i >= c.length || left < 0) return;
    go(i + 1, left - c[i].v, [...picked, c[i].id]);
    go(i + 1, left, picked);
  };
  go(0, target, []);
  return best;
}

const listQuery = z.object({
  status: z.enum(['PENDING', 'MATCHED', 'CONFIRMED', 'REJECTED']).optional(),
  open: z.enum(['true', 'false']).optional(), // открытые = PENDING + MATCHED
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

@Controller('reconciliation')
export class ReconciliationController {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  private async enrich(tasks: Prisma.ReconciliationTaskGetPayload<object>[]) {
    const contractIds = [...new Set(tasks.map((t) => t.contractId).filter(Boolean) as string[])];
    const contracts = await this.prisma.contract.findMany({ where: { id: { in: contractIds } }, include: { supplier: { select: { id: true, name: true } } } });
    const cmap = new Map(contracts.map((c) => [c.id, c]));
    const cands = await this.prisma.payment.findMany({ where: { contractId: { in: contractIds }, status: 'APPROVED', kind: 'PAYMENT', reflectedInOpening: false }, orderBy: { paymentDate: 'asc' } });
    const users = await this.prisma.user.findMany({ where: { id: { in: tasks.map((t) => t.resolvedById).filter(Boolean) as string[] } }, select: { id: true, name: true } });
    const uname = new Map(users.map((u) => [u.id, u.name]));
    return tasks.map((t) => {
      const c = t.contractId ? cmap.get(t.contractId) : undefined;
      const changes = ((t.details as any)?.changes ?? []) as Change[];
      const paid = changes.find((x) => x.field === 'openingPaid');
      const delta = c && paid?.to != null ? dec(paid.to).minus(c.openingPaid.toString()) : null;
      const open = t.status === 'PENDING' || t.status === 'MATCHED';
      const candidates = open ? cands.filter((p) => p.contractId === t.contractId) : [];
      const suggested = delta && delta.gt(0) ? suggestSubset(candidates, cents(delta)) : null;
      return {
        id: t.id, type: t.type, status: t.status, createdAt: t.createdAt, resolvedAt: t.resolvedAt, resolvedBy: t.resolvedById ? { id: t.resolvedById, name: uname.get(t.resolvedById) ?? null } : null,
        contract: c ? { id: c.id, number: c.number, currency: c.currency, amount: c.amount.toFixed(2), openingPaid: c.openingPaid.toFixed(2), sourcePaid: c.sourcePaid?.toFixed(2) ?? null, supplier: c.supplier } : null,
        changes, sourceRow: (t.details as any)?.row ?? null,
        delta: delta ? money(delta).toFixed(2) : null,
        candidates: candidates.map((p) => ({ id: p.id, paymentDate: p.paymentDate.toISOString().slice(0, 10), amount: p.amount.toFixed(2), bankDocument: p.bankDocument, transactionNo: p.transactionNo })),
        suggestedPaymentIds: suggested, resolution: t.resolution,
      };
    });
  }

  @Get()
  @RequirePermission('reconciliation.view')
  async list(@Query() raw: Record<string, string>) {
    const q = parse(listQuery, raw);
    const where: Prisma.ReconciliationTaskWhereInput = { ...(q.status ? { status: q.status } : {}), ...(q.open === 'true' ? { status: { in: ['PENDING', 'MATCHED'] } } : q.open === 'false' ? { status: { in: ['CONFIRMED', 'REJECTED'] } } : {}) };
    const [total, items] = await Promise.all([
      this.prisma.reconciliationTask.count({ where }),
      this.prisma.reconciliationTask.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    return { total, page: q.page, pageSize: q.pageSize, items: await this.enrich(items) };
  }

  @Get('stats')
  @RequirePermission('reconciliation.view')
  async stats() {
    const [byStatus, pendingPayments, dups] = await Promise.all([
      this.prisma.reconciliationTask.groupBy({ by: ['status'], _count: true }),
      this.prisma.payment.count({ where: { status: 'PENDING' } }),
      this.duplicateGroups(),
    ]);
    return { byStatus: Object.fromEntries(byStatus.map((s) => [s.status, s._count])), pendingPayments, duplicateGroups: dups.length };
  }

  /** Возможные дубликаты платежей: тот же договор + дата + сумма, либо один банковский номер у поставщика. Исправляются сторно. */
  private async duplicateGroups() {
    const reversed = new Set((await this.prisma.payment.findMany({ where: { reversesPaymentId: { not: null } }, select: { reversesPaymentId: true } })).map((r) => r.reversesPaymentId!));
    const ps = (await this.prisma.payment.findMany({
      where: { status: { in: ['PENDING', 'APPROVED'] }, kind: { in: ['PAYMENT', 'REFUND'] } }, include: { contract: { select: { id: true, number: true, supplier: { select: { id: true, name: true } } } } },
    })).filter((p) => !reversed.has(p.id));
    const groups = new Map<string, { reason: string; items: typeof ps }>();
    const add = (key: string, reason: string, p: (typeof ps)[number]) => { const g = groups.get(key) ?? { reason, items: [] }; if (!g.items.includes(p)) g.items.push(p); groups.set(key, g); };
    const seen = new Map<string, (typeof ps)[number]>(), seenTx = new Map<string, (typeof ps)[number]>();
    for (const p of ps) {
      const k = `${p.contractId}|${p.kind}|${p.amount.toFixed(2)}|${p.paymentDate.toISOString().slice(0, 10)}`;
      if (seen.has(k)) { add(`a:${k}`, 'тот же договор, дата и сумма', seen.get(k)!); add(`a:${k}`, 'тот же договор, дата и сумма', p); } else seen.set(k, p);
      if (p.transactionNo) {
        const t = `${p.contract.supplier.id}|${p.transactionNo}`;
        if (seenTx.has(t)) { add(`t:${t}`, 'один номер транзакции', seenTx.get(t)!); add(`t:${t}`, 'один номер транзакции', p); } else seenTx.set(t, p);
      }
    }
    return [...groups.values()].map((g) => ({
      reason: g.reason,
      payments: g.items.map((p) => ({ id: p.id, status: p.status, kind: p.kind, paymentDate: p.paymentDate.toISOString().slice(0, 10), amount: p.amount.toFixed(2), currency: p.currency, transactionNo: p.transactionNo, bankDocument: p.bankDocument, contract: { id: p.contract.id, number: p.contract.number }, supplier: p.contract.supplier })),
    }));
  }

  @Get('duplicates')
  @RequirePermission('reconciliation.view')
  duplicates() { return this.duplicateGroups(); }

  @Get(':id')
  @RequirePermission('reconciliation.view')
  async get(@Param('id', ParseUUIDPipe) id: string) {
    const t = await this.prisma.reconciliationTask.findUnique({ where: { id } });
    if (!t) throw new NotFoundException('Задача сверки не найдена');
    const history = await this.prisma.auditLog.findMany({ where: { entity: 'ReconciliationTask', entityId: id }, orderBy: { id: 'desc' } });
    return { ...(await this.enrich([t]))[0], history: history.map((h) => ({ ...h, id: h.id.toString() })) };
  }

  private async load(id: string) {
    const t = await this.prisma.reconciliationTask.findUnique({ where: { id } });
    if (!t) throw new NotFoundException('Задача сверки не найдена');
    if (t.status === 'CONFIRMED' || t.status === 'REJECTED') throw new ConflictException('Задача уже закрыта');
    return t;
  }

  private async validatePayments(tx: Prisma.TransactionClient | PrismaService, contractId: string, ids: string[]) {
    if (!ids.length) return [];
    const ps = await tx.payment.findMany({ where: { id: { in: ids } } });
    if (ps.length !== new Set(ids).size) throw new BadRequestException('Платёж не найден');
    for (const p of ps) if (p.contractId !== contractId || p.status !== 'APPROVED' || p.kind !== 'PAYMENT' || p.reflectedInOpening) throw new BadRequestException('Для сопоставления подходят только подтверждённые оплаты этого договора, ещё не учтённые в начальном остатке');
    return ps;
  }

  @Post(':id/match')
  @RequirePermission('reconciliation.resolve')
  async match(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @ClientIp() ip: string | null) {
    const d = parse(z.object({ paymentIds: z.array(z.string().uuid()).max(50), note: z.string().trim().max(500).optional() }), body);
    const t = await this.load(id);
    await this.validatePayments(this.prisma, t.contractId!, d.paymentIds);
    const upd = await this.prisma.reconciliationTask.update({ where: { id }, data: { status: 'MATCHED', resolution: { paymentIds: d.paymentIds, note: d.note ?? null, matchedById: u.id } } });
    await this.audit.log({ userId: u.id, userEmail: u.email, action: 'reconciliation.match', entity: 'ReconciliationTask', entityId: id, after: upd.resolution, meta: { contractId: t.contractId }, ip });
    return (await this.enrich([upd]))[0];
  }

  /**
   * Подтверждение: применяет данные источника к договору. Выбранные платежи помечаются «учтены в начальном остатке»,
   * поэтому не вычитаются из долга второй раз. Расхождение между приростом в источнике и выбранными платежами
   * требует явного подтверждения и записывается в журнал.
   */
  @Post(':id/confirm')
  @RequirePermission('reconciliation.resolve')
  async confirm(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @ClientIp() ip: string | null) {
    const d = parse(z.object({ paymentIds: z.array(z.string().uuid()).max(50).optional(), acceptDifference: z.boolean().default(false), note: z.string().trim().max(500).optional() }), body ?? {});
    const out = await this.prisma.$transaction(async (tx) => {
      const probe = await tx.reconciliationTask.findUnique({ where: { id } });
      if (!probe?.contractId) throw new NotFoundException('Задача сверки не найдена');
      await tx.$queryRaw`SELECT id FROM "Contract" WHERE id = ${probe.contractId} FOR UPDATE`;
      const t = await tx.reconciliationTask.findUniqueOrThrow({ where: { id } });
      if (t.status === 'CONFIRMED' || t.status === 'REJECTED') throw new ConflictException('Задача уже закрыта');
      const c = await tx.contract.findUniqueOrThrow({ where: { id: t.contractId! } });
      const changes = ((t.details as any).changes ?? []) as Change[];
      const ids = d.paymentIds ?? ((t.resolution as any)?.paymentIds as string[] | undefined) ?? [];
      const picked = await this.validatePayments(tx, c.id, ids);
      const pickedSum = picked.reduce((a, p) => a.plus(p.amount.toString()), dec(0));
      const data: Prisma.ContractUpdateInput = {};
      let difference = dec(0);

      for (const ch of changes) {
        if (ch.field === 'openingPaid' && ch.to != null) {
          const delta = dec(ch.to).minus(c.openingPaid.toString());
          if (delta.gt(0)) {
            if (pickedSum.gt(delta)) throw new BadRequestException(`Выбранные платежи (${money(pickedSum).toFixed(2)}) больше прироста «Оплачено» в источнике (${money(delta).toFixed(2)}) — это привело бы к двойному учёту`);
            difference = delta.minus(pickedSum);
          } else if (delta.lt(0)) {
            if (picked.length) throw new BadRequestException('Источник уменьшил «Оплачено» — сопоставлять платежи не нужно');
            difference = delta;
          }
          if (!difference.isZero() && !d.acceptDifference) {
            throw new ConflictException({
              message: delta.gt(0) ? `В источнике оплачено больше на ${money(delta).toFixed(2)}, сопоставлено платежами ${money(pickedSum).toFixed(2)}. Неопознанный остаток: ${money(difference).toFixed(2)} ${c.currency}. Подтвердите явно, что принимаете его как историческую оплату.`
                : `Источник УМЕНЬШИЛ «Оплачено» на ${money(delta.abs()).toFixed(2)} ${c.currency}. Подтвердите явно.`,
              code: 'RECON_DIFFERENCE', difference: money(difference).toFixed(2),
            });
          }
          data.openingPaid = ch.to; data.sourcePaid = ch.to;
        }
        if (ch.field === 'amount' && ch.to != null) data.amount = ch.to;
        if (ch.field === 'currency' && ch.to) {
          if (await tx.payment.count({ where: { contractId: c.id, status: { in: ['PENDING', 'APPROVED'] } } })) throw new BadRequestException('По договору есть платежи — изменение валюты невозможно');
          data.currency = ch.to as 'USD';
        }
      }
      if (d.paymentIds === undefined && !ids.length) { /* подтверждение без платежей допустимо: тогда весь прирост — историческая оплата (потребует acceptDifference выше) */ }
      for (const p of picked) await tx.payment.update({ where: { id: p.id }, data: { reflectedInOpening: true, reflectedTaskId: id } });
      if (Object.keys(data).length) await tx.contract.update({ where: { id: c.id }, data });
      const resolution = { decision: 'ACCEPT_SOURCE', paymentIds: picked.map((p) => p.id), matchedAmount: money(pickedSum).toFixed(2), difference: money(difference).toFixed(2), acceptedDifference: !difference.isZero(), note: d.note ?? (t.resolution as any)?.note ?? null };
      const upd = await tx.reconciliationTask.update({ where: { id }, data: { status: 'CONFIRMED', resolution, resolvedById: u.id, resolvedAt: new Date() } });
      await this.audit.log({ userId: u.id, userEmail: u.email, action: 'reconciliation.confirm', entity: 'ReconciliationTask', entityId: id, before: { contract: { openingPaid: c.openingPaid, amount: c.amount, currency: c.currency } }, after: { applied: data, resolution }, meta: { contractId: c.id }, ip }, tx);
      return upd;
    });
    return (await this.enrich([out]))[0];
  }

  /** Отклонение: данные приложения остаются; значение источника запоминается, чтобы то же значение не создавало задачу снова. */
  @Post(':id/reject')
  @RequirePermission('reconciliation.resolve')
  async reject(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @ClientIp() ip: string | null) {
    const { reason } = parse(z.object({ reason: z.string().trim().min(3).max(500) }), body);
    const out = await this.prisma.$transaction(async (tx) => {
      const t = await this.load(id);
      const paid = (((t.details as any).changes ?? []) as Change[]).find((x) => x.field === 'openingPaid');
      if (t.contractId && paid?.to != null) await tx.contract.update({ where: { id: t.contractId }, data: { sourcePaid: paid.to } });
      const upd = await tx.reconciliationTask.update({ where: { id }, data: { status: 'REJECTED', resolution: { decision: 'KEEP_APP_DATA', reason }, resolvedById: u.id, resolvedAt: new Date() } });
      await this.audit.log({ userId: u.id, userEmail: u.email, action: 'reconciliation.reject', entity: 'ReconciliationTask', entityId: id, meta: { reason, contractId: t.contractId }, ip }, tx);
      return upd;
    });
    return (await this.enrich([out]))[0];
  }
}
