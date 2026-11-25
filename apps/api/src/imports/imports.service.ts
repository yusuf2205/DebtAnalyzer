import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanDisplayName, extractTaxId, type CurrencyCode } from '@pf/shared';
import {
  analyzeSheet, describeSheets, detectLayout, readWorkbook,
  type AnalysisResult, type LayoutMapping, type Overrides, type ParsedRow,
} from '@pf/shared/import';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../common/types';
import { loadConfig } from '../config';
import { PrismaService } from '../prisma/prisma.service';

const ALLOWED = new Set(['xlsx', 'xlsm', 'csv']);
const importable = (s: string) => s === 'OK' || s === 'WARNING';

function assertFileSignature(ext: string, buf: Buffer) {
  if (ext === 'csv') {
    if (buf.subarray(0, 4096).includes(0)) throw new BadRequestException('Файл не похож на CSV (содержит бинарные данные)');
    return;
  }
  // XLSX/XLSM — это ZIP-архив: PK\x03\x04
  if (!(buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04)) throw new BadRequestException('Содержимое файла не соответствует формату XLSX');
}

export interface CommitReport {
  suppliersCreated: number; suppliersExisting: number;
  contractsCreated: number; contractsUnchanged: number; contractsChangedInSource: number;
  planEntriesWritten: number; ratesPending: number;
  skipped: { blocked: number; duplicates: number; excluded: number };
  blockedRows: { row: number; reasons: string[] }[];
  reconciliationTasks: number;
}

@Injectable()
export class ImportsService {
  private log = new Logger('Imports');
  private cfg = loadConfig();
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  async upload(file: { originalname: string; buffer: Buffer }, user: AuthUser, ip: string | null) {
    if (!file) throw new BadRequestException('Файл не передан');
    // multer отдаёт originalname в latin1: восстанавливаем UTF-8 (иначе кириллица в имени файла теряется).
    const decoded = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const filename = (decoded.includes('�') ? file.originalname : decoded).replace(/[^\w.\- а-яА-ЯёЁ()]/g, '_').slice(0, 200);
    const ext = filename.split('.').pop()!.toLowerCase();
    if (ext === 'xls') throw new BadRequestException('Формат XLS пока не поддерживается: сохраните файл как XLSX (Файл → Сохранить как).');
    if (!ALLOWED.has(ext)) throw new BadRequestException('Допустимые форматы: XLSX, CSV');
    assertFileSignature(ext, file.buffer);

    let sheets;
    try { sheets = await readWorkbook(file.buffer, filename); }
    catch (e) { throw new BadRequestException(`Не удалось прочитать файл: ${(e as Error).message}`); }
    const info = describeSheets(sheets).map((s) => ({ ...s, layoutDetected: !!detectLayout(sheets.find((x) => x.name === s.name)!) }));

    const sha = createHash('sha256').update(file.buffer).digest('hex');
    await mkdir(this.cfg.UPLOAD_DIR, { recursive: true });
    const filePath = join(this.cfg.UPLOAD_DIR, `${sha}.${ext}`);
    await writeFile(filePath, file.buffer);

    const batch = await this.prisma.importBatch.create({ data: { filename, fileSha256: sha, filePath, sheets: info as unknown as Prisma.InputJsonValue, createdById: user.id } });
    await this.audit.log({ userId: user.id, userEmail: user.email, action: 'import.upload', entity: 'ImportBatch', entityId: batch.id, meta: { filename, sha256: sha, size: file.buffer.length }, ip });
    const suggested = info.find((s) => !s.empty && !s.hidden && s.layoutDetected)?.name ?? null;
    return { id: batch.id, filename, sheets: info, suggestedSheet: suggested, sameFileImportedBefore: (await this.prisma.importBatch.count({ where: { fileSha256: sha, status: 'COMMITTED' } })) > 0 };
  }

  private async load(id: string) {
    const b = await this.prisma.importBatch.findUnique({ where: { id } });
    if (!b) throw new NotFoundException('Импорт не найден');
    return b;
  }

