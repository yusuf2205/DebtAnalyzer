import { Body, Controller, Get, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { parse } from '../common/zod';
import { AuditService } from '../audit/audit.service';
import { ClientIp, CurrentUser } from '../auth/decorators';
import type { AuthUser } from '../common/types';
import { readFile, readdir, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { RequirePermission } from '../auth/decorators';
import { loadConfig } from '../config';
import { PrismaService } from '../prisma/prisma.service';

type Level = 'ok' | 'warn' | 'error';
interface Check { id: string; title: string; status: Level; detail: string }
const HOUR = 3600_000;
const worst = (cs: Check[]): Level => (cs.some((c) => c.status === 'error') ? 'error' : cs.some((c) => c.status === 'warn') ? 'warn' : 'ok');

const started = Date.now();

@Controller('system')
export class SystemController {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  /** Состояние системы для администратора: «зелёный» список проверок, которые стоит смотреть после каждого обновления. */
  @Get('status')
  @RequirePermission('settings.manage')
  async status() {
    const cfg = loadConfig();
    const checks: Check[] = [];
    const add = (id: string, title: string, status: Level, detail: string) => checks.push({ id, title, status, detail });

    // База данных
    const t0 = Date.now();
    let dbSize: string | null = null, migrations = 0;
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      const m = await this.prisma.$queryRaw<{ c: bigint }[]>`SELECT count(*)::bigint AS c FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`;
      migrations = Number(m[0]?.c ?? 0);
      const sz = await this.prisma.$queryRaw<{ s: string }[]>`SELECT pg_size_pretty(pg_database_size(current_database())) AS s`;
      dbSize = sz[0]?.s ?? null;
      const ms = Date.now() - t0;
      add('db', 'База данных', ms > 1500 ? 'warn' : 'ok', `доступна, ответ ${ms} мс, размер ${dbSize}, миграций применено: ${migrations}`);
    } catch { add('db', 'База данных', 'error', 'недоступна'); }

    // Воркер: пульс раз в минуту (фоновая синхронизация Google, снимки, очистка сессий)
    const hb = await this.prisma.appSetting.findUnique({ where: { key: 'workerHeartbeat' } }).catch(() => null);
    const hbAt = hb ? new Date((hb.value as { at: string }).at).getTime() : null;
    if (hbAt === null) add('worker', 'Фоновый воркер', cfg.NODE_ENV === 'production' ? 'error' : 'warn', 'нет сигналов от воркера — автосинхронизация Google и ежедневные снимки не работают');
    else { const age = Date.now() - hbAt; add('worker', 'Фоновый воркер', age > 3 * 60_000 ? 'error' : 'ok', age > 3 * 60_000 ? `последний сигнал ${Math.round(age / 60_000)} мин назад` : 'работает'); }

    // Резервные копии и проверка восстановления
    const backup = await this.backupInfo(cfg.BACKUP_DIR);
    if (!cfg.BACKUP_DIR) add('backup', 'Резервные копии', cfg.NODE_ENV === 'production' ? 'error' : 'warn', 'каталог копий не смонтирован в API (BACKUP_DIR) — состояние неизвестно');
    else if (!backup.latest) add('backup', 'Резервные копии', 'error', 'копий нет');
    else { const h = backup.latest.ageHours; add('backup', 'Резервные копии', h > 72 ? 'error' : h > 36 ? 'warn' : 'ok', `последняя: ${backup.latest.file}, ${(backup.latest.size / 1048576).toFixed(1)} МБ, ${h < 1 ? 'менее часа' : `${Math.round(h)} ч`} назад; всего копий: ${backup.count}`); }
    if (cfg.BACKUP_DIR) {
      const r = backup.restoreTest;
      if (!r) add('restore', 'Проверка восстановления', 'warn', 'ещё не выполнялась (запускается автоматически раз в неделю или вручную: deploy/restore-test.sh)');
      else { const days = (Date.now() - new Date(r.at).getTime()) / (24 * HOUR); add('restore', 'Проверка восстановления', !r.ok ? 'error' : days > 14 ? 'warn' : 'ok', !r.ok ? `последняя проверка НЕУДАЧНА: ${r.detail ?? ''}` : `успешно ${Math.round(days)} дн. назад${r.detail ? ` (${r.detail})` : ''}`); }
    }

    // Копия вне NAS: состояние пишет сервис offsite (rclone) после отправки и проверки размеров
    if (cfg.BACKUP_DIR) {
      let off: { at: string; ok: boolean; detail?: string } | null = null;
      try { off = JSON.parse(await readFile(join(cfg.BACKUP_DIR, 'last-offsite-sync.json'), 'utf8')); } catch { /* не настроена */ }
      if (!off) add('offsite', 'Копия вне NAS', 'warn', 'не настроена: при краже, пожаре или отказе NAS будут потеряны и данные, и копии. Включите сервис offsite (docs/RUNBOOK.md, deploy/rclone.conf.example)');
      else { const h = (Date.now() - new Date(off.at).getTime()) / HOUR; add('offsite', 'Копия вне NAS', !off.ok ? 'error' : h > 36 ? 'warn' : 'ok', !off.ok ? `последняя отправка не удалась: ${off.detail ?? ''}` : h > 36 ? `последняя отправка ${Math.round(h)} ч назад — сервис offsite не работает?` : `отправка ${Math.round(h)} ч назад: ${off.detail ?? 'ok'}`); }
    }
    // Пробное восстановление на ДРУГОМ компьютере (раз в квартал): отметка вручную, система проверить это не может
    const pc = await this.prisma.appSetting.findUnique({ where: { key: 'restoreOnOtherPc' } }).catch(() => null);
    const pcAt = pc ? (pc.value as { at: string; byEmail?: string }) : null;
    const pcDays = pcAt ? (Date.now() - new Date(pcAt.at).getTime()) / (24 * HOUR) : null;
    add('restore-pc', 'Восстановление на другом компьютере', pcDays === null ? 'warn' : pcDays > 100 ? 'warn' : 'ok',
      pcDays === null ? 'ещё не отмечалось: раз в квартал восстановите копию на другом компьютере и нажмите «Отметить выполненным»' : pcDays > 100 ? `последний раз ${Math.round(pcDays)} дн. назад (${pcAt!.byEmail ?? ''}) — пора повторить` : `выполнено ${Math.round(pcDays)} дн. назад (${pcAt!.byEmail ?? ''})`);

    // Диск
    try {
      const fs = await statfs(await stat(cfg.UPLOAD_DIR).then(() => cfg.UPLOAD_DIR, () => '.'));
      const freePct = (Number(fs.bavail) / Number(fs.blocks)) * 100;
      add('disk', 'Свободное место (тома загрузок)', freePct < 5 ? 'error' : freePct < 15 ? 'warn' : 'ok', `свободно ${freePct.toFixed(0)}% (${(Number(fs.bavail) * Number(fs.bsize) / 1073741824).toFixed(1)} ГБ)`);
    } catch { add('disk', 'Свободное место', 'warn', 'не удалось определить'); }

    // Данные и интеграции
    const [rates, usersCount, googleErr, openRecon, pendingPay, snap, sessions, oauthSources] = await Promise.all([
      this.prisma.fxRate.count({ where: { status: 'CONFIRMED' } }),
      this.prisma.user.count({ where: { isActive: true } }),
      this.prisma.googleSource.count({ where: { lastStatus: 'ERROR' } }),
      this.prisma.reconciliationTask.count({ where: { status: { in: ['PENDING', 'MATCHED'] } } }),
      this.prisma.payment.count({ where: { status: 'PENDING' } }),
      this.prisma.debtSnapshot.findFirst({ orderBy: { date: 'desc' }, select: { date: true } }),
      this.prisma.session.count({ where: { revokedAt: null, expiresAt: { gt: new Date() } } }),
      this.prisma.googleSource.count({ where: { mode: 'OAUTH' } }),
    ]);
    add('fx', 'Курсы валют', rates ? 'ok' : 'warn', rates ? `подтверждённых курсов: ${rates}` : 'нет подтверждённых курсов — итоги в USD неполные');
    add('google', 'Google Sheets', googleErr ? 'warn' : 'ok', googleErr ? `источников с ошибкой синхронизации: ${googleErr}` : 'ошибок синхронизации нет');
    const snapAge = snap ? (Date.now() - snap.date.getTime()) / (24 * HOUR) : null;
    add('snapshot', 'Снимки задолженности', snapAge === null ? 'warn' : snapAge > 2 ? 'warn' : 'ok', snap ? `последний снимок: ${snap.date.toISOString().slice(0, 10)}` : 'снимков ещё нет (создаётся при открытии дашборда)');

    // Безопасность конфигурации
    const prod = cfg.NODE_ENV === 'production';
    add('cookie', 'Защита сессии', prod && !cfg.cookieSecure ? 'error' : 'ok', cfg.cookieSecure ? 'cookie Secure + префикс __Host-' : 'cookie без Secure (допустимо только для разработки)');
    add('proxy', 'Прокси (IP клиента)', prod && cfg.TRUST_PROXY_HOPS < 2 ? 'warn' : 'ok', `TRUST_PROXY_HOPS=${cfg.TRUST_PROXY_HOPS} (за Cloudflare Tunnel + web должно быть 2)`);
    add('initial-admin', 'Начальный пароль админа', cfg.INITIAL_ADMIN_PASSWORD ? 'warn' : 'ok', cfg.INITIAL_ADMIN_PASSWORD ? 'INITIAL_ADMIN_PASSWORD всё ещё задан в окружении — удалите его из .env после первого входа' : 'не задан в окружении');
    add('token-key', 'Ключ шифрования токенов', oauthSources && !cfg.TOKEN_ENCRYPTION_KEY ? 'error' : 'ok', cfg.TOKEN_ENCRYPTION_KEY ? 'задан' : 'не задан (нужен только для закрытых таблиц Google)');

    return {
      status: worst(checks), time: new Date().toISOString(), uptimeSec: Math.round((Date.now() - started) / 1000), node: process.version, env: cfg.NODE_ENV,
      checks,
      counters: { activeUsers: usersCount, activeSessions: sessions, openReconciliations: openRecon, pendingPayments: pendingPay, dbSize, migrations },
      backups: backup,
    };
  }

  /** Правила платежей (пока одно): требовать документ для подтверждения. */
  @Get('policy')
  @RequirePermission('settings.manage')
  async policy() {
    const v = (await this.prisma.appSetting.findUnique({ where: { key: 'paymentPolicy' } }))?.value as { requireDocument?: boolean } | undefined;
    return { requireDocument: !!v?.requireDocument };
  }

  @Put('policy')
  @RequirePermission('settings.manage')
  async setPolicy(@CurrentUser() u: AuthUser, @Body() body: unknown, @ClientIp() ip: string | null) {
    const v = parse(z.object({ requireDocument: z.boolean() }).strict(), body);
    const before = await this.policy();
    await this.prisma.appSetting.upsert({ where: { key: 'paymentPolicy' }, create: { key: 'paymentPolicy', value: v, updatedById: u.id }, update: { value: v, updatedById: u.id } });
    await this.audit.log({ userId: u.id, userEmail: u.email, action: 'system.payment_policy', entity: 'AppSetting', entityId: 'paymentPolicy', before, after: v, ip });
    return v;
  }

  /** Отметка: копия восстановлена на другом компьютере и данные проверены (квартальная проверка). */
  @Post('mark-restore-pc')
  @RequirePermission('settings.manage')
  async markRestorePc(@CurrentUser() u: AuthUser, @ClientIp() ip: string | null) {
    const value = { at: new Date().toISOString(), byEmail: u.email };
    await this.prisma.appSetting.upsert({ where: { key: 'restoreOnOtherPc' }, create: { key: 'restoreOnOtherPc', value, updatedById: u.id }, update: { value, updatedById: u.id } });
    await this.audit.log({ userId: u.id, userEmail: u.email, action: 'system.restore_pc_marked', entity: 'AppSetting', entityId: 'restoreOnOtherPc', after: value, ip });
    return value;
  }

  private async backupInfo(dir?: string) {
    if (!dir) return { configured: false, count: 0, latest: null as null | { file: string; size: number; at: string; ageHours: number }, restoreTest: null as null | { at: string; ok: boolean; detail?: string } };
    let files: { file: string; size: number; at: Date }[] = [];
    try {
      const names = (await readdir(dir)).filter((n) => /^pf-\d{8}-\d{6}\.dump$/.test(n));
      files = await Promise.all(names.map(async (n) => { const s = await stat(join(dir, n)); return { file: n, size: s.size, at: s.mtime }; }));
    } catch { /* каталог недоступен */ }
    files.sort((a, b) => b.at.getTime() - a.at.getTime());
    let restoreTest = null as null | { at: string; ok: boolean; detail?: string };
    try { restoreTest = JSON.parse(await readFile(join(dir, 'last-restore-test.json'), 'utf8')); } catch { /* ещё не выполнялась */ }
    const l = files[0];
    return { configured: true, count: files.length, latest: l ? { file: l.file, size: l.size, at: l.at.toISOString(), ageHours: (Date.now() - l.at.getTime()) / HOUR } : null, restoreTest };
  }
}
