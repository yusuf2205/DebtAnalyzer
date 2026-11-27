import {
  BadRequestException, Body, Controller, Delete, ForbiddenException, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, Res, StreamableFile, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { Prisma } from '@prisma/client';
import { effectiveOrigin } from '@pf/shared';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { CURRENCIES } from '@pf/shared';
import { DOC_TYPES } from '../common/documents';
import { AuditService } from '../audit/audit.service';
import { ClientIp, CurrentUser, RequirePermission } from '../auth/decorators';
import type { AuthUser } from '../common/types';
import { contractDebt, netPaidMap, summarize } from '../common/metrics';
import { sendXlsx } from '../common/xlsx';
import { parse } from '../common/zod';
import { loadConfig } from '../config';
import { PrismaService } from '../prisma/prisma.service';

const cfg = loadConfig();
const money2 = z.string().regex(/^\d{1,20}(\.\d{1,2})?$/, 'Сумма: число не более чем с 2 знаками после запятой');
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => !Number.isNaN(Date.parse(s)), 'Некорректная дата');

const listQuery = z.object({
  q: z.string().trim().max(100).optional(),
  supplierId: z.string().uuid().optional(),
  project: z.string().trim().max(100).optional(),
  executor: z.string().trim().max(100).optional(),
  currency: z.enum(CURRENCIES).optional(),
  status: z.enum(['ACTIVE', 'ARCHIVED', 'ALL']).default('ACTIVE'),
  state: z.enum(['UNPAID', 'PARTIAL', 'PAID', 'OVERPAID', 'OPEN']).optional(), // OPEN = есть долг
  origin: z.enum(['LOCAL', 'FOREIGN', 'UNSET']).optional(), // по действующему значению: подтверждённое, а если его нет — предложенное; UNSET — определить нельзя
  sort: z.enum(['number', 'supplier', 'project', 'amount', 'debt', 'date', 'created']).default('created'),
  dir: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
});


type ContractWithRels = Prisma.ContractGetPayload<{ include: { supplier: { select: { id: true; name: true } }; plans: { select: { amount: true } } } }>;

@Controller('contracts')
export class ContractsController {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  /** Происхождение: подтверждённое значение и предложение системы (признак — в shared/origin.ts). */
  private originInfo(c: { origin: 'LOCAL' | 'FOREIGN' | null; currency: string; supplier: { name: string; taxId?: string | null } }) {
    const e = effectiveOrigin({ origin: c.origin, currency: c.currency, supplierName: c.supplier.name, supplierTaxId: c.supplier.taxId });
    return { originSuggested: e.suggested, originEffective: e.value };
  }

  private view(c: ContractWithRels, newPaid?: Prisma.Decimal | null) {
    const d = contractDebt({ ...c, newPaid });
    const planned = c.plans.reduce((a, p) => a.plus(p.amount), new Prisma.Decimal(0));
    return {
      id: c.id, number: c.number, project: c.project, goods: c.goods, contractDate: c.contractDate?.toISOString().slice(0, 10) ?? null,
      supplier: c.supplier, currency: c.currency, amount: c.amount.toFixed(2), openingPaid: c.openingPaid.toFixed(2), newPaid: (newPaid ?? new Prisma.Decimal(0)).toFixed(2), paid: d.totalPaid.toFixed(2),
      debt: d.debt.toFixed(2), overpaid: d.overpaid.toFixed(2), state: d.state, planned: planned.toFixed(2), executor: c.executor, status: c.status, createdAt: c.createdAt,
      origin: c.origin, ...this.originInfo(c),
    };
  }

