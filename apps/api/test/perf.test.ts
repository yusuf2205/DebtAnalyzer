import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
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

beforeAll(async () => {
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
afterAll(async () => { await prisma.$disconnect(); await app.close(); });


const N_SUP = 309, N_CON = 706;
const RUN = `perf${Date.now() % 1e6}`;
const timings: Record<string, number> = {};
const time = async (name: string, fn: () => Promise<{ status: number; body?: any }>, limitMs: number) => {
  const t0 = performance.now(); const r = await fn(); const ms = Math.round(performance.now() - t0);
  timings[name] = ms;
  expect(r.status, name).toBe(200);
  expect(ms, `${name}: ${ms} мс при пределе ${limitMs}`).toBeLessThan(limitMs);
  return r;
};

describe('нагрузка: данные реального размера (706 договоров, 309 контрагентов)', () => {
  beforeAll(async () => {
    const sups = Array.from({ length: N_SUP }, (_, i) => ({ id: randomUUID(), name: `${RUN} Поставщик ${i} ${i % 3 === 0 ? 'MCHJ' : 'LTD'}` }));
    await prisma.supplier.createMany({ data: sups });
    const cur = ['UZS', 'UZS', 'UZS', 'USD', 'EUR', 'RUB'] as const;
    const cons = Array.from({ length: N_CON }, (_, i) => ({ id: randomUUID(), supplierId: sups[i % N_SUP]!.id, number: `${RUN}-${i}`, project: `Проект ${i % 12}`, executor: `Исп ${i % 7}`, amount: String(1_000_000 + i * 1000), currency: cur[i % cur.length]!, openingPaid: String((i % 5) * 100_000), identityKey: `${RUN}|${i}`, status: 'ACTIVE' as const }));
    await prisma.contract.createMany({ data: cons });
    const now = new Date(); const y = now.getFullYear(), m = now.getMonth() + 1;
    await prisma.planEntry.createMany({ data: cons.flatMap((c, i) => [1, 2].map((w) => ({ contractId: c.id, year: y, month: m, week: w + (i % 2), amount: '100000', currency: c.currency, source: 'IMPORT' as const }))) });
    const mgrUser = await prisma.user.findFirstOrThrow({ where: { role: 'SUPER_ADMIN' } });
    await prisma.payment.createMany({ data: cons.filter((_, i) => i % 3 === 0).map((c, i) => ({ id: randomUUID(), contractId: c.id, paymentDate: new Date(), amount: '50000', currency: c.currency, kind: 'PAYMENT' as const, status: 'APPROVED' as const, createdById: mgrUser.id, approvedById: mgrUser.id, approvedAt: new Date(), signedAmount: '50000', idempotencyKey: `${RUN}-${i}` })) });
  }, 120_000);
  afterAll(async () => {
    const ids = (await prisma.contract.findMany({ where: { number: { startsWith: RUN } }, select: { id: true } })).map((c) => c.id);
    // БД не даёт удалять подтверждённые платежи (так и должно быть) — для уборки тестовых данных защита снимается на время одной транзакции
    await prisma.$transaction([prisma.$executeRawUnsafe('ALTER TABLE "Payment" DISABLE TRIGGER USER'), prisma.payment.deleteMany({ where: { contractId: { in: ids } } }), prisma.$executeRawUnsafe('ALTER TABLE "Payment" ENABLE TRIGGER USER')]);
    await prisma.planEntry.deleteMany({ where: { contractId: { in: ids } } });
    await prisma.contract.deleteMany({ where: { id: { in: ids } } });
    await prisma.supplier.deleteMany({ where: { name: { startsWith: RUN } } });
    console.log('[нагрузка] время ответа, мс:', JSON.stringify(timings));
  }, 120_000);

  const get = (u: string) => admin.agent.get(u).then((r) => ({ status: r.status, body: r.body }));

  it('списки с 500 строками отвечают быстро', async () => {
    const c = await time('договоры 500 строк', () => get(`/api/contracts?q=${RUN}&pageSize=500&sort=debt&dir=desc`), 3000);
    expect(c.body.total).toBe(N_CON); expect(c.body.items).toHaveLength(500);
    const s = await time('контрагенты 500 строк', () => get(`/api/suppliers?q=${RUN}&pageSize=500`), 3000);
    expect(s.body.total).toBe(N_SUP);
    await time('платежи 500 строк', () => get(`/api/payments?q=${RUN}&pageSize=500`), 3000);
    await time('договоры, фильтр по типу', () => get(`/api/contracts?q=${RUN}&origin=LOCAL&pageSize=500`), 3000);
    await time('договоры, вторая страница', () => get(`/api/contracts?q=${RUN}&pageSize=300&page=2`), 3000);
  }, 60_000);

  it('Dashboard, календарь, отчёты и поиск на полном портфеле', async () => {
    const d = await time('Dashboard', () => get('/api/dashboard'), 6000);
    expect(d.body.kpi.contracts).toBeGreaterThanOrEqual(N_CON);
    await time('Dashboard с фильтром типа', () => get('/api/dashboard?origin=FOREIGN'), 6000);
    const now = new Date();
    await time('календарь, месяц', () => get(`/api/calendar/month?year=${now.getFullYear()}&month=${now.getMonth() + 1}`), 5000);
    await time('календарь, дни', () => get(`/api/calendar/days?year=${now.getFullYear()}&month=${now.getMonth() + 1}`), 3000);
    await time('отчёт: долги по договорам', () => get('/api/reports/debt-by-contract'), 6000);
    await time('отчёт: общая задолженность', () => get('/api/reports/total-debt'), 6000);
    await time('быстрый поиск: договоры', () => get(`/api/contracts?q=${RUN}-70&pageSize=6&status=ALL`), 2000);
    await time('панель договора', async () => { const id = (await prisma.contract.findFirstOrThrow({ where: { number: `${RUN}-5` } })).id; return get(`/api/contracts/${id}`); }, 1500);
  }, 120_000);
});
