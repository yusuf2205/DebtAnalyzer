import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, Res, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { createReadStream } from 'node:fs';
import { resolve } from 'node:path';
import { storeDocument } from '../common/documents';
import { loadConfig } from '../config';
import type { Response } from 'express';
import { Prisma, type Payment } from '@prisma/client';
import { z } from 'zod';
import { CURRENCIES, dec, money } from '@pf/shared';
import { AuditService } from '../audit/audit.service';
import { ClientIp, CurrentUser, RequirePermission } from '../auth/decorators';
import type { AuthUser } from '../common/types';
import { sendXlsx } from '../common/xlsx';
import { parse } from '../common/zod';
import { PrismaService } from '../prisma/prisma.service';

const money2 = z.string().regex(/^\d{1,20}(\.\d{1,2})?$/, 'Сумма: число не более чем с 2 знаками после запятой').refine((s) => Number(s) > 0, 'Сумма должна быть больше нуля');
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => !Number.isNaN(Date.parse(s)), 'Некорректная дата');
const opt = (n: number) => z.string().trim().max(n).optional();
const today = () => new Date().toISOString().slice(0, 10);

const fields = {
  paymentDate: dateStr.refine((d) => d <= today(), 'Дата платежа не может быть в будущем'),
  amount: money2, kind: z.enum(['PAYMENT', 'REFUND']).default('PAYMENT'),
  bankDocument: opt(200), transactionNo: opt(100), comment: opt(1000),
};
const createSchema = z.object({ contractId: z.string().uuid(), ...fields, idempotencyKey: z.string().uuid(), submit: z.boolean().default(false), confirmDuplicate: z.boolean().default(false) });
const updateSchema = z.object({ ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, (v as z.ZodTypeAny).optional()])), confirmDuplicate: z.boolean().default(false) }).strict() as z.ZodObject<any>;

const listQuery = z.object({
  status: z.enum(['DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']).optional(), kind: z.enum(['PAYMENT', 'REFUND', 'REVERSAL']).optional(),
  contractId: z.string().uuid().optional(), supplierId: z.string().uuid().optional(), currency: z.enum(CURRENCIES).optional(),
  from: dateStr.optional(), to: dateStr.optional(), q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(500).default(50),
});

const include = { contract: { select: { id: true, number: true, status: true, currency: true, amount: true, supplier: { select: { id: true, name: true } } } } } satisfies Prisma.PaymentInclude;
type PaymentFull = Prisma.PaymentGetPayload<{ include: typeof include }>;

export const signedFor = (kind: 'PAYMENT' | 'REFUND', amount: Prisma.Decimal | string) => (kind === 'PAYMENT' ? dec(amount.toString()) : dec(amount.toString()).neg());

@Controller('payments')
export class PaymentsController {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  // ---- представление ----
  private async enrich(items: PaymentFull[]) {
    const ids = items.map((p) => p.id);
    const users = await this.prisma.user.findMany({ where: { id: { in: [...new Set(items.flatMap((p) => [p.createdById, p.approvedById, p.rejectedById]).filter(Boolean) as string[])] } }, select: { id: true, name: true } });
    const name = new Map(users.map((u) => [u.id, u.name]));
    const reversals = await this.prisma.payment.findMany({ where: { reversesPaymentId: { in: ids } }, select: { id: true, reversesPaymentId: true } });
    const reversedBy = new Map(reversals.map((r) => [r.reversesPaymentId!, r.id]));
    const docCounts = new Map((await this.prisma.paymentDocument.groupBy({ by: ['paymentId'], where: { paymentId: { in: ids }, deletedAt: null }, _count: true })).map((d) => [d.paymentId, d._count]));
    return items.map((p) => ({
      id: p.id, contract: { id: p.contract.id, number: p.contract.number, status: p.contract.status }, supplier: p.contract.supplier, paymentDate: p.paymentDate.toISOString().slice(0, 10),
      amount: p.amount.toFixed(2), currency: p.currency, kind: p.kind, status: p.status, signedAmount: p.signedAmount?.toFixed(2) ?? null,
      bankDocument: p.bankDocument, transactionNo: p.transactionNo, comment: p.comment,
      createdBy: { id: p.createdById, name: name.get(p.createdById) ?? null }, createdAt: p.createdAt, submittedAt: p.submittedAt,
      approvedBy: p.approvedById ? { id: p.approvedById, name: name.get(p.approvedById) ?? null } : null, approvedAt: p.approvedAt,
      rejectedBy: p.rejectedById ? { id: p.rejectedById, name: name.get(p.rejectedById) ?? null } : null, rejectReason: p.rejectReason,
      reflectedInOpening: p.reflectedInOpening, reversesPaymentId: p.reversesPaymentId, reversalReason: p.reversalReason, correctsPaymentId: p.correctsPaymentId,
      reversedByPaymentId: reversedBy.get(p.id) ?? null, documentCount: docCounts.get(p.id) ?? 0,
    }));
  }