  private async query(q: z.infer<typeof listQuery>) {
    const where: Prisma.ContractWhereInput = {
      ...(q.status !== 'ALL' ? { status: q.status } : {}), supplierId: q.supplierId, currency: q.currency,
      ...(q.project ? { project: { contains: q.project, mode: 'insensitive' } } : {}),
      ...(q.executor ? { executor: { contains: q.executor, mode: 'insensitive' } } : {}),
      ...(q.q ? { OR: [
        { number: { contains: q.q, mode: 'insensitive' } }, { goods: { contains: q.q, mode: 'insensitive' } }, { project: { contains: q.q, mode: 'insensitive' } },
        { supplier: { name: { contains: q.q, mode: 'insensitive' } } }, { supplier: { aliases: { some: { alias: { contains: q.q, mode: 'insensitive' } } } } },
      ] } : {}),
    };
    const all = await this.prisma.contract.findMany({ where, include: { supplier: { select: { id: true, name: true, taxId: true } }, plans: { select: { amount: true } } } });
    const net = await netPaidMap(this.prisma, all.map((c) => c.id));
    let rows = all.map((c) => ({ raw: c, net: net.get(c.id) ?? null, v: this.view(c, net.get(c.id) ?? null) }));
    if (q.origin) rows = rows.filter((r) => (q.origin === 'UNSET' ? r.v.originEffective === null : r.v.originEffective === q.origin));
    if (q.state) rows = rows.filter((r) => (q.state === 'OPEN' ? Number(r.v.debt) > 0 : r.v.state === q.state));
    const key: Record<string, (r: (typeof rows)[number]) => string | number> = {
      number: (r) => r.v.number ?? '', supplier: (r) => r.v.supplier.name, project: (r) => r.v.project ?? '', amount: (r) => Number(r.v.amount), debt: (r) => Number(r.v.debt),
      date: (r) => r.v.contractDate ?? '', created: (r) => r.raw.createdAt.getTime(),
    };
    const k = key[q.sort], m = q.dir === 'asc' ? 1 : -1;
    rows.sort((a, b) => { const x = k(a), y = k(b); return (typeof x === 'number' ? x - (y as number) : String(x).localeCompare(String(y), 'ru')) * m; });
    return rows;
  }

  @Get()
  @RequirePermission('contracts.view')
  async list(@Query() raw: Record<string, string>) {
    const q = parse(listQuery, raw);
    const rows = await this.query(q);
    const start = (q.page - 1) * q.pageSize;
    return {
      total: rows.length, page: q.page, pageSize: q.pageSize,
      totals: summarize(rows.map((r) => ({ currency: r.raw.currency, amount: r.raw.amount, openingPaid: r.raw.openingPaid, newPaid: r.net, planned: r.v.planned }))),
      items: rows.slice(start, start + q.pageSize).map((r) => r.v),
    };
  }

  @Get('export')
  @RequirePermission('reports.export')
  async export(@Query() raw: Record<string, string>, @Res() res: Response, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) {
    const q = parse(listQuery, raw);
    const rows = await this.query(q);
    await this.audit.log({ userId: u.id, userEmail: u.email, action: 'export.contracts', entity: 'Contract', meta: { filters: q, rows: rows.length }, ip });
    const totals = summarize(rows.map((r) => ({ currency: r.raw.currency, amount: r.raw.amount, openingPaid: r.raw.openingPaid, newPaid: r.net, planned: r.v.planned })));
    await sendXlsx(res, 'Договоры.xlsx', 'Договоры', [
      { header: 'Договор', key: 'number', width: 44 }, { header: 'Дата', key: 'date', width: 12 }, { header: 'Контрагент', key: 'supplier', width: 40 }, { header: 'Проект', key: 'project', width: 26 },
      { header: 'Товар', key: 'goods', width: 30 }, { header: 'Валюта', key: 'currency', width: 9 }, { header: 'Сумма', key: 'amount', width: 18, type: 'money' },
      { header: 'Оплачено', key: 'paid', width: 18, type: 'money' }, { header: 'Долг', key: 'debt', width: 18, type: 'money' }, { header: 'Переплата', key: 'overpaid', width: 16, type: 'money' },
      { header: 'План', key: 'planned', width: 18, type: 'money' }, { header: 'Исполнитель', key: 'executor', width: 18 }, { header: 'Статус', key: 'status', width: 12 },
    ], rows.map(({ v }) => ({ number: v.number, date: v.contractDate ? new Date(v.contractDate) : null, supplier: v.supplier.name, project: v.project, goods: v.goods, currency: v.currency, amount: v.amount, paid: v.paid, debt: v.debt, overpaid: v.overpaid, planned: v.planned, executor: v.executor, status: v.status === 'ACTIVE' ? 'Активен' : 'Архив' })),
    totals.map((t) => ({ number: 'ИТОГО по валюте', currency: t.currency, amount: t.amount, paid: t.paid, debt: t.debt, overpaid: t.overpaid, planned: t.planned })));
  }

  @Get('facets')
  @RequirePermission('contracts.view')
  async facets() {
    const ex = await this.prisma.contract.findMany({ where: { executor: { not: null } }, select: { executor: true }, distinct: ['executor'] });
    return { executors: ex.map((e) => e.executor!.trim()).filter(Boolean).sort((a, b) => a.localeCompare(b, 'ru')) };
  }

