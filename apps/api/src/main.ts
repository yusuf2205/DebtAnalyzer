import { createApp } from './app.factory';
import { loadConfig } from './config';

async function bootstrap() {
  const cfg = loadConfig();
  const app = await createApp();
  app.enableShutdownHooks();
  await app.listen(cfg.PORT, '0.0.0.0');
}
bootstrap().catch((e) => { console.error(e); process.exit(1); });
