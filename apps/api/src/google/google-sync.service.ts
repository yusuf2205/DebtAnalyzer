import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma, type GoogleMode } from '@prisma/client';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describeSheets, detectLayout, diffBatches, readXlsx, serializeSheets, type ParsedRow, type SheetData } from '@pf/shared/import';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../common/types';
import { loadConfig } from '../config';
import { ImportsService } from '../imports/imports.service';
import { PrismaService } from '../prisma/prisma.service';
import { GoogleAccessError, GoogleClient, parseSpreadsheetUrl } from './google-client.service';

interface Acquired { mode: GoogleMode; credentialId: string | null; title: string | null; sheets: SheetData[]; bytes: Buffer; ext: 'xlsx' | 'gsheet.json' }
export interface SyncResult { status: 'CHANGES' | 'UNCHANGED'; batchId: string | null; changes: SyncSummary | null }
export interface SyncSummary {
  baselineBatchId: string | null; added: number; removed: number; changed: number; paidChanged: number; unchanged: number; blocked: number; importable: number;
  samples: { row: number; supplier: string | null; contract: string | null; fields: { field: string; from: string | null; to: string | null }[] }[];
}

const LOCK_MINUTES = 15;

@Injectable()
export class GoogleSyncService {
  private log = new Logger('GoogleSync');
  constructor(private prisma: PrismaService, private audit: AuditService, private client: GoogleClient, private imports: ImportsService) {}

  /** Получает таблицу. mode не задан — сначала пробуем публичный доступ, затем подключённый аккаунт пользователя. */
  private async acquire(spreadsheetId: string, o: { mode?: GoogleMode; credentialId?: string | null; userId?: string }): Promise<Acquired> {
    const viaOauth = async (credentialId: string): Promise<Acquired> => {
      const cred = await this.prisma.googleCredential.findUnique({ where: { id: credentialId } });
      if (!cred) throw new GoogleAccessError('Подключение Google-аккаунта удалено — подключите аккаунт заново.');
      const { title, sheets } = await this.client.fetchViaApi(spreadsheetId, await this.client.accessToken(cred.refreshTokenEnc));
      return { mode: 'OAUTH', credentialId, title, sheets, bytes: Buffer.from(serializeSheets(sheets)), ext: 'gsheet.json' };
    };
    const viaPublic = async (): Promise<Acquired> => {
      const bytes = await this.client.fetchPublicXlsx(spreadsheetId);
      return { mode: 'PUBLIC', credentialId: null, title: null, sheets: await readXlsx(bytes), bytes, ext: 'xlsx' };
    };
    if (o.mode === 'PUBLIC') return viaPublic();
    if (o.mode === 'OAUTH') return viaOauth(o.credentialId ?? '');
    try { return await viaPublic(); }
    catch (e) {
      if (!(e instanceof GoogleAccessError)) throw e;
      const cred = o.userId ? await this.prisma.googleCredential.findUnique({ where: { userId: o.userId } }) : null;
      if (cred) return viaOauth(cred.id);
      throw new GoogleAccessError(`${e.message}${loadConfig().google.oauthConfigured ? ' Нажмите «Подключить Google-аккаунт» на этой странице.' : ' Подключение аккаунта на сервере не настроено (см. docs/RUNBOOK.md).'}`);
    }
  }

  /** Шаг «вставили ссылку»: проверяем доступ и показываем листы. Ничего не сохраняется. */
  async inspect(url: string, userId: string) {
    const { id } = parseSpreadsheetUrl(url);
    const a = await this.acquire(id, { userId });
    const info = describeSheets(a.sheets).map((s) => ({ ...s, layoutDetected: !!detectLayout(a.sheets.find((x) => x.name === s.name)!) }));
    return { spreadsheetId: id, title: a.title, mode: a.mode, sheets: info, suggestedSheet: info.find((s) => !s.empty && !s.hidden && s.layoutDetected)?.name ?? null };
  }

