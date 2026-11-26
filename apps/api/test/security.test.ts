import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Настройки читаются при загрузке модулей контроллеров — задаём ДО динамического импорта приложения.
process.env.LOGIN_RATE_LIMIT = '4';
process.env.MAX_UPLOAD_MB = '1';
process.env.TRUST_PROXY_HOPS = '2';

let app: NestExpressApplication, prisma: PrismaClient;
const PW = 'StrongPassw0rd!x';
let n = 0;
const ip = () => `198.51.100.${(++n % 250) + 1}`; // у каждого логина свой «клиентский» адрес, чтобы лимит одного не мешал другому
type S = { agent: ReturnType<typeof request.agent>; csrf: string };

async function login(email: string, password: string, clientIp = ip()) {
  const agent = request.agent(app.getHttpServer());
  const r = await agent.post('/api/auth/login').set('X-Forwarded-For', `${clientIp}, 10.0.0.2`).send({ email, password });
  return { agent, csrf: r.body?.user?.csrfToken as string, status: r.status, res: r };
}
const post = (s: S, u: string) => s.agent.post(u).set('x-csrf-token', s.csrf);
async function user(admin: S, email: string, role: string) {
  await post(admin, '/api/users').send({ email, name: email.split('@')[0], role, password: PW });
  const a = await login(email, PW); await post(a, '/api/auth/change-password').send({ current: PW, next: PW + '2' });
  return login(email, PW + '2');
}
let admin: S, mgr: S, viewer: S;

beforeAll(async () => {
  const { createApp } = await import('../src/app.factory');
  app = await createApp({ logger: false }); await app.init(); prisma = new PrismaClient();
  let r = await login('root@example.test', 'InitialPassw0rd!');
  if (r.status === 200) await post(r, '/api/auth/change-password').send({ current: 'InitialPassw0rd!', next: PW });
  admin = await login('root@example.test', PW);
  expect(admin.status).toBe(200);
  mgr = await user(admin, 'smgr@example.test', 'MANAGER'); viewer = await user(admin, 'sview@example.test', 'VIEWER');
});
afterAll(async () => { await prisma.$disconnect(); await app.close(); });