  @Post()
  @RequirePermission('contracts.manage')
  async create(@CurrentUser() u: AuthUser, @Body() body: unknown, @ClientIp() ip: string | null) {
    const d = parse(z.object({
      supplierId: z.string().uuid(), number: z.string().trim().min(1).max(300), contractDate: dateStr.optional(), project: z.string().trim().max(300).optional(),
      goods: z.string().trim().max(500).optional(), amount: money2, currency: z.enum(CURRENCIES), openingPaid: money2.default('0'),
      executor: z.string().trim().max(100).optional(), notes: z.string().trim().max(4000).optional(),
    }), body);
    const sup = await this.prisma.supplier.findUnique({ where: { id: d.supplierId } });
    if (!sup || sup.status !== 'ACTIVE') throw new BadRequestException('Поставщик не найден или архивирован');
    if (new Prisma.Decimal(d.openingPaid).gt(d.amount)) throw new BadRequestException('Начальная оплата не может превышать сумму договора; переплату вносите через платежи');
    const c = await this.prisma.contract.create({
      data: { ...d, contractDate: d.contractDate ? new Date(d.contractDate) : null, identityKey: `manual:${randomUUID()}` },
    });
    await this.audit.log({ userId: u.id, userEmail: u.email, action: 'contract.create', entity: 'Contract', entityId: c.id, after: c, ip });
    return { id: c.id };
  }

  @Get(':id')
  @RequirePermission('contracts.view')
  async get(@Param('id', ParseUUIDPipe) id: string) {
    const c = await this.prisma.contract.findUnique({
      where: { id },
      include: { supplier: { select: { id: true, name: true, taxId: true } }, plans: { orderBy: [{ year: 'asc' }, { month: 'asc' }, { week: 'asc' }] }, documents: { where: { deletedAt: null }, orderBy: { createdAt: 'desc' } } },
    });
    if (!c) throw new NotFoundException('Договор не найден');
    const [history, tasks] = await Promise.all([
      this.prisma.auditLog.findMany({ where: { entity: 'Contract', entityId: id }, orderBy: { id: 'desc' }, take: 100 }),
      this.prisma.reconciliationTask.findMany({ where: { contractId: id }, orderBy: { createdAt: 'desc' } }),
    ]);
    const net = (await netPaidMap(this.prisma, [id])).get(id) ?? null;
    const d = contractDebt({ ...c, newPaid: net });
    return {
      ...this.view(c, net),
      notes: c.notes, sourcePaid: c.sourcePaid?.toFixed(2) ?? null, sourceBatchId: c.sourceBatchId, sourceRow: c.sourceRow, identityKey: c.identityKey,
      debtDetails: { contractAmount: d.contractAmount.toFixed(2), openingPaid: d.openingPaid.toFixed(2), newApprovedPaid: d.newApprovedPaid.toFixed(2), totalPaid: d.totalPaid.toFixed(2) },
      payments: (await this.prisma.payment.findMany({ where: { contractId: id }, orderBy: [{ paymentDate: 'desc' }, { createdAt: 'desc' }] })).map((p) => ({ id: p.id, paymentDate: p.paymentDate.toISOString().slice(0, 10), amount: p.amount.toFixed(2), currency: p.currency, kind: p.kind, status: p.status, signedAmount: p.signedAmount?.toFixed(2) ?? null, transactionNo: p.transactionNo, bankDocument: p.bankDocument, reflectedInOpening: p.reflectedInOpening })),
      plans: c.plans.map((p) => ({ id: p.id, year: p.year, month: p.month, week: p.week, amount: p.amount.toFixed(2), currency: p.currency, source: p.source, note: p.note })),
      documents: c.documents.map((x) => ({ id: x.id, filename: x.filename, mime: x.mime, size: x.size, createdAt: x.createdAt, uploadedById: x.uploadedById })),
      reconciliation: tasks, history: history.map((h) => ({ ...h, id: h.id.toString() })),
    };
  }