  private async one(id: string): Promise<PaymentFull> {
    const p = await this.prisma.payment.findUnique({ where: { id }, include });
    if (!p) throw new NotFoundException('Платёж не найден');
    return p;
  }

  private async conflicts(tx: Prisma.TransactionClient | PrismaService, contract: { id: string; supplierId: string }, d: { transactionNo?: string | null; amount: string; paymentDate: string; kind: string }, ignore: string[], confirmDuplicate: boolean) {
    const live = { status: { in: ['DRAFT', 'PENDING', 'APPROVED'] as ('DRAFT' | 'PENDING' | 'APPROVED')[] }, id: { notIn: ignore } };
    if (d.transactionNo) {
      const reversed = (await tx.payment.findMany({ where: { reversesPaymentId: { not: null } }, select: { reversesPaymentId: true } })).map((r) => r.reversesPaymentId!);
      const same = await tx.payment.findFirst({ where: { ...live, id: { notIn: [...ignore, ...reversed] }, transactionNo: d.transactionNo, contract: { supplierId: contract.supplierId } } });
      if (same) throw new ConflictException({ message: `Платёж с номером транзакции «${d.transactionNo}» уже зарегистрирован`, code: 'DUPLICATE_TRANSACTION', paymentId: same.id });
    }
    if (!confirmDuplicate) {
      const like = await tx.payment.findFirst({ where: { ...live, contractId: contract.id, amount: d.amount, paymentDate: new Date(d.paymentDate), kind: d.kind as 'PAYMENT' } });
      if (like) throw new ConflictException({ message: 'Похожий платёж (тот же договор, дата и сумма) уже есть. Если это действительно второй платёж, подтвердите.', code: 'DUPLICATE_SUSPECT', paymentId: like.id });
    }
  }

