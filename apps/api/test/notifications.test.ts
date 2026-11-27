import { NotificationsService } from '../src/notifications/notifications.service';
import { testOutbox } from '../src/notifications/channels';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Лимит входа читается при загрузке модулей: задаём ДО динамического импорта приложения (security.test оставляет в окружении свои значения).
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.TRUST_PROXY_HOPS = '0';

let app: NestExpressApplication, prisma: PrismaClient;
const PW = 'StrongPassw0rd!x';
type S = { agent: ReturnType<typeof request.agent>; csrf: string };
async function login(email: string, password: string): Promise<S & { status: number; body: any }> {
  const agent = request.agent(app.getHttpServer());
  const r = await agent.post('/api/auth/login').send({ email, password });
  return { agent, csrf: r.body?.user?.csrfToken, status: r.status, body: r.body };
}
const post = (s: S, u: string) => s.agent.post(u).set('x-csrf-token', s.csrf);
const patch = (s: S, u: string) => s.agent.patch(u).set('x-csrf-token', s.csrf);
const del = (s: S, u: string) => s.agent.delete(u).set('x-csrf-token', s.csrf);
const get = (s: S, u: string) => s.agent.get(u);
/** Создаёт пользователя (встроенной или настраиваемой ролью) и проводит его через обязательную смену пароля. */
async function user(admin: S, email: string, who: { role?: string; customRoleId?: string }) {
  const c = await post(admin, '/api/users').send({ email, name: email.split('@')[0], ...who, password: PW });
  expect(c.status, JSON.stringify(c.body)).toBe(201);
  const a = await login(email, PW); await post(a, '/api/auth/change-password').send({ current: PW, next: PW + '2' });
  return { ...(await login(email, PW + '2')), id: c.body.id as string };
}
const uniq = () => randomUUID().slice(0, 8);
let admin: S, adm: S & { id: string }, mgr: S;
let tg: Server; const tgCalls: any[] = []; let tgFail = false; const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  tg = createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { tgCalls.push(JSON.parse(b || '{}')); res.setHeader('content-type', 'application/json'); res.statusCode = tgFail ? 400 : 200; res.end(JSON.stringify(tgFail ? { ok: false, description: 'chat not found' } : { ok: true })); }); });
  await new Promise<void>((r) => tg.listen(0, '127.0.0.1', r));
  const port = (tg.address() as any).port;
  for (const [k, v] of Object.entries({ TELEGRAM_BOT_TOKEN: 'TESTTOKEN', TELEGRAM_API_BASE: `http://127.0.0.1:${port}`, SMTP_HOST: 'test:json', SMTP_FROM: 'pf@example.test', APP_TIMEZONE: 'Asia/Tashkent', APP_BASE_URL: 'https://pf.example.test' })) { saved[k] = process.env[k]; process.env[k] = v; }
  const { createApp } = await import('../src/app.factory');
  app = await createApp({ logger: false }); await app.init(); prisma = new PrismaClient();
  const r = await login('root@example.test', 'InitialPassw0rd!');
  if (r.status === 200) await post(r, '/api/auth/change-password').send({ current: 'InitialPassw0rd!', next: PW });
  const root = await login('root@example.test', PW);
  expect(root.status, JSON.stringify(root.body)).toBe(200);
  admin = root;
  adm = await user(admin, `rl-admin-${uniq()}@example.test`, { role: 'ADMIN' });
  mgr = await user(admin, `rl-mgr-${uniq()}@example.test`, { role: 'MANAGER' });
});
afterAll(async () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } await new Promise((r) => tg.close(r)); await prisma.$disconnect(); await app.close(); });


const put = (s: S, u: string) => s.agent.put(u).set('x-csrf-token', s.csrf);
const base = { enabled: true, hour: 8, weekdaysOnly: false, leadDays: 3, telegramChatIds: ['123456789'], emails: ['boss@example.test'], include: { overdue: true, upcoming: true, pending: true, plant: true, fx: true, system: true }, alerts: true };

describe('уведомления: настройки и права', () => {
  it('только администратор; валидация получателей; сохранение пишется в аудит', async () => {
    expect((await get(mgr, '/api/notifications/settings')).status).toBe(403);
    expect((await put(mgr, '/api/notifications/settings').send(base)).status).toBe(403);
    const d = (await get(admin, '/api/notifications/settings')).body;
    expect(d.settings).toMatchObject({ enabled: false, hour: 8, leadDays: 3 });
    expect(d.channels).toMatchObject({ telegram: true, email: true, timezone: 'Asia/Tashkent' });
    expect((await put(admin, '/api/notifications/settings').send({ ...base, telegramChatIds: ['не-id'] })).status).toBe(400);
    expect((await put(admin, '/api/notifications/settings').send({ ...base, emails: ['no-at'] })).status).toBe(400);
    expect((await put(admin, '/api/notifications/settings').send({ ...base, hour: 24 })).status).toBe(400);
    expect((await put(admin, '/api/notifications/settings').send({ ...base, extra: 1 })).status).toBe(400);
    expect((await put(admin, '/api/notifications/settings').send(base)).status).toBe(200);
    expect(await prisma.auditLog.count({ where: { action: 'notifications.settings' } })).toBeGreaterThan(0);
  });

  it('предпросмотр: тот же состав, что в сообщении; ничего не отправляется', async () => {
    tgCalls.length = 0; testOutbox.length = 0;
    const r = (await get(admin, '/api/notifications/preview')).body;
    expect(r.text).toMatch(/Procurement Finance — сводка на/);
    expect(r.text).toMatch(/Просрочено|Просроченных обязательств нет/);
    expect(r.text).toMatch(/Цветок:/);
    expect(r.digest).toMatchObject({ overdue: expect.any(Object), upcoming: { horizonDays: 3 }, pending: expect.any(Object), plant: expect.any(Object) });
    expect(tgCalls.length + testOutbox.length).toBe(0);
  });
});