  async createSource(input: { url: string; name?: string; sheetName: string; planYear: number; autoSync: boolean; intervalMinutes: number }, user: AuthUser, ip: string | null) {
    const { id } = parseSpreadsheetUrl(input.url);
    const a = await this.acquire(id, { userId: user.id });
    const sheet = a.sheets.find((s) => s.name === input.sheetName);
    if (!sheet || !detectLayout(sheet)) throw new UnprocessableEntityException(`На листе «${input.sheetName}» не найдена строка заголовков реестра`);
    const src = await this.prisma.googleSource.create({
      data: {
        name: (input.name || a.title || 'Google Sheets').slice(0, 200), url: `https://docs.google.com/spreadsheets/d/${id}`, spreadsheetId: id, mode: a.mode, credentialId: a.credentialId,
        sheetName: input.sheetName, planYear: input.planYear, autoSync: input.autoSync, intervalMinutes: input.intervalMinutes, createdById: user.id,
        nextSyncAt: input.autoSync ? new Date(Date.now() + input.intervalMinutes * 60_000) : null,
      },
    });
    await this.audit.log({ userId: user.id, userEmail: user.email, action: 'google.source_create', entity: 'GoogleSource', entityId: src.id, after: { ...src }, ip });
    return src;
  }

  /** Одна синхронизация: скачать -> проанализировать -> сравнить с последним сохранённым импортом. Данные НЕ записываются в договоры. */
  async sync(sourceId: string, actor: { id: string; email: string } | null, ip: string | null = null): Promise<SyncResult> {
    const claimed = await this.prisma.googleSource.updateMany({
      where: { id: sourceId, OR: [{ syncStartedAt: null }, { syncStartedAt: { lt: new Date(Date.now() - LOCK_MINUTES * 60_000) } }] },
      data: { syncStartedAt: new Date() },
    });
    if (claimed.count !== 1) {
      if (!(await this.prisma.googleSource.findUnique({ where: { id: sourceId }, select: { id: true } }))) throw new NotFoundException('Источник не найден');
      throw new ConflictException('Синхронизация уже выполняется');
    }
    const src = await this.prisma.googleSource.findUniqueOrThrow({ where: { id: sourceId } });
    const who = actor ?? { id: src.createdById, email: 'google-sync (авто)' };
    const next = () => (src.autoSync ? new Date(Date.now() + src.intervalMinutes * 60_000) : null);
    let batchId: string | null = null;
    try {
      const a = await this.acquire(src.spreadsheetId, { mode: src.mode, credentialId: src.credentialId });
      const sha = createHash('sha256').update(a.bytes).digest('hex');

      // Тот же файл, что и в прошлый раз — ничего не анализируем и не трогаем ожидающие изменения.
      if (src.lastSha === sha && src.lastStatus !== 'ERROR') {
        await this.prisma.googleSource.update({ where: { id: src.id }, data: { lastSyncAt: new Date(), nextSyncAt: next(), syncStartedAt: null } });
        return { status: 'UNCHANGED', batchId: null, changes: null };
      }

      const dir = join(loadConfig().UPLOAD_DIR, 'gsheets');
      await mkdir(dir, { recursive: true });
      const filePath = join(dir, `${sha}.${a.ext}`);
      await writeFile(filePath, a.bytes);
      const batch = await this.prisma.importBatch.create({ data: { filename: `${src.name} (Google Sheets)`, fileSha256: sha, filePath, sourceId: src.id, createdById: src.createdById, sheets: describeSheets(a.sheets) as unknown as Prisma.InputJsonValue } });
      batchId = batch.id;
      await this.imports.analyze(batch.id, { sheetName: src.sheetName, planYear: src.planYear }, who as AuthUser, ip);

      const newRows = (await this.prisma.importRow.findMany({ where: { batchId: batch.id } })).map((r) => r.data as unknown as ParsedRow);
      const base = await this.prisma.importBatch.findFirst({ where: { status: 'COMMITTED', sheetName: src.sheetName }, orderBy: { committedAt: 'desc' } });
      const summary = await this.summarize(base?.id ?? null, newRows);
      const firstSync = !src.lastBatchId && !src.lastSyncAt;
      const nothing = !!base && !summary.added && !summary.removed && !summary.changed;

      if (nothing && !firstSync) {
        // Файл изменился (метаданные, форматирование), а данные — нет: черновик не нужен.
        await this.prisma.importBatch.delete({ where: { id: batch.id } });
        batchId = null;
        await this.prisma.googleSource.update({ where: { id: src.id }, data: { lastSyncAt: new Date(), nextSyncAt: next(), lastStatus: 'UNCHANGED', lastError: null, lastSha: sha, lastChanges: summary as unknown as Prisma.InputJsonValue, syncStartedAt: null } });
        return { status: 'UNCHANGED', batchId: null, changes: summary };
      }

      // Старые неподтверждённые черновики этого источника заменяются новым — на данные они не влияли.
      await this.prisma.importBatch.deleteMany({ where: { sourceId: src.id, status: 'ANALYZED', id: { not: batch.id } } });
      const fresh = await this.prisma.importBatch.findUniqueOrThrow({ where: { id: batch.id } });
      await this.prisma.importBatch.update({ where: { id: batch.id }, data: { extras: { ...(fresh.extras as object), sync: summary } as unknown as Prisma.InputJsonValue } });
      await this.prisma.googleSource.update({ where: { id: src.id }, data: { lastSyncAt: new Date(), nextSyncAt: next(), lastStatus: 'CHANGES', lastError: null, lastBatchId: batch.id, lastSha: sha, lastChanges: summary as unknown as Prisma.InputJsonValue, syncStartedAt: null } });
      await this.audit.log({ userId: who.id, userEmail: who.email, action: 'google.sync', entity: 'GoogleSource', entityId: src.id, meta: { batchId: batch.id, ...summary, samples: undefined }, ip });
      return { status: 'CHANGES', batchId: batch.id, changes: summary };
    } catch (e) {
      const message = (e as any)?.response?.message ?? (e as Error).message;
      this.log.warn(`Синхронизация ${src.id} не удалась: ${message}`);
      if (batchId) await this.prisma.importBatch.deleteMany({ where: { id: batchId } });
      await this.prisma.googleSource.update({ where: { id: src.id }, data: { lastSyncAt: new Date(), nextSyncAt: next(), lastStatus: 'ERROR', lastError: String(message).slice(0, 500), syncStartedAt: null } });
      await this.audit.log({ userId: who.id, userEmail: who.email, action: 'google.sync_failed', entity: 'GoogleSource', entityId: src.id, meta: { error: String(message).slice(0, 500) }, ip });
      throw e;
    }
  }