  // ---- чтение ----
  private where(q: z.infer<typeof listQuery>): Prisma.PaymentWhereInput {
    return {
      status: q.status, kind: q.kind, contractId: q.contractId, currency: q.currency,
      ...(q.supplierId ? { contract: { supplierId: q.supplierId } } : {}),
      ...(q.from || q.to ? { paymentDate: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) } } : {}),
      ...(q.q ? { OR: [{ bankDocument: { contains: q.q, mode: 'insensitive' } }, { transactionNo: { contains: q.q, mode: 'insensitive' } }, { comment: { contains: q.q, mode: 'insensitive' } },
        { contract: { number: { contains: q.q, mode: 'insensitive' } } }, { contract: { supplier: { name: { contains: q.q, mode: 'insensitive' } } } }] } : {}),
    };
  }

  @Get()
  @RequirePermission('payments.view')
  async list(@Query() raw: Record<string, string>) {
    const q = parse(listQuery, raw);
    const where = this.where(q);
    const [total, items, byStatus, sums] = await Promise.all([
      this.prisma.payment.count({ where }),
      this.prisma.payment.findMany({ where, include, orderBy: [{ paymentDate: 'desc' }, { createdAt: 'desc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      this.prisma.payment.groupBy({ by: ['status'], where: { ...where, status: undefined }, _count: true }),
      this.prisma.payment.groupBy({ by: ['currency', 'status'], where: { ...where, status: q.status ?? undefined }, _sum: { signedAmount: true, amount: true } }),
    ]);
    return {
      total, page: q.page, pageSize: q.pageSize, byStatus: Object.fromEntries(byStatus.map((s) => [s.status, s._count])),
      // Итоги по валютам: подтверждённая чистая оплата и сумма ожидающих подтверждения. Валюты не складываются.
      totals: CURRENCIES.map((c) => ({
        currency: c,
        approvedNet: money(sums.filter((s) => s.currency === c && s.status === 'APPROVED').reduce((a, s) => a.plus(s._sum.signedAmount?.toString() ?? 0), dec(0))).toFixed(2),
        pending: money(sums.filter((s) => s.currency === c && s.status === 'PENDING').reduce((a, s) => a.plus(s._sum.amount?.toString() ?? 0), dec(0))).toFixed(2),
      })).filter((t) => Number(t.approvedNet) || Number(t.pending)),
      items: await this.enrich(items),
    };
  }

  @Get('export')
  @RequirePermission('reports.export')
  async export(@Query() raw: Record<string, string>, @Res() res: Response, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) {
    const q = parse(listQuery, raw);
    const items = await this.enrich(await this.prisma.payment.findMany({ where: this.where(q), include, orderBy: [{ paymentDate: 'desc' }, { createdAt: 'desc' }], take: 20000 }));
    await this.audit.log({ userId: u.id, userEmail: u.email, action: 'export.payments', entity: 'Payment', meta: { filters: q, rows: items.length }, ip });
    const ST: Record<string, string> = { DRAFT: 'Черновик', PENDING: 'Ожидает подтверждения', APPROVED: 'Подтверждён', REJECTED: 'Отклонён', CANCELLED: 'Отменён' };
    const KD: Record<string, string> = { PAYMENT: 'Оплата', REFUND: 'Возврат', REVERSAL: 'Сторно' };
    await sendXlsx(res, 'Платежи.xlsx', 'Платежи', [
      { header: 'Дата', key: 'date', width: 12 }, { header: 'Контрагент', key: 'supplier', width: 40 }, { header: 'Договор', key: 'contract', width: 40 }, { header: 'Тип', key: 'kind', width: 10 },
      { header: 'Статус', key: 'status', width: 22 }, { header: 'Валюта', key: 'currency', width: 9 }, { header: 'Сумма', key: 'amount', width: 18, type: 'money' }, { header: 'Влияние на оплату', key: 'signed', width: 18, type: 'money' },
      { header: 'Банковский документ', key: 'bank', width: 24 }, { header: 'Номер транзакции', key: 'tx', width: 22 }, { header: 'Создал', key: 'by', width: 20 }, { header: 'Подтвердил', key: 'appr', width: 20 }, { header: 'Дата подтверждения', key: 'apprAt', width: 18, type: 'date' }, { header: 'Комментарий', key: 'comment', width: 36 },
    ], items.map((p) => ({ date: new Date(p.paymentDate), supplier: p.supplier.name, contract: p.contract.number, kind: KD[p.kind], status: ST[p.status], currency: p.currency, amount: p.amount, signed: p.signedAmount, bank: p.bankDocument, tx: p.transactionNo, by: p.createdBy.name, appr: p.approvedBy?.name, apprAt: p.approvedAt, comment: p.comment })));
  }

  @Get(':id')
  @RequirePermission('payments.view')
  async get(@Param('id', ParseUUIDPipe) id: string) {
    const p = await this.one(id);
    const [view] = await this.enrich([p]);
    const history = await this.prisma.auditLog.findMany({ where: { entity: 'Payment', entityId: id }, orderBy: { id: 'desc' }, take: 100 });
    const documents = await this.prisma.paymentDocument.findMany({ where: { paymentId: id, deletedAt: null }, orderBy: { createdAt: 'desc' } });
    return { ...view, documents: documents.map((x) => ({ id: x.id, filename: x.filename, size: x.size, sha256: x.sha256, createdAt: x.createdAt, uploadedById: x.uploadedById })), history: history.map((h) => ({ ...h, id: h.id.toString() })) };
  }

  // ---- создание и редактирование ----
  @Post()
  @RequirePermission('payments.create')
  async create(@CurrentUser() u: AuthUser, @Body() body: unknown, @ClientIp() ip: string | null) {
    const d = parse(createSchema, body);
    // Идемпотентность: повторная отправка той же формы возвращает уже созданный платёж, а не создаёт второй.
    const existing = await this.prisma.payment.findUnique({ where: { idempotencyKey: d.idempotencyKey }, include });
    if (existing) {
      if (existing.createdById !== u.id) throw new ConflictException('Ключ идемпотентности уже использован');
      return { ...(await this.enrich([existing]))[0], idempotentReplay: true };
    }
    const contract = await this.prisma.contract.findUnique({ where: { id: d.contractId } });
    if (!contract) throw new BadRequestException('Договор не найден');
    if (contract.status !== 'ACTIVE') throw new BadRequestException('Договор в архиве — платежи по нему регистрировать нельзя');
    try { await this.conflicts(this.prisma, contract, d, [], d.confirmDuplicate); }
    catch (e) {
      // Гонка двойного нажатия: параллельный запрос с тем же ключом уже создал платёж — возвращаем его, а не «дубликат».
      const again = await this.prisma.payment.findUnique({ where: { idempotencyKey: d.idempotencyKey }, include });
      if (again && again.createdById === u.id) return { ...(await this.enrich([again]))[0], idempotentReplay: true };
      throw e;
    }
    let created: Payment;
    try {
      created = await this.prisma.payment.create({
        data: {
          contractId: d.contractId, paymentDate: new Date(d.paymentDate), amount: d.amount, currency: contract.currency, // валюта платежа = валюта договора
          kind: d.kind, status: d.submit ? 'PENDING' : 'DRAFT', submittedAt: d.submit ? new Date() : null,
          bankDocument: d.bankDocument || null, transactionNo: d.transactionNo || null, comment: d.comment || null, createdById: u.id, idempotencyKey: d.idempotencyKey,
        },
      });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') { // гонка двух одинаковых запросов
        const again = await this.prisma.payment.findUnique({ where: { idempotencyKey: d.idempotencyKey }, include });
        if (again) return { ...(await this.enrich([again]))[0], idempotentReplay: true };
        throw new ConflictException('Платёж с таким номером транзакции уже зарегистрирован');
      }
      throw e;
    }
    await this.audit.log({ userId: u.id, userEmail: u.email, action: 'payment.create', entity: 'Payment', entityId: created.id, after: created, ip });
    return (await this.enrich([await this.one(created.id)]))[0];
  }

  @Patch(':id')
  @RequirePermission('payments.create')
  async update(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @ClientIp() ip: string | null) {
    const d = parse(updateSchema, body) as Record<string, any>;
    const before = await this.one(id);
    if (before.createdById !== u.id && u.role !== 'SUPER_ADMIN') throw new ForbiddenException('Редактировать можно только свои платежи');
    if (before.status !== 'DRAFT' && before.status !== 'REJECTED') throw new BadRequestException('Редактировать можно только черновик или отклонённый платёж. Подтверждённый исправляется сторно.');
    const { confirmDuplicate, ...rest } = d;
    const next = { transactionNo: rest.transactionNo ?? before.transactionNo, amount: rest.amount ?? before.amount.toFixed(2), paymentDate: rest.paymentDate ?? before.paymentDate.toISOString().slice(0, 10), kind: rest.kind ?? before.kind };
    await this.conflicts(this.prisma, { id: before.contractId, supplierId: before.contract.supplier.id }, next, [id], confirmDuplicate);
    const after = await this.prisma.payment.update({
      where: { id }, data: {
        ...(rest.paymentDate ? { paymentDate: new Date(rest.paymentDate) } : {}), ...(rest.amount ? { amount: rest.amount } : {}), ...(rest.kind ? { kind: rest.kind } : {}),
        ...('bankDocument' in rest ? { bankDocument: rest.bankDocument || null } : {}), ...('transactionNo' in rest ? { transactionNo: rest.transactionNo || null } : {}), ...('comment' in rest ? { comment: rest.comment || null } : {}),
        ...(before.status === 'REJECTED' ? { status: 'DRAFT', rejectReason: null, rejectedById: null, rejectedAt: null } : {}),
      },
    });
    await this.audit.log({ userId: u.id, userEmail: u.email, action: 'payment.update', entity: 'Payment', entityId: id, before, after, ip });
    return (await this.enrich([await this.one(id)]))[0];
  }

  // ---- переходы статусов ----
  private async transition(id: string, from: ('DRAFT' | 'PENDING' | 'REJECTED')[], data: Prisma.PaymentUpdateManyMutationInput) {
    // Атомарный переход: защищает от двойного нажатия и гонок.
    const r = await this.prisma.payment.updateMany({ where: { id, status: { in: from } }, data });
    if (r.count !== 1) throw new ConflictException('Статус платежа уже изменён — обновите страницу');
  }

  @Post(':id/submit')
  @RequirePermission('payments.create')
  async submit(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip: string | null) {
    const p = await this.one(id);
    if (p.createdById !== u.id && u.role !== 'SUPER_ADMIN') throw new ForbiddenException('Передать на подтверждение можно только свой платёж');
    if (p.contract.status !== 'ACTIVE') throw new BadRequestException('Договор в архиве');
    await this.transition(id, ['DRAFT'], { status: 'PENDING', submittedAt: new Date() });
    await this.audit.log({ userId: u.id, userEmail: u.email, action: 'payment.submit', entity: 'Payment', entityId: id, before: { status: p.status }, after: { status: 'PENDING' }, ip });
    return (await this.enrich([await this.one(id)]))[0];
  }

  @Post(':id/approve')
  @RequirePermission('payments.approve')
  async approve(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @ClientIp() ip: string | null) {
    const { confirmOverpayment } = parse(z.object({ confirmOverpayment: z.boolean().default(false) }), body ?? {});
    const result = await this.prisma.$transaction(async (tx) => {
      const probe = await tx.payment.findUnique({ where: { id } });
      if (!probe) throw new NotFoundException('Платёж не найден');
      // Блокируем договор: два одновременных подтверждения не должны вместе «пробить» лимит переплаты.
      await tx.$queryRaw`SELECT id FROM "Contract" WHERE id = ${probe.contractId} FOR UPDATE`;
      const p = await tx.payment.findUniqueOrThrow({ where: { id } });
      if (p.status !== 'PENDING') throw new ConflictException('Платёж не ожидает подтверждения');
      const policy = (await tx.appSetting.findUnique({ where: { key: 'paymentPolicy' } }))?.value as { requireDocument?: boolean } | null | undefined;
      if (policy?.requireDocument && (await tx.paymentDocument.count({ where: { paymentId: id, deletedAt: null } })) === 0) {
        throw new BadRequestException({ message: 'По правилам организации для подтверждения нужен документ: приложите платёжное поручение или выписку', code: 'DOCUMENT_REQUIRED' });
      }
      const self = p.createdById === u.id;
      if (self && u.role !== 'SUPER_ADMIN') throw new ForbiddenException('Платёж не может подтверждать тот, кто его создал');
      const c = await tx.contract.findUniqueOrThrow({ where: { id: p.contractId } });
      if (c.status !== 'ACTIVE') throw new BadRequestException('Договор в архиве');
      if (p.currency !== c.currency) throw new BadRequestException('Валюта платежа не совпадает с валютой договора');
      const agg = await tx.payment.aggregate({ _sum: { signedAmount: true }, where: { contractId: c.id, status: 'APPROVED', reflectedInOpening: false } });
      const signed = signedFor(p.kind as 'PAYMENT' | 'REFUND', p.amount);
      const total = dec(c.openingPaid.toString()).plus(agg._sum.signedAmount?.toString() ?? 0).plus(signed);
      if (p.kind === 'REFUND' && total.lt(0)) throw new BadRequestException('Возврат превышает сумму произведённых оплат по договору');
      const over = total.minus(c.amount.toString());
      if (p.kind === 'PAYMENT' && over.gt(0) && !confirmOverpayment) {
        throw new ConflictException({ message: `Платёж приведёт к переплате ${money(over).toFixed(2)} ${c.currency}. Подтвердите переплату явно.`, code: 'OVERPAYMENT', overpaid: money(over).toFixed(2) });
      }
      const upd = await tx.payment.update({ where: { id }, data: { status: 'APPROVED', approvedById: u.id, approvedAt: new Date(), signedAmount: signed.toFixed(2) } });
      await this.audit.log({ userId: u.id, userEmail: u.email, action: 'payment.approve', entity: 'Payment', entityId: id, before: { status: 'PENDING' }, after: { status: 'APPROVED', signedAmount: signed.toFixed(2) }, meta: { selfApproved: self, overpaid: over.gt(0) ? money(over).toFixed(2) : null, contractId: c.id }, ip }, tx);
      return upd;
    });
    return (await this.enrich([await this.one(result.id)]))[0];
  }

  @Post(':id/reject')
  @RequirePermission('payments.approve')
  async reject(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @ClientIp() ip: string | null) {
    const { reason } = parse(z.object({ reason: z.string().trim().min(3).max(500) }), body);
    await this.one(id);
    await this.transition(id, ['PENDING'], { status: 'REJECTED', rejectedById: u.id, rejectedAt: new Date(), rejectReason: reason });
    await this.audit.log({ userId: u.id, userEmail: u.email, action: 'payment.reject', entity: 'Payment', entityId: id, after: { status: 'REJECTED' }, meta: { reason }, ip });
    return (await this.enrich([await this.one(id)]))[0];
  }

  @Post(':id/cancel')
  @RequirePermission('payments.create')
  async cancel(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @ClientIp() ip: string | null) {
    const { reason } = parse(z.object({ reason: z.string().trim().max(500).optional() }), body ?? {});
    const p = await this.one(id);
    if (p.status === 'APPROVED') throw new BadRequestException('Подтверждённый платёж отменить нельзя — сделайте сторно');
    if (p.createdById !== u.id && !u.permissions.includes('payments.approve')) throw new ForbiddenException('Отменить можно только свой платёж');
    await this.transition(id, ['DRAFT', 'PENDING', 'REJECTED'], { status: 'CANCELLED' });
    await this.audit.log({ userId: u.id, userEmail: u.email, action: 'payment.cancel', entity: 'Payment', entityId: id, before: { status: p.status }, after: { status: 'CANCELLED' }, meta: { reason: reason ?? null }, ip });
    return (await this.enrich([await this.one(id)]))[0];
  }

  /** Сторно подтверждённого платежа: отдельная неизменяемая запись, оригинал остаётся в истории. */
  private async createReversal(tx: Prisma.TransactionClient, u: AuthUser, orig: Payment, reason: string, ip: string | null) {
    await tx.$queryRaw`SELECT id FROM "Contract" WHERE id = ${orig.contractId} FOR UPDATE`;
    const fresh = await tx.payment.findUniqueOrThrow({ where: { id: orig.id } });
    if (fresh.status !== 'APPROVED' || fresh.kind === 'REVERSAL') throw new BadRequestException('Сторнировать можно только подтверждённую оплату или возврат');
    if (await tx.payment.findUnique({ where: { reversesPaymentId: orig.id } })) throw new ConflictException('Платёж уже сторнирован');
    const c = await tx.contract.findUniqueOrThrow({ where: { id: orig.contractId } });
    const agg = await tx.payment.aggregate({ _sum: { signedAmount: true }, where: { contractId: c.id, status: 'APPROVED', reflectedInOpening: false } });
    const signed = dec(fresh.signedAmount!.toString()).neg();
    if (dec(c.openingPaid.toString()).plus(agg._sum.signedAmount?.toString() ?? 0).plus(signed).lt(0)) throw new BadRequestException('Сторно приведёт к отрицательной сумме оплат по договору');
    const rev = await tx.payment.create({
      data: {
        contractId: orig.contractId, paymentDate: new Date(today()), amount: orig.amount, currency: orig.currency, kind: 'REVERSAL', status: 'APPROVED', createdById: u.id, approvedById: u.id, approvedAt: new Date(), submittedAt: new Date(),
        signedAmount: signed.toFixed(2), reversesPaymentId: orig.id, reversalReason: reason, idempotencyKey: `reverse:${orig.id}`, comment: `Сторно платежа от ${orig.paymentDate.toISOString().slice(0, 10)}: ${reason}`,
      },
    });
    await this.audit.log({ userId: u.id, userEmail: u.email, action: 'payment.reverse', entity: 'Payment', entityId: orig.id, meta: { reversalId: rev.id, reason, signedEffect: signed.toFixed(2) }, ip }, tx);
    return rev;
  }

  @Post(':id/reverse')
  @RequirePermission('payments.reverse')
  async reverse(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @ClientIp() ip: string | null) {
    const { reason } = parse(z.object({ reason: z.string().trim().min(3).max(500) }), body);
    const orig = await this.one(id);
    const rev = await this.prisma.$transaction((tx) => this.createReversal(tx, u, orig, reason, ip));
    return (await this.enrich([await this.one(rev.id)]))[0];
  }

  /** Исправление = сторно + новый платёж на подтверждение (в одной транзакции). */
  @Post(':id/correct')
  @RequirePermission('payments.reverse')
  async correct(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @ClientIp() ip: string | null) {
    const d = parse(z.object({ reason: z.string().trim().min(3).max(500), idempotencyKey: z.string().uuid(), ...Object.fromEntries(Object.entries(fields).filter(([k]) => k !== 'kind').map(([k, v]) => [k, (v as z.ZodTypeAny).optional()])) }).strict() as z.ZodObject<any>, body) as Record<string, any>;
    const orig = await this.one(id);
    if (orig.kind === 'REVERSAL') throw new BadRequestException('Сторно исправить нельзя');
    const replay = await this.prisma.payment.findUnique({ where: { idempotencyKey: d.idempotencyKey }, include });
    if (replay) return { ...(await this.enrich([replay]))[0], idempotentReplay: true };
    const out = await this.prisma.$transaction(async (tx) => {
      const rev = await this.createReversal(tx, u, orig, d.reason, ip);
      const next = {
        transactionNo: 'transactionNo' in d ? d.transactionNo || null : orig.transactionNo, amount: d.amount ?? orig.amount.toFixed(2), paymentDate: d.paymentDate ?? orig.paymentDate.toISOString().slice(0, 10), kind: orig.kind,
      };
      await this.conflicts(tx, { id: orig.contractId, supplierId: orig.contract.supplier.id }, next, [orig.id, rev.id], true);
      const np = await tx.payment.create({
        data: {
          contractId: orig.contractId, paymentDate: new Date(next.paymentDate), amount: next.amount, currency: orig.currency, kind: orig.kind === 'REFUND' ? 'REFUND' : 'PAYMENT', status: 'PENDING', submittedAt: new Date(),
          bankDocument: 'bankDocument' in d ? d.bankDocument || null : orig.bankDocument, transactionNo: next.transactionNo, comment: 'comment' in d ? d.comment || null : orig.comment,
          createdById: u.id, idempotencyKey: d.idempotencyKey, correctsPaymentId: orig.id,
        },
      });
      await this.audit.log({ userId: u.id, userEmail: u.email, action: 'payment.correct', entity: 'Payment', entityId: np.id, after: np, meta: { correctsPaymentId: orig.id, reversalId: rev.id, reason: d.reason }, ip }, tx);
      return np;
    });
    return (await this.enrich([await this.one(out.id)]))[0];
  }

  // ---- документы платежа ----
  private async docRights(u: AuthUser, p: Payment) {
    // Прикладывать может тот, кто создаёт платежи, и тот, кто их подтверждает (выписка часто приходит позже).
    if (!u.permissions.includes('payments.create') && !u.permissions.includes('payments.approve')) throw new ForbiddenException('Недостаточно прав');
    if (p.status === 'CANCELLED') throw new BadRequestException('Платёж отменён');
  }

  @Post(':id/documents')
  @RequirePermission('payments.view')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024, files: 1 } }))
  async uploadDoc(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @UploadedFile() file: Express.Multer.File, @ClientIp() ip: string | null) {
    const p = await this.prisma.payment.findUnique({ where: { id } });
    if (!p) throw new NotFoundException('Платёж не найден');
    await this.docRights(u, p);
    if (!file) throw new BadRequestException('Файл не передан');
    const stored = await storeDocument(file, loadConfig().UPLOAD_DIR);
    const doc = await this.prisma.paymentDocument.create({ data: { paymentId: id, ...stored, uploadedById: u.id } });
    await this.audit.log({ userId: u.id, userEmail: u.email, action: 'payment.document_add', entity: 'Payment', entityId: id, after: { documentId: doc.id, filename: doc.filename, size: doc.size, sha256: doc.sha256 }, ip });
    return { id: doc.id, filename: doc.filename, size: doc.size };
  }

  @Get(':id/documents/:docId')
  @RequirePermission('payments.view')
  async downloadDoc(@Param('id', ParseUUIDPipe) id: string, @Param('docId', ParseUUIDPipe) docId: string, @Res({ passthrough: true }) res: Response) {
    const doc = await this.prisma.paymentDocument.findFirst({ where: { id: docId, paymentId: id, deletedAt: null } });
    if (!doc) throw new NotFoundException('Документ не найден');
    res.setHeader('Content-Type', doc.mime);
    res.setHeader('Content-Disposition', `attachment; filename="document"; filename*=UTF-8''${encodeURIComponent(doc.filename)}`);
    return new StreamableFile(createReadStream(resolve(doc.path)));
  }

  /** Документ подтверждённого платежа удалить нельзя: он — основание подтверждения (для исправления есть сторно). */
  @Delete(':id/documents/:docId')
  @RequirePermission('payments.view')
  async removeDoc(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('docId', ParseUUIDPipe) docId: string, @ClientIp() ip: string | null) {
    const p = await this.prisma.payment.findUnique({ where: { id } });
    if (!p) throw new NotFoundException('Платёж не найден');
    await this.docRights(u, p);
    if (p.status === 'APPROVED') throw new BadRequestException('Документ подтверждённого платежа удалить нельзя — он основание подтверждения');
    const doc = await this.prisma.paymentDocument.findFirst({ where: { id: docId, paymentId: id, deletedAt: null } });
    if (!doc) throw new NotFoundException('Документ не найден');
    await this.prisma.paymentDocument.update({ where: { id: docId }, data: { deletedAt: new Date(), deletedById: u.id } });
    await this.audit.log({ userId: u.id, userEmail: u.email, action: 'payment.document_remove', entity: 'Payment', entityId: id, before: { documentId: docId, filename: doc.filename, sha256: doc.sha256 }, ip });
    return { ok: true };
  }
}