  /** Редактирование. «Оплачено» не редактируется (меняется только сверкой/платежами). Сумма и валюта — с обязательной причиной. */
  @Patch(':id')
  @RequirePermission('contracts.manage')
  async update(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @ClientIp() ip: string | null) {
    const d = parse(z.object({
      supplierId: z.string().uuid().optional(), number: z.string().trim().min(1).max(300).optional(), contractDate: dateStr.nullable().optional(), project: z.string().trim().max(300).nullable().optional(),
      goods: z.string().trim().max(500).nullable().optional(), executor: z.string().trim().max(100).nullable().optional(), notes: z.string().trim().max(4000).nullable().optional(),
      amount: money2.optional(), currency: z.enum(CURRENCIES).optional(), reason: z.string().trim().min(3).max(500).optional(),
      origin: z.enum(['LOCAL', 'FOREIGN']).nullable().optional(),
    }).strict(), body);
    const before = await this.prisma.contract.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Договор не найден');
    if (before.status === 'ARCHIVED') throw new BadRequestException('Договор в архиве: сначала восстановите его');
    const financial = (d.amount !== undefined && !before.amount.equals(d.amount)) || (d.currency !== undefined && d.currency !== before.currency);
    if (financial && !d.reason) throw new BadRequestException('Для изменения суммы или валюты укажите причину');
    if (d.amount !== undefined && before.openingPaid.gt(d.amount)) throw new BadRequestException('Сумма договора не может быть меньше уже оплаченной (начальной оплаты)');
    if (d.supplierId) {
      const s = await this.prisma.supplier.findUnique({ where: { id: d.supplierId } });
      if (!s || s.status !== 'ACTIVE') throw new BadRequestException('Поставщик не найден или архивирован');
    }
    const { reason, contractDate, ...rest } = d;
    const after = await this.prisma.contract.update({ where: { id }, data: { ...rest, ...(contractDate !== undefined ? { contractDate: contractDate ? new Date(contractDate) : null } : {}) } });
    await this.audit.log({
      userId: u.id, userEmail: u.email, action: financial ? 'contract.update_financial' : 'contract.update', entity: 'Contract', entityId: id, before, after, ip,
      meta: { reason: reason ?? null, divergesFromSource: financial && !!before.sourceBatchId },
    });
    return { id };
  }

  /**
   * Массовые действия над выбранными договорами: архив, восстановление, смена исполнителя.
   * Права проверяются как для одиночных операций; каждое изменение пишется в аудит отдельной записью (с пометкой bulk).
   * Суммы, валюта и платежи массово не меняются.
   */
  @Post('bulk')
  @RequirePermission('contracts.view')
  async bulk(@CurrentUser() u: AuthUser, @Body() body: unknown, @ClientIp() ip: string | null) {
    const d = parse(z.object({
      action: z.enum(['archive', 'restore', 'executor', 'origin', 'origin-accept']),
      ids: z.array(z.string().uuid()).min(1, 'Выберите хотя бы один договор').max(500, 'Не больше 500 договоров за раз'),
      executor: z.string().trim().max(100).nullable().optional(),
      origin: z.enum(['LOCAL', 'FOREIGN']).nullable().optional(),
    }).strict(), body);
    const need = d.action === 'archive' || d.action === 'restore' ? 'contracts.archive' : 'contracts.manage';
    if (!u.permissions.includes(need)) throw new ForbiddenException('Недостаточно прав для этого действия');
    if (d.action === 'executor' && d.executor === undefined) throw new BadRequestException('Укажите исполнителя (или пустое значение, чтобы очистить)');
    const ids = [...new Set(d.ids)];
    if (d.action === 'origin' && d.origin === undefined) throw new BadRequestException('Укажите значение: местный, зарубежный или пусто (сбросить)');
    const rows = await this.prisma.contract.findMany({ where: { id: { in: ids } }, include: { supplier: { select: { name: true, taxId: true } } } });
    const byId = new Map(rows.map((r) => [r.id, r]));
    let updated = 0, skipped = 0;
    for (const id of ids) {
      const c = byId.get(id);
      if (!c) { skipped++; continue; }
      if (d.action === 'origin' || d.action === 'origin-accept') {
        // «Принять предложения»: только там, где значение ещё не подтверждено и предложение есть
        const next = d.action === 'origin' ? (d.origin ?? null) : (c.origin ? null : this.originInfo(c).originSuggested);
        if (next === null && d.action === 'origin-accept') { skipped++; continue; }
        if (c.origin === next) { skipped++; continue; }
        await this.prisma.contract.update({ where: { id }, data: { origin: next } });
        await this.audit.log({ userId: u.id, userEmail: u.email, action: 'contract.update', entity: 'Contract', entityId: id, before: { origin: c.origin }, after: { origin: next }, meta: { bulk: true, acceptedSuggestion: d.action === 'origin-accept' }, ip });
      } else if (d.action === 'executor') {
        const next = d.executor ? d.executor : null;
        if (c.status === 'ARCHIVED' || (c.executor ?? null) === next) { skipped++; continue; }
        await this.prisma.contract.update({ where: { id }, data: { executor: next } });
        await this.audit.log({ userId: u.id, userEmail: u.email, action: 'contract.update', entity: 'Contract', entityId: id, before: { executor: c.executor }, after: { executor: next }, meta: { bulk: true }, ip });
      } else {
        const status = d.action === 'archive' ? 'ARCHIVED' : 'ACTIVE';
        if (c.status === status) { skipped++; continue; }
        await this.prisma.contract.update({ where: { id }, data: { status } });
        await this.audit.log({ userId: u.id, userEmail: u.email, action: status === 'ARCHIVED' ? 'contract.archive' : 'contract.restore', entity: 'Contract', entityId: id, before: { status: c.status }, after: { status }, meta: { bulk: true }, ip });
      }
      updated++;
    }
    return { updated, skipped };
  }

