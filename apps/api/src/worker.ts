import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import PgBoss from 'pg-boss';
import { AppModule } from './app.module';
import { AuthService } from './auth/auth.service';
import { GoogleSyncService } from './google/google-sync.service';

/**
 * Worker: фоновые задачи на PostgreSQL (pg-boss) — без Redis.
 *  - cleanup-sessions: раз в час удаляет просроченные сессии;
 *  - google-sync-due: каждые 5 минут запускает синхронизацию источников Google Sheets, которым подошло время
 *    (интервал задаётся в источнике, по умолчанию 60 минут). Синхронизация только читает таблицу и готовит
 *    предпросмотр изменений — договоры и платежи сама не меняет.
 */
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL не задан');
  const ctx = await NestFactory.createApplicationContext(AppModule, { logger: ['warn', 'error', 'log'] });
  const auth = ctx.get(AuthService), google = ctx.get(GoogleSyncService);

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

  console.log('[worker] запущен');
  const stop = async () => { await boss.stop({ graceful: true }); await ctx.close(); process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
main().catch((e) => { console.error(e); process.exit(1); });