describe('уведомления: отправка', () => {
  it('пробное сообщение уходит в Telegram и на почту; ошибка одного канала не мешает другому', async () => {
    tgCalls.length = 0; testOutbox.length = 0; tgFail = false;
    const ok = (await post(admin, '/api/notifications/test').send({})).body;
    expect(ok).toMatchObject({ sent: 2, errors: [] });
    expect(tgCalls[0]).toMatchObject({ chat_id: '123456789' });
    expect(testOutbox[0]).toMatchObject({ to: 'boss@example.test' });
    tgFail = true; tgCalls.length = 0; testOutbox.length = 0;
    const bad = (await post(admin, '/api/notifications/test').send({})).body;
    expect(bad.sent).toBe(1); expect(bad.errors.join()).toMatch(/chat not found/);
    expect(testOutbox).toHaveLength(1);
    tgFail = false;
  });

  it('сводка вручную: текст со ссылкой на приложение; без получателей — понятная ошибка', async () => {
    tgCalls.length = 0; testOutbox.length = 0;
    const r = (await post(admin, '/api/notifications/send-digest').send({})).body;
    expect(r.sent).toBe(2);
    expect(testOutbox[0]!.subject).toMatch(/^Procurement Finance: сводка \d{4}-\d{2}-\d{2}/);
    expect(testOutbox[0]!.text).toContain('https://pf.example.test');
    await put(admin, '/api/notifications/settings').send({ ...base, telegramChatIds: [], emails: [] });
    const none = (await post(admin, '/api/notifications/send-digest').send({})).body;
    expect(none.sent).toBe(0); expect(none.errors.join()).toMatch(/Не указано ни одного получателя/);
    await put(admin, '/api/notifications/settings').send(base);
  });
});

describe('уведомления: расписание воркера', () => {
  const svc = () => app.get(NotificationsService);
  const reset = async () => { await prisma.appSetting.deleteMany({ where: { key: 'notificationsState' } }); tgCalls.length = 0; testOutbox.length = 0; };

  it('сводка раз в сутки после заданного часа (Ташкент); до часа — нет; повтор в тот же день — нет; завтра — снова', async () => {
    await reset(); await put(admin, '/api/notifications/settings').send({ ...base, alerts: false });
    expect((await svc().tick(new Date('2026-11-23T02:00:00Z'))).digest).toBe(false); // 07:00 местного, час 08 ещё не наступил
    expect((await svc().tick(new Date('2026-11-23T04:00:00Z'))).digest).toBe(true);  // 09:00
    expect(testOutbox).toHaveLength(1);
    expect((await svc().tick(new Date('2026-11-23T09:00:00Z'))).digest).toBe(false); // тот же день
    expect((await svc().tick(new Date('2026-11-24T04:00:00Z'))).digest).toBe(true);  // следующий день
    expect(testOutbox).toHaveLength(2);
  });

  it('только по будням; выключено — тишина; сбой доставки не помечает день отправленным (повтор на следующем такте)', async () => {
    await reset(); await put(admin, '/api/notifications/settings').send({ ...base, weekdaysOnly: true, alerts: false });
    expect((await svc().tick(new Date('2026-11-29T05:00:00Z'))).digest).toBe(false); // воскресенье
    expect((await svc().tick(new Date('2026-11-30T05:00:00Z'))).digest).toBe(true);  // понедельник
    await reset(); await put(admin, '/api/notifications/settings').send({ ...base, enabled: false });
    expect(await svc().tick(new Date('2026-12-01T05:00:00Z'))).toEqual({ digest: false, alert: false });
    await reset(); await put(admin, '/api/notifications/settings').send({ ...base, emails: [], alerts: false });
    tgFail = true;
    expect((await svc().tick(new Date('2026-12-02T05:00:00Z'))).digest).toBe(false);
    expect((await svc().state()).lastDigestDate).toBeUndefined();
    tgFail = false;
    expect((await svc().tick(new Date('2026-12-02T05:10:00Z'))).digest).toBe(true); // следующий такт — повтор удался
  });

  it('тревога о проблеме системы: один раз, напоминание через сутки, сообщение об устранении', async () => {
    await reset(); await put(admin, '/api/notifications/settings').send({ ...base, hour: 23, alerts: true }); // сводка не мешает
    const stale = new Date(Date.now() - 20 * 60_000).toISOString(); // воркер молчит 20 минут — «Проблема»
    await prisma.appSetting.upsert({ where: { key: 'workerHeartbeat' }, create: { key: 'workerHeartbeat', value: { at: stale } }, update: { value: { at: stale } } });
    const t0 = new Date('2026-12-03T05:00:00Z');
    expect((await svc().tick(t0)).alert).toBe(true);
    expect(testOutbox.at(-1)!.text).toMatch(/Фоновый воркер/);
    const n = testOutbox.length;
    expect((await svc().tick(new Date(t0.getTime() + 10 * 60_000))).alert).toBe(false); // та же проблема — не повторяем
    expect(testOutbox).toHaveLength(n);
    expect((await svc().tick(new Date(t0.getTime() + 25 * 3600_000))).alert).toBe(true); // напоминание через сутки
    const fresh = new Date().toISOString();
    await prisma.appSetting.update({ where: { key: 'workerHeartbeat' }, data: { value: { at: fresh } } });
    await svc().tick(new Date(t0.getTime() + 26 * 3600_000));
    expect(testOutbox.at(-1)!.text).toMatch(/устранены/);
    await put(admin, '/api/notifications/settings').send({ ...base, enabled: false });
  });
});