  @Post(':id/archive')
  @RequirePermission('contracts.archive')
  async archive(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip: string | null) {
    return this.setStatus(u, id, 'ARCHIVED', ip);
  }

  @Post(':id/restore')
  @RequirePermission('contracts.archive')
  async restore(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip: string | null) {
    return this.setStatus(u, id, 'ACTIVE', ip);
  }

  private async setStatus(u: AuthUser, id: string, status: 'ACTIVE' | 'ARCHIVED', ip: string | null) {
    const before = await this.prisma.contract.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Договор не найден');
    if (before.status === status) return { id, status };
    await this.prisma.contract.update({ where: { id }, data: { status } });
    await this.audit.log({ userId: u.id, userEmail: u.email, action: status === 'ARCHIVED' ? 'contract.archive' : 'contract.restore', entity: 'Contract', entityId: id, before: { status: before.status }, after: { status }, ip });
    return { id, status };
  }

  // ---- Документы ----

  @Post(':id/documents')
  @RequirePermission('contracts.manage')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024, files: 1 } }))
  async upload(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @UploadedFile() file: Express.Multer.File, @ClientIp() ip: string | null) {
    if (!file) throw new BadRequestException('Файл не передан');
    if (!(await this.prisma.contract.findUnique({ where: { id }, select: { id: true } }))) throw new NotFoundException('Договор не найден');
    const filename = Buffer.from(file.originalname, 'latin1').toString('utf8').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 200);
    const ext = filename.split('.').pop()!.toLowerCase();
    const type = DOC_TYPES[ext];
    if (!type) throw new BadRequestException('Допустимые форматы: PDF, PNG, JPG, DOCX, XLSX');
    if (!type.magic(file.buffer)) throw new BadRequestException('Содержимое файла не соответствует расширению');
    const dir = join(cfg.UPLOAD_DIR, 'docs');
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${randomUUID()}.${ext}`);
    await writeFile(path, file.buffer);
    const doc = await this.prisma.contractDocument.create({ data: { contractId: id, filename, mime: type.mime, size: file.size, sha256: createHash('sha256').update(file.buffer).digest('hex'), path, uploadedById: u.id } });
    await this.audit.log({ userId: u.id, userEmail: u.email, action: 'contract.document_add', entity: 'Contract', entityId: id, after: { documentId: doc.id, filename, size: file.size, sha256: doc.sha256 }, ip });
    return { id: doc.id, filename, size: doc.size };
  }

  @Get(':id/documents/:docId')
  @RequirePermission('contracts.view')
  async download(@Param('id', ParseUUIDPipe) id: string, @Param('docId', ParseUUIDPipe) docId: string, @Res({ passthrough: true }) res: Response) {
    const doc = await this.prisma.contractDocument.findFirst({ where: { id: docId, contractId: id, deletedAt: null } });
    if (!doc) throw new NotFoundException('Документ не найден');
    // Всегда как вложение с фиксированным типом: файл пользователя не должен исполняться в контексте приложения.
    res.setHeader('Content-Type', doc.mime);
    res.setHeader('Content-Disposition', `attachment; filename="document"; filename*=UTF-8''${encodeURIComponent(doc.filename)}`);
    return new StreamableFile(createReadStream(resolve(doc.path)));
  }

  @Delete(':id/documents/:docId')
  @RequirePermission('contracts.manage')
  async removeDoc(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('docId', ParseUUIDPipe) docId: string, @ClientIp() ip: string | null) {
    const doc = await this.prisma.contractDocument.findFirst({ where: { id: docId, contractId: id, deletedAt: null } });
    if (!doc) throw new NotFoundException('Документ не найден');
    await this.prisma.contractDocument.update({ where: { id: docId }, data: { deletedAt: new Date(), deletedById: u.id } });
    await this.audit.log({ userId: u.id, userEmail: u.email, action: 'contract.document_remove', entity: 'Contract', entityId: id, before: { documentId: docId, filename: doc.filename, sha256: doc.sha256 }, ip });
    return { ok: true };
  }
}
