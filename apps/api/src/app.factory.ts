import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { loadConfig } from './config';
import { requestLog } from './common/request-log';

export async function createApp(opts: { logger?: boolean } = {}): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: opts.logger === false ? false : ['log', 'warn', 'error'] });
  // За Cloudflare Tunnel / reverse proxy: доверяем одному прокси, чтобы req.ip и rate limit работали по реальному клиенту.
  app.set('trust proxy', loadConfig().TRUST_PROXY_HOPS);
  app.use(requestLog());
  app.use(helmet());
  app.use(cookieParser());
  app.setGlobalPrefix('api');
  return app;
}
