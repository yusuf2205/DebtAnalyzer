import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { AuthedRequest } from './types';

/**
 * Журнал запросов в stdout одной JSON-строкой (удобно для `docker compose logs` и сбора логов).
 * Пишется только метод, путь БЕЗ query-строки, статус, длительность, пользователь и IP — тела запросов, cookie и
 * заголовки авторизации в журнал не попадают. Успешные проверки здоровья не логируются (шум).
 */
export function requestLog() {
  return (req: Request, res: Response, next: NextFunction) => {
    const id = (typeof req.headers['x-request-id'] === 'string' && /^[\w-]{8,64}$/.test(req.headers['x-request-id'])) ? req.headers['x-request-id'] : randomUUID();
    res.setHeader('x-request-id', id);
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const path = req.originalUrl.split('?')[0];
      if (path === '/api/health' && res.statusCode < 400) return;
      const ms = Number((process.hrtime.bigint() - start) / 1_000_000n);
      process.stdout.write(JSON.stringify({
        t: new Date().toISOString(), level: res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info', id,
        method: req.method, path, status: res.statusCode, ms, user: (req as AuthedRequest).user?.id ?? null, ip: req.ip ?? null,
      }) + '\n');
    });
    next();
  };
}