describe('Безопасность: заголовки и транспорт', () => {
  it('ответы API содержат защитные заголовки и не раскрывают стек', async () => {
    const r = await request(app.getHttpServer()).get('/api/health');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-powered-by']).toBeUndefined();
    expect(r.headers['strict-transport-security']).toMatch(/max-age=/);
    expect(r.headers['content-security-policy']).toMatch(/default-src 'self'/);
    expect(r.headers['x-frame-options']).toBeTruthy();
    expect(r.headers['x-request-id']).toMatch(/^[\w-]{8,64}$/);
    const nf = await request(app.getHttpServer()).get('/api/no-such-route');
    expect(nf.status).toBe(404);
    expect(JSON.stringify(nf.body)).not.toMatch(/stack|node_modules|at .*\(/);
    const bad = await request(app.getHttpServer()).post('/api/auth/login').set('content-type', 'application/json').send('{"email": ');
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).not.toMatch(/stack|node_modules/);
  });

  it('переданный корректный X-Request-Id сохраняется, мусорный заменяется', async () => {
    const ok = await request(app.getHttpServer()).get('/api/health').set('x-request-id', 'abc12345-req');
    expect(ok.headers['x-request-id']).toBe('abc12345-req');
    const bad = await request(app.getHttpServer()).get('/api/health').set('x-request-id', 'bad id <script>');
    expect(bad.headers['x-request-id']).not.toContain('<');
  });

  it('CORS не включён: чужой origin не получает разрешения', async () => {
    const r = await request(app.getHttpServer()).get('/api/health').set('Origin', 'https://evil.example');
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
    const pre = await request(app.getHttpServer()).options('/api/auth/login').set('Origin', 'https://evil.example').set('Access-Control-Request-Method', 'POST');
    expect(pre.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('защищённый режим: cookie с префиксом __Host-, Secure, HttpOnly, SameSite=Lax, без Domain; обычное имя не принимается', async () => {
    process.env.COOKIE_SECURE = 'true';
    try {
      const l = await login('root@example.test', PW);
      const header = (l.res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('__Host-pf_session='))!;
      expect(header).toBeTruthy();
      expect(header).toMatch(/; Secure/i); expect(header).toMatch(/HttpOnly/i); expect(header).toMatch(/SameSite=Lax/i); expect(header).toMatch(/Path=\//);
      expect(header).not.toMatch(/Domain=/i);
      const token = header.split(';')[0].split('=')[1];
      expect((await request(app.getHttpServer()).get('/api/auth/me').set('Cookie', `__Host-pf_session=${token}`)).status).toBe(200);
      expect((await request(app.getHttpServer()).get('/api/auth/me').set('Cookie', `pf_session=${token}`)).status).toBe(401);
    } finally { delete process.env.COOKIE_SECURE; }
  });

  it('за прокси: IP клиента берётся из X-Forwarded-For, подделанные левые адреса игнорируются', async () => {
    const email = 'smgr@example.test';
    await request(app.getHttpServer()).post('/api/auth/login').set('X-Forwarded-For', '9.9.9.9, 203.0.113.7, 10.0.0.2').send({ email, password: PW + '2' });
    const a = await prisma.auditLog.findFirstOrThrow({ where: { action: 'auth.login', userEmail: email }, orderBy: { id: 'desc' } });
    expect(a.ip).toBe('203.0.113.7'); // 9.9.9.9 — подделка клиента, не доверяем
  });
});

describe('Безопасность: аутентификация и лимиты', () => {
  it('перебор пароля ограничивается (429) по IP клиента, другой клиент не затронут', async () => {
    const attacker = '203.0.113.200';
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await login('root@example.test', 'wrong-password-123', attacker)).status);
    expect(codes.slice(0, 4)).toEqual([401, 401, 401, 401]);
    expect(codes.slice(4).every((c) => c === 429)).toBe(true);
    expect((await login('root@example.test', PW, '203.0.113.201')).status).toBe(200);
  });

  it('просроченная и отозванная сессии не работают', async () => {
    const s = await login('root@example.test', PW);
    expect((await s.agent.get('/api/auth/me')).status).toBe(200);
    await prisma.session.updateMany({ where: { userId: (await prisma.user.findUniqueOrThrow({ where: { email: 'root@example.test' } })).id, id: { not: undefined } }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await s.agent.get('/api/auth/me')).status).toBe(401);
    admin = await login('root@example.test', PW); // новая сессия для остальных тестов
    expect(admin.status).toBe(200);
  });

  it('JSON-тело больше лимита отклоняется (413)', async () => {
    const r = await request(app.getHttpServer()).post('/api/auth/login').set('X-Forwarded-For', `${ip()}, 10.0.0.2`).send({ email: 'a@b.cc', password: 'x'.repeat(300_000) });
    expect(r.status).toBe(413);
  });

  it('загрузка файла больше лимита отклоняется (413) и ничего не сохраняет', async () => {
    const before = await prisma.importBatch.count();
    const big = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(2 * 1024 * 1024)]);
    const r = await post(mgr, '/api/imports').attach('file', big, 'huge.xlsx');
    expect(r.status).toBe(413);
    expect(await prisma.importBatch.count()).toBe(before);
  });
});

