import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import PgBoss from 'pg-boss';
import { AppModule } from './app.module';
import { AuthService } from './auth/auth.service';
import { AnalyticsService } from './analytics/analytics.service';
import { PrismaService } from './prisma/prisma.service';
import { GoogleSyncService } from './google/google-sync.service';
import { CbuService } from './fx/cbu.service';
import { NotificationsService } from './notifications/notifications.service';

/**
 * Worker: фоновые задачи на PostgreSQL (pg-boss) — без Redis.
 *  - cleanup-sessions: раз в час удаляет просроченные сессии;
 *  - debt-snapshot: раз в сутки фиксирует задолженность по валютам (график динамики на дашборде);
 *  - google-sync-due: каждые 5 минут запускает синхронизацию источников Google Sheets, которым подошло время
 *    (интервал задаётся в источнике, по умолчанию 60 минут). Синхронизация только читает таблицу и готовит
 *    предпросмотр изменений — договоры и платежи сама не меняет.
 */
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL не задан');
  const ctx = await NestFactory.createApplicationContext(AppModule, { logger: ['warn', 'error', 'log'] });
  const auth = ctx.get(AuthService), google = ctx.get(GoogleSyncService), analytics = ctx.get(AnalyticsService), notifications = ctx.get(NotificationsService), cbu = ctx.get(CbuService);

  const boss = new PgBoss(url);
  boss.on('error', (e) => console.error('[worker] pg-boss error', e));
  await boss.start();

  await boss.createQueue('cleanup-sessions');
  await boss.schedule('cleanup-sessions', '17 * * * *');
  await boss.work('cleanup-sessions', async () => { console.log(`[worker] cleanup-sessions: удалено ${await auth.purgeExpired()}`); });

  await boss.createQueue('google-sync-due');
  await boss.schedule('google-sync-due', '*/5 * * * *');
  await boss.work('google-sync-due', async () => {
    const r = await google.runDue();
    if (r.ran || r.failed) console.log(`[worker] google-sync-due: выполнено ${r.ran}, с ошибкой ${r.failed}`);
  });

  // Ежедневный снимок портфеля для графика динамики задолженности (идемпотентен; дашборд тоже создаёт его при открытии).
  await boss.createQueue('debt-snapshot');
  await boss.schedule('debt-snapshot', '10 0 * * *');
  await boss.work('debt-snapshot', async () => { const r = await analytics.captureSnapshot(); console.log(`[worker] debt-snapshot: создано ${r.created}`); });

  // Курсы ЦБ: раз в сутки подтягиваем свежие курсы как «ожидают подтверждения» (применяет их только человек).
  await boss.createQueue('fx-cbu');
  await boss.schedule('fx-cbu', '40 0 * * *');
  await boss.work('fx-cbu', async () => {
    try { const r = await cbu.sync(); console.log(`[worker] fx-cbu: создано ${r.created.length}, пропущено ${r.skipped.length}`); }
    catch (e) { console.error('[worker] fx-cbu', (e as Error).message); }
  });

  // Уведомления: каждые 10 минут проверяем, не пора ли отправить ежедневную сводку и нет ли проблем системы.
  await boss.createQueue('notify-tick');
  await boss.schedule('notify-tick', '*/10 * * * *');
  await boss.work('notify-tick', async () => {
    try { const r = await notifications.tick(); if (r.digest || r.alert) console.log(`[worker] notify-tick: сводка ${r.digest ? 'отправлена' : '—'}, тревога ${r.alert ? 'отправлена' : '—'}`); }
    catch (e) { console.error('[worker] notify-tick', (e as Error).message); }
  });

  // Пульс воркера: страница «Система» предупреждает, если фоновые задачи перестали выполняться.
  const prisma = ctx.get(PrismaService);
  const beat = () => prisma.appSetting.upsert({ where: { key: 'workerHeartbeat' }, create: { key: 'workerHeartbeat', value: { at: new Date().toISOString(), pid: process.pid } }, update: { value: { at: new Date().toISOString(), pid: process.pid } } }).catch((e) => console.error('[worker] heartbeat', e.message));
  await beat(); setInterval(beat, 60_000).unref();

  console.log('[worker] запущен');
  const stop = async () => { await boss.stop({ graceful: true }); await ctx.close(); process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
main().catch((e) => { console.error(e); process.exit(1); });