  async analyze(id: string, input: { sheetName?: string; mapping?: LayoutMapping; overrides?: Overrides; planYear?: number }, user: AuthUser, ip: string | null) {
    const batch = await this.load(id);
    if (batch.status !== 'UPLOADED' && batch.status !== 'ANALYZED') throw new ConflictException('Импорт уже сохранён или выполняется');
    const sheetName = input.sheetName ?? batch.sheetName;
    if (!sheetName) throw new BadRequestException('Выберите лист');
    const sheets = await readWorkbook(await readFile(batch.filePath), batch.filePath);
    const sheet = sheets.find((s) => s.name === sheetName);
    if (!sheet) throw new BadRequestException(`Лист «${sheetName}» не найден`);
    const mapping = input.mapping ?? (sheetName === batch.sheetName ? (batch.mapping as unknown as LayoutMapping | null) ?? undefined : undefined);
    const overrides = input.overrides ?? (batch.overrides as unknown as Overrides | null) ?? {};
    let result: AnalysisResult;
    try { result = analyzeSheet(sheet, { mapping, overrides, allSheets: sheets }); }
    catch (e) { throw new BadRequestException((e as Error).message); }

    await this.persistAnalysis(id, result, overrides, input.planYear ?? batch.planYear ?? null);
    await this.audit.log({ userId: user.id, userEmail: user.email, action: 'import.analyze', entity: 'ImportBatch', entityId: id, meta: { sheetName, summary: result.summary }, ip });
    return this.get(id);
  }

  private async persistAnalysis(id: string, r: AnalysisResult, overrides: Overrides, planYear: number | null) {
    const extras = {
      mapping: r.mapping, rates: r.rates, rateConflicts: r.rateConflicts, controlTotals: r.controlTotals, controlChecks: r.controlChecks,
      debtWithoutCurrency: r.debtWithoutCurrency, supplierSuggestions: r.supplierSuggestions, supplierGroupCount: r.supplierGroups.length,
    };
    await this.prisma.$transaction(async (tx) => {
      await tx.importRow.deleteMany({ where: { batchId: id } });
      for (let i = 0; i < r.rows.length; i += 200) {
        await tx.importRow.createMany({ data: r.rows.slice(i, i + 200).map((row) => ({ batchId: id, rowNumber: row.rowNumber, status: row.status, data: row as unknown as Prisma.InputJsonValue })) });
      }
      await tx.importBatch.update({
        where: { id },
        data: { status: 'ANALYZED', sheetName: r.sheet, mapping: r.mapping as unknown as Prisma.InputJsonValue, overrides: overrides as unknown as Prisma.InputJsonValue, planYear, summary: r.summary as unknown as Prisma.InputJsonValue, extras: extras as unknown as Prisma.InputJsonValue },
      });
    }, { timeout: 60_000 });
  }

  async setOverrides(id: string, patch: Overrides, user: AuthUser, ip: string | null) {
    const batch = await this.load(id);
    if (batch.status !== 'ANALYZED') throw new ConflictException('Правки возможны только на этапе предпросмотра');
    const merged: Overrides = { ...((batch.overrides as unknown as Overrides) ?? {}) };
    for (const [row, ov] of Object.entries(patch)) merged[Number(row)] = { ...merged[Number(row)], ...ov };
    await this.audit.log({ userId: user.id, userEmail: user.email, action: 'import.override', entity: 'ImportBatch', entityId: id, meta: { patch }, ip });
    return this.analyze(id, { overrides: merged }, user, ip);
  }

  async get(id: string) {
    const b = await this.load(id);
    return { id: b.id, filename: b.filename, status: b.status, sheetName: b.sheetName, planYear: b.planYear, sheets: b.sheets, summary: b.summary, extras: b.extras, report: b.report, overrides: b.overrides, createdAt: b.createdAt, committedAt: b.committedAt };
  }

  list() {
    return this.prisma.importBatch.findMany({ orderBy: { createdAt: 'desc' }, take: 100, select: { id: true, filename: true, status: true, sheetName: true, summary: true, createdAt: true, committedAt: true } });
  }

  async rows(id: string, q: { status?: string; search?: string; page: number; pageSize: number; code?: string }) {
    await this.load(id);
    const where: Prisma.ImportRowWhereInput = { batchId: id, ...(q.status ? { status: q.status } : {}) };
    // Поиск/фильтр по коду проблемы — в памяти: батч ограничен тысячами строк.
    const all = await this.prisma.importRow.findMany({ where, orderBy: { rowNumber: 'asc' } });
    const s = q.search?.trim().toLowerCase();
    const filtered = all.filter((r) => {
      const d = r.data as unknown as ParsedRow;
      if (q.code && !d.issues.some((i) => i.code === q.code)) return false;
      if (!s) return true;
      return [d.supplierDisplay, d.contractNoRaw, d.project, d.goods, String(d.rowNumber)].some((v) => v?.toLowerCase().includes(s));
    });
    const start = (q.page - 1) * q.pageSize;
    return { total: filtered.length, page: q.page, pageSize: q.pageSize, items: filtered.slice(start, start + q.pageSize).map((r) => r.data) };
  }