describe('курсы ЦБ', () => {
  let cbu: Server; let payload: any = []; let status = 200;
  beforeAll(async () => {
    cbu = createServer((_req, res) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(payload)); });
    await new Promise<void>((r) => cbu.listen(0, '127.0.0.1', r));
    saved.CBU_URL = process.env.CBU_URL; process.env.CBU_URL = `http://127.0.0.1:${(cbu.address() as any).port}/`;
  });
  afterAll(async () => { if (saved.CBU_URL === undefined) delete process.env.CBU_URL; else process.env.CBU_URL = saved.CBU_URL; await new Promise((r) => cbu.close(r)); });
  const fetchRates = (s: S) => post(s, '/api/fx/fetch-cbu').send({});
  const rows = (date: string, usd = '12100.50', rub = '139.1') => [
    { Ccy: 'USD', Nominal: '1', Rate: usd, Date: date }, { Ccy: 'EUR', Nominal: '1', Rate: '13480.00', Date: date },
    { Ccy: 'RUB', Nominal: '10', Rate: String(Number(rub) * 10), Date: date }, { Ccy: 'KZT', Nominal: '1', Rate: '25', Date: date },
  ];

  it('курсы создаются «ожидает подтверждения» (не применяются), номинал учитывается, повтор не дублирует; нужны права fx.manage', async () => {
    payload = rows('27.12.2031');
    expect((await fetchRates(viewerOf())).status).toBe(403);
    const r = await fetchRates(admin);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.created.map((x: any) => x.currency).sort()).toEqual(['EUR', 'RUB', 'USD']);
    const usd = await prisma.fxRate.findFirstOrThrow({ where: { currency: 'USD', effectiveDate: new Date('2031-12-27') } });
    expect(usd).toMatchObject({ status: 'PENDING_CONFIRMATION', source: 'CBU:cbu.uz' });
    expect(usd.uzsPerUnit.toFixed(2)).toBe('12100.50');
    expect((await prisma.fxRate.findFirstOrThrow({ where: { currency: 'RUB', effectiveDate: new Date('2031-12-27') } })).uzsPerUnit.toFixed(2)).toBe('139.10'); // 1391 за 10 → 139,1 за 1
    const again = await fetchRates(admin);
    expect(again.body.created).toEqual([]); expect(again.body.skipped).toHaveLength(3);
    // отклонённый курс повторно не предлагается
    await prisma.fxRate.update({ where: { id: usd.id }, data: { status: 'REJECTED' } });
    expect((await fetchRates(admin)).body.skipped.find((x: any) => x.currency === 'USD').reason).toMatch(/отклонена/);
    // изменившийся курс на ту же дату — новая запись
    payload = rows('27.12.2031', '12111.00');
    expect((await fetchRates(admin)).body.created.map((x: any) => x.currency)).toEqual(['USD']);
    expect((await prisma.auditLog.count({ where: { action: 'fx.cbu_fetch' } }))).toBeGreaterThanOrEqual(4);
  });

  it('сбой ЦБ и мусор в ответе — понятная ошибка, ничего не создаётся', async () => {
    status = 503; payload = {};
    const bad = await fetchRates(admin);
    expect(bad.status).toBe(400); expect(bad.body.message).toMatch(/Не удалось получить курсы ЦБ/);
    status = 200; payload = [{ Ccy: 'USD', Nominal: '1', Rate: 'abc', Date: '28.12.2031' }];
    const r = (await fetchRates(admin)).body;
    expect(r.created).toEqual([]); expect(r.skipped.find((x: any) => x.currency === 'USD').reason).toMatch(/некорректные/);
    payload = [];
  });
  const viewerOf = () => mgr; // MANAGER без fx.manage
});