describe('Безопасность: инъекции и вредоносный ввод', () => {
  const payloads = ["' OR '1'='1", "'; DROP TABLE \"User\"; --", "%' UNION SELECT \"passwordHash\" FROM \"User\" --", '\\', '%', '_', "\u0000"];

  it('SQL-инъекции в поисковых параметрах не работают: запросы параметризованы, данные не раскрываются', async () => {
    const users = await prisma.user.count();
    for (const p of payloads) {
      const q = encodeURIComponent(p);
      for (const url of [`/api/suppliers?q=${q}`, `/api/contracts?q=${q}`, `/api/payments?q=${q}`, `/api/dashboard?project=${q}`, `/api/reports/debt-by-project?project=${q}`, `/api/calendar/month?year=2025&month=3&q=${q}`]) {
        const r = await viewer.agent.get(url);
        expect([200, 400], `${url} -> ${r.status}`).toContain(r.status);
        expect(JSON.stringify(r.body)).not.toMatch(/"passwordHash"\s*:|\$argon2/); // ни поля хеша, ни самого хеша (эхо строки фильтра — не утечка)
      }
    }
    expect(await prisma.user.count()).toBe(users);
    expect(await prisma.$queryRaw`SELECT to_regclass('public."User"')::text AS t`).toEqual([{ t: '"User"' }]);
  });

  it('параметры сортировки и фильтры проходят белый список', async () => {
    for (const url of ['/api/contracts?sort=amount;DROP', '/api/suppliers?sort=name%20DESC;--', '/api/payments?status=APPROVED%27--', '/api/reports/total-debt?currency=USD%27', '/api/fx/rates?status=HACK', '/api/suppliers?q=%00']) {
      expect((await viewer.agent.get(url)).status, url).toBe(400);
    }
  });

  it('XSS: вредоносное имя хранится как данные, API отдаёт JSON с nosniff (интерпретация в HTML невозможна)', async () => {
    const name = `<img src=x onerror=alert(1)>${randomUUID().slice(0, 6)}`;
    const c = await post(mgr, '/api/suppliers').send({ name });
    expect(c.status).toBe(201);
    const r = await viewer.agent.get(`/api/suppliers/${c.body.id}`);
    expect(r.headers['content-type']).toMatch(/application\/json/);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.body.name).toContain('<img');
  });

  it('права проверяются на сервере независимо от интерфейса: VIEWER не может менять данные прямыми запросами', async () => {
    for (const [m, u] of [['post', '/api/suppliers'], ['post', '/api/contracts'], ['post', '/api/payments'], ['post', '/api/calendar/plans'], ['post', '/api/users'], ['put', '/api/calendar/settings'], ['post', '/api/imports']] as const) {
      const r = await (viewer.agent as any)[m](u).set('x-csrf-token', viewer.csrf).send({});
      expect(r.status, `${m} ${u}`).toBe(403);
    }
  });
});

describe('Состояние системы', () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'pf-backups-')); });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); delete process.env.BACKUP_DIR; });
  const status = async () => (await admin.agent.get('/api/system/status')).body;
  const check = (s: any, id: string) => s.checks.find((c: any) => c.id === id);

  it('доступно только администраторам', async () => {
    expect((await viewer.agent.get('/api/system/status')).status).toBe(403);
    expect((await mgr.agent.get('/api/system/status')).status).toBe(403);
    expect((await request(app.getHttpServer()).get('/api/system/status')).status).toBe(401);
    const s = await status();
    expect(check(s, 'db')).toMatchObject({ status: 'ok' });
    expect(s.counters.migrations).toBeGreaterThan(5);
    const dump = JSON.stringify(s);
    for (const secret of [process.env.INITIAL_ADMIN_PASSWORD!, 'pf_test_password', process.env.TOKEN_ENCRYPTION_KEY].filter(Boolean) as string[]) expect(dump).not.toContain(secret);
    expect(dump).not.toMatch(/\$argon2|DATABASE_URL/);
  });

  it('резервные копии: нет каталога / пусто / свежая копия / устаревшая; проверка восстановления', async () => {
    delete process.env.BACKUP_DIR;
    expect(check(await status(), 'backup').status).toBe('warn'); // каталог не смонтирован
    process.env.BACKUP_DIR = dir;
    expect(check(await status(), 'backup')).toMatchObject({ status: 'error', detail: 'копий нет' });
    const f = join(dir, 'pf-20260101-000000.dump'); writeFileSync(f, 'x'.repeat(2048));
    let s = await status();
    expect(check(s, 'backup').status).toBe('ok');
    expect(check(s, 'restore').status).toBe('warn'); // проверка ещё не запускалась
    writeFileSync(join(dir, 'last-restore-test.json'), JSON.stringify({ at: new Date().toISOString(), ok: true, detail: 'таблиц 20, строк совпало' }));
    s = await status();
    expect(check(s, 'restore')).toMatchObject({ status: 'ok' });
    writeFileSync(join(dir, 'last-restore-test.json'), JSON.stringify({ at: new Date().toISOString(), ok: false, detail: 'расхождение в Payment' }));
    expect(check(await status(), 'restore')).toMatchObject({ status: 'error' });
    expect(check(await status(), 'restore').detail).toMatch(/НЕУДАЧНА/);
    const old = new Date(Date.now() - 80 * 3600_000); utimesSync(f, old, old);
    expect(check(await status(), 'backup').status).toBe('error'); // старше 72 ч
    expect((await status()).status).toBe('error');
  });

  it('предупреждает, что начальный пароль админа остался в окружении', async () => {
    expect(check(await status(), 'initial-admin').status).toBe('warn'); // в тестовом окружении INITIAL_ADMIN_PASSWORD задан
  });
});