  async issues(id: string, severity?: string) {
    await this.load(id);
    const all = await this.prisma.importRow.findMany({ where: { batchId: id }, orderBy: { rowNumber: 'asc' } });
    const items = all.flatMap((r) => (r.data as unknown as ParsedRow).issues).filter((i) => !severity || i.severity === severity);
    const byCode: Record<string, number> = {};
    for (const i of items) byCode[i.code] = (byCode[i.code] ?? 0) + 1;
    return { total: items.length, byCode, items: items.slice(0, 2000) };
  }

  /** Сохранение. Финансовые данные существующих договоров НЕ перезаписываются: расхождения превращаются в задачи сверки. */
  async commit(id: string, planYear: number | undefined, user: AuthUser, ip: string | null): Promise<CommitReport> {
    const batch = await this.load(id);
    const year = planYear ?? batch.planYear;
    if (!year) throw new BadRequestException('Укажите год для плановых платежей: в файле недели W1–W4 заданы без года, мы его не угадываем.');
    // Защита от повторной отправки: атомарный переход ANALYZED -> COMMITTING.
    const claimed = await this.prisma.importBatch.updateMany({ where: { id, status: 'ANALYZED' }, data: { status: 'COMMITTING', planYear: year } });
    if (claimed.count !== 1) throw new ConflictException('Импорт уже сохранён, выполняется или не прошёл анализ');

    try {
      const rowsDb = await this.prisma.importRow.findMany({ where: { batchId: id }, orderBy: { rowNumber: 'asc' } });
      const rows = rowsDb.map((r) => r.data as unknown as ParsedRow);
      const extras = batch.extras as any;
      const report = await this.prisma.$transaction((tx) => this.doCommit(tx, id, rows, extras, year, user), { timeout: 180_000, maxWait: 10_000 });
      await this.prisma.importBatch.update({ where: { id }, data: { status: 'COMMITTED', committedAt: new Date(), report: report as unknown as Prisma.InputJsonValue } });
      await this.audit.log({ userId: user.id, userEmail: user.email, action: 'import.commit', entity: 'ImportBatch', entityId: id, meta: report, ip });
      return report;
    } catch (e) {
      await this.prisma.importBatch.updateMany({ where: { id, status: 'COMMITTING' }, data: { status: 'ANALYZED' } });
      this.log.error(`Сохранение импорта ${id} отменено: ${(e as Error).message}`);
      throw e;
    }
  }