  private async summarize(baseId: string | null, newRows: ParsedRow[]): Promise<SyncSummary> {
    const importable = newRows.filter((r) => r.status === 'OK' || r.status === 'WARNING');
    const blocked = newRows.filter((r) => r.status === 'BLOCKED').length;
    if (!baseId) return { baselineBatchId: null, added: importable.length, removed: 0, changed: 0, paidChanged: 0, unchanged: 0, blocked, importable: importable.length, samples: [] };
    const prev = (await this.prisma.importRow.findMany({ where: { batchId: baseId } })).map((r) => r.data as unknown as ParsedRow);
    const d = diffBatches(prev, newRows);
    return {
      baselineBatchId: baseId, added: d.added.length, removed: d.removed.length, changed: d.changed.length, unchanged: d.unchanged, blocked, importable: importable.length,
      paidChanged: d.changed.filter((c) => c.fields.some((f) => f.field === 'openingPaid')).length,
      samples: d.changed.slice(0, 20).map((c) => ({ row: c.after.rowNumber, supplier: c.after.supplierDisplay, contract: c.after.contractNoRaw, fields: c.fields })),
    };
  }

  /** Источники, которым пора синхронизироваться. Вызывается воркером. */
  async runDue(): Promise<{ ran: number; failed: number }> {
    const due = await this.prisma.googleSource.findMany({ where: { autoSync: true, nextSyncAt: { lte: new Date() } }, orderBy: { nextSyncAt: 'asc' }, take: 20 });
    let ran = 0, failed = 0;
    for (const s of due) {
      try { await this.sync(s.id, null); ran++; } catch (e) { if (e instanceof ConflictException) continue; failed++; }
    }
    return { ran, failed };
  }

  assertInterval(n: number) { if (n < 15 || n > 1440) throw new BadRequestException('Интервал: от 15 минут до 24 часов'); }
}
