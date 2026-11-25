import { Body, ConflictException, Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { ClientIp, CurrentUser, RequirePermission } from '../auth/decorators';
import type { AuthUser } from '../common/types';
import { parse } from '../common/zod';
import { loadConfig } from '../config';
import { PrismaService } from '../prisma/prisma.service';
import { encryptSecret, GoogleClient } from './google-client.service';
import { GoogleSyncService } from './google-sync.service';

const STATE_COOKIE = 'pf_oauth_state';
const sourceView = (s: any, batchStatus?: string | null) => ({
  id: s.id, name: s.name, url: s.url, mode: s.mode, sheetName: s.sheetName, planYear: s.planYear, autoSync: s.autoSync, intervalMinutes: s.intervalMinutes,
  lastSyncAt: s.lastSyncAt, nextSyncAt: s.nextSyncAt, lastStatus: s.lastStatus, lastError: s.lastError, lastBatchId: s.lastBatchId, lastBatchStatus: batchStatus ?? null,
  lastChanges: s.lastChanges, syncing: !!s.syncStartedAt && s.syncStartedAt > new Date(Date.now() - 15 * 60_000), createdAt: s.createdAt,
});

@Controller('google')
export class GoogleController {
  constructor(private prisma: PrismaService, private audit: AuditService, private client: GoogleClient, private sync: GoogleSyncService) {}

  @Get('status')
  @RequirePermission('import.view')
  async status(@CurrentUser() u: AuthUser) {
    const cfg = loadConfig();
    const c = await this.prisma.googleCredential.findUnique({ where: { userId: u.id }, select: { email: true, createdAt: true } });
    return { oauthConfigured: cfg.google.oauthConfigured, connection: c, redirectUri: cfg.GOOGLE_REDIRECT_URI ?? null };
  }

  // ---- OAuth (закрытые таблицы) ----
  @Get('oauth/start')
  @RequirePermission('integrations.manage')
  start(@Res({ passthrough: true }) res: Response) {
    const state = randomBytes(24).toString('base64url');
    const url = this.client.authUrl(state);
    res.cookie(STATE_COOKIE, state, { httpOnly: true, secure: loadConfig().cookieSecure, sameSite: 'lax', path: '/api/google/oauth', maxAge: 10 * 60_000 });
    return { url };
  }

  @Get('oauth/callback')
  @RequirePermission('integrations.manage')
  async callback(@Query() q: Record<string, string>, @Req() req: Request, @Res() res: Response, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) {
    const fail = (m: string) => res.redirect(`/google?error=${encodeURIComponent(m)}`);
    const saved = (req as any).cookies?.[STATE_COOKIE] as string | undefined;
    res.clearCookie(STATE_COOKIE, { path: '/api/google/oauth' });
    if (q.error) return fail(q.error === 'access_denied' ? 'Доступ не предоставлен' : `Google: ${q.error}`);
    // Проверка state защищает от подмены ответа (CSRF на этапе OAuth).
    if (!saved || !q.state || saved.length !== q.state.length || !timingSafeEqual(Buffer.from(saved), Buffer.from(q.state)) || !q.code) return fail('Недействительный ответ авторизации — повторите подключение');
    try {
      const t = await this.client.exchangeCode(q.code);
      const data = { email: t.email, refreshTokenEnc: encryptSecret(t.refreshToken), scope: t.scope };
      await this.prisma.googleCredential.upsert({ where: { userId: u.id }, create: { userId: u.id, ...data }, update: data });
      await this.audit.log({ userId: u.id, userEmail: u.email, action: 'google.connect', entity: 'GoogleCredential', meta: { googleEmail: t.email, scope: t.scope }, ip });
      return res.redirect('/google?connected=1');
    } catch (e) { return fail(String((e as any)?.response?.message ?? (e as Error).message)); }
  }

  @Post('oauth/disconnect')
  @RequirePermission('integrations.manage')
  @HttpCode(200)
  async disconnect(@CurrentUser() u: AuthUser, @ClientIp() ip: string | null) {
    const c = await this.prisma.googleCredential.findUnique({ where: { userId: u.id }, include: { _count: { select: { sources: true } } } });
    if (!c) throw new NotFoundException('Аккаунт не подключён');
    if (c._count.sources) throw new ConflictException('Есть источники, которые читают таблицы через это подключение. Сначала удалите их.');
    await this.prisma.googleCredential.delete({ where: { id: c.id } });
    await this.audit.log({ userId: u.id, userEmail: u.email, action: 'google.disconnect', entity: 'GoogleCredential', entityId: c.id, ip });
    return { ok: true };
  }

  // ---- Источники ----
  @Post('sources/inspect')
  @RequirePermission('integrations.manage')
  @HttpCode(200)
  inspect(@CurrentUser() u: AuthUser, @Body() body: unknown) {
    const { url } = parse(z.object({ url: z.string().trim().min(10).max(500) }), body);
    return this.sync.inspect(url, u.id);
  }

  @Post('sources')
  @RequirePermission('integrations.manage')
  async create(@CurrentUser() u: AuthUser, @Body() body: unknown, @ClientIp() ip: string | null) {
    const d = parse(z.object({
      url: z.string().trim().min(10).max(500), name: z.string().trim().max(200).optional(), sheetName: z.string().min(1).max(200),
      planYear: z.number().int().min(2000).max(2100), autoSync: z.boolean().default(false), intervalMinutes: z.number().int().default(60), syncNow: z.boolean().default(true),
    }), body);
    this.sync.assertInterval(d.intervalMinutes);
    const src = await this.sync.createSource(d, u, ip);
    if (!d.syncNow) return { source: sourceView(src), sync: null };
    // Сначала синхронизация, потом чтение источника — иначе в ответе будет состояние «до».
    let sync = null, syncError: string | undefined;
    try { sync = await this.sync.sync(src.id, u, ip); } catch (e) { syncError = String((e as any)?.response?.message ?? (e as Error).message); }
    return { source: sourceView(await this.prisma.googleSource.findUniqueOrThrow({ where: { id: src.id } })), sync, syncError };
  }

  @Get('sources')
  @RequirePermission('import.view')
  async list() {
    const items = await this.prisma.googleSource.findMany({ orderBy: { createdAt: 'desc' } });
    const batches = await this.prisma.importBatch.findMany({ where: { id: { in: items.map((i) => i.lastBatchId).filter(Boolean) as string[] } }, select: { id: true, status: true } });
    const st = new Map(batches.map((b) => [b.id, b.status]));
    return items.map((s) => sourceView(s, s.lastBatchId ? st.get(s.lastBatchId) ?? 'GONE' : null));
  }

  @Patch('sources/:id')
  @RequirePermission('integrations.manage')
  async update(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @ClientIp() ip: string | null) {
    const d = parse(z.object({ name: z.string().trim().min(1).max(200).optional(), sheetName: z.string().min(1).max(200).optional(), planYear: z.number().int().min(2000).max(2100).optional(), autoSync: z.boolean().optional(), intervalMinutes: z.number().int().optional() }).strict(), body);
    if (d.intervalMinutes !== undefined) this.sync.assertInterval(d.intervalMinutes);
    const before = await this.prisma.googleSource.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Источник не найден');
    const autoSync = d.autoSync ?? before.autoSync, interval = d.intervalMinutes ?? before.intervalMinutes;
    const after = await this.prisma.googleSource.update({ where: { id }, data: { ...d, nextSyncAt: autoSync ? new Date(Date.now() + interval * 60_000) : null, ...(d.sheetName && d.sheetName !== before.sheetName ? { lastSha: null } : {}) } });
    await this.audit.log({ userId: u.id, userEmail: u.email, action: 'google.source_update', entity: 'GoogleSource', entityId: id, before: sourceView(before), after: sourceView(after), ip });
    return sourceView(after);
  }

  @Delete('sources/:id')
  @RequirePermission('integrations.manage')
  async remove(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip: string | null) {
    const s = await this.prisma.googleSource.findUnique({ where: { id } });
    if (!s) throw new NotFoundException('Источник не найден');
    await this.prisma.googleSource.delete({ where: { id } });
    await this.audit.log({ userId: u.id, userEmail: u.email, action: 'google.source_delete', entity: 'GoogleSource', entityId: id, before: sourceView(s), ip });
    return { ok: true };
  }

  @Post('sources/:id/sync')
  @RequirePermission('import.run')
  @HttpCode(200)
  async runSync(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip: string | null) {
    return this.sync.sync(id, u, ip);
  }
}