  private async doCommit(tx: Prisma.TransactionClient, batchId: string, rows: ParsedRow[], extras: any, year: number, user: AuthUser): Promise<CommitReport> {
    const rep: CommitReport = {
      suppliersCreated: 0, suppliersExisting: 0, contractsCreated: 0, contractsUnchanged: 0, contractsChangedInSource: 0,
      planEntriesWritten: 0, ratesPending: 0, skipped: { blocked: 0, duplicates: 0, excluded: 0 }, blockedRows: [], reconciliationTasks: 0,
    };
    const good: ParsedRow[] = [];
    for (const r of rows) {
      if (importable(r.status)) good.push(r);
      else if (r.status === 'BLOCKED') { rep.skipped.blocked++; rep.blockedRows.push({ row: r.rowNumber, reasons: r.issues.filter((i) => i.severity === 'error').map((i) => i.message) }); }
      else if (r.status === 'DUPLICATE') rep.skipped.duplicates++;
      else rep.skipped.excluded++;
    }

    // Поставщики: только точное совпадение написания (exactKey). Нечёткие совпадения — только предложения, не слияние.
    const keys = [...new Set(good.map((r) => r.supplierExactKey!))];
    const aliases = await tx.supplierAlias.findMany({ where: { exactKey: { in: keys } } });
    const supplierByKey = new Map(aliases.map((a) => [a.exactKey, a.supplierId]));
    rep.suppliersExisting = new Set(aliases.map((a) => a.supplierId)).size;
    for (const r of good) {
      if (supplierByKey.has(r.supplierExactKey!)) continue;
      const name = cleanDisplayName(r.supplierDisplay!);
      const s = await tx.supplier.create({ data: { name, taxId: extractTaxId(r.supplierRaw ?? '') ?? null, aliases: { create: { alias: name, exactKey: r.supplierExactKey!, source: `IMPORT:${batchId}` } } } });
      supplierByKey.set(r.supplierExactKey!, s.id);
      rep.suppliersCreated++;
    }

    // Договоры
    const existing = await tx.contract.findMany({ where: { identityKey: { in: good.map((r) => r.identityKey) } } });
    const byIdentity = new Map(existing.map((c) => [c.identityKey, c]));
    for (const r of good) {
      const planRows = r.plan.map((p) => ({ year, month: p.month, week: p.week, amount: p.amount, currency: r.currency as CurrencyCode, source: 'IMPORT' as const }));
      const found = byIdentity.get(r.identityKey);
      let contractId: string;
      if (!found) {
        const c = await tx.contract.create({
          data: {
            supplierId: supplierByKey.get(r.supplierExactKey!)!, project: r.project, number: r.contractNoRaw, contractDate: r.contractDate ? new Date(r.contractDate) : null,
            goods: r.goods, amount: r.amount!, currency: r.currency!, openingPaid: r.openingPaid!, sourcePaid: r.openingPaid!, executor: r.executor,
            notes: [r.notes, ...r.planNotes].filter(Boolean).join('\n') || null, identityKey: r.identityKey, sourceBatchId: batchId, sourceRow: r.rowNumber,
          },
        });
        contractId = c.id; rep.contractsCreated++;
      } else {
        contractId = found.id;
        const changes: { field: string; from: string | null; to: string | null }[] = [];
        if (found.sourcePaid && !found.sourcePaid.equals(r.openingPaid!)) changes.push({ field: 'openingPaid', from: found.sourcePaid.toFixed(2), to: r.openingPaid });
        if (!found.amount.equals(r.amount!)) changes.push({ field: 'amount', from: found.amount.toFixed(2), to: r.amount });
        if (found.currency !== r.currency) changes.push({ field: 'currency', from: found.currency, to: r.currency });
        // Ровно этот вариант строки уже отклонён пользователем — не создаём задачу заново при каждой синхронизации.
        const rejectedSame = changes.length ? await tx.reconciliationTask.findFirst({ where: { contractId, status: 'REJECTED', type: 'SOURCE_CHANGED', details: { path: ['fingerprint'], equals: r.fingerprint } } }) : null;
        if (rejectedSame) rep.contractsUnchanged++;
        else if (changes.length) {
          const dup = await tx.reconciliationTask.findFirst({ where: { contractId, status: { in: ['PENDING', 'MATCHED'] }, type: 'SOURCE_CHANGED' } });
          if (dup) await tx.reconciliationTask.update({ where: { id: dup.id }, data: { batchId, details: { changes, fingerprint: r.fingerprint, row: r.rowNumber } } });
          else { await tx.reconciliationTask.create({ data: { type: 'SOURCE_CHANGED', contractId, batchId, details: { changes, fingerprint: r.fingerprint, row: r.rowNumber } } }); rep.reconciliationTasks++; }
          rep.contractsChangedInSource++;
        } else rep.contractsUnchanged++;
        if (found.sourcePaid === null) await tx.contract.update({ where: { id: found.id }, data: { sourcePaid: r.openingPaid! } });
      }
      // План: перезаписываем только записи, пришедшие из импорта; ручные не трогаем. На задолженность план не влияет.
      await tx.planEntry.deleteMany({ where: { contractId, source: 'IMPORT', year } });
      if (planRows.length) { await tx.planEntry.createMany({ data: planRows.map((p) => ({ ...p, contractId })) }); rep.planEntriesWritten += planRows.length; }
    }

    // Курсы: только кандидаты на подтверждение. Ни один не становится «действующим» без решения пользователя.
    for (const c of (extras?.rates ?? []) as { currency: CurrencyCode; uzsPerUnit: string; date: string | null; sheet: string; cell: string }[]) {
      const effectiveDate = c.date ? new Date(c.date) : null;
      const source = `IMPORT:${batchId}:${c.sheet}!${c.cell}`;
      const dup = await tx.fxRate.findFirst({ where: { currency: c.currency, uzsPerUnit: c.uzsPerUnit, effectiveDate, source: { startsWith: 'IMPORT:' }, status: { not: 'REJECTED' } } });
      if (dup) continue;
      await tx.fxRate.create({ data: { currency: c.currency, uzsPerUnit: c.uzsPerUnit, effectiveDate, source, status: 'PENDING_CONFIRMATION', setById: user.id } });
      rep.ratesPending++;
    }
    return rep;
  }
}
