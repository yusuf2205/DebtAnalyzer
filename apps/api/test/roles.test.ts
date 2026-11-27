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

const mkRole = (s: S, name: string, permissions: string[], description?: string) => post(s, '/api/roles').send({ name, permissions, description });

describe('настраиваемые роли: создание и проверки', () => {
  it('SUPER_ADMIN создаёт роль с набором прав; список показывает встроенные и настраиваемые', async () => {
    const name = `Бухгалтер ${uniq()}`;
    const r = await mkRole(admin, name, ['payments.create', 'payments.view', 'dashboard.view'], 'Вводит платежи');
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.permissions).toEqual(['dashboard.view', 'payments.view', 'payments.create']); // в порядке каталога прав, без повторов
    const list = (await get(admin, '/api/roles')).body;
    expect(list.builtin.map((b: any) => b.key)).toEqual(['SUPER_ADMIN', 'ADMIN', 'FINANCE', 'MANAGER', 'VIEWER']);
    expect(list.custom.find((c: any) => c.name === name)).toMatchObject({ userCount: 0, description: 'Вводит платежи' });
  });

  it('создавать/менять/удалять роли может только SUPER_ADMIN; ADMIN и MANAGER — 403, просмотр списка — по праву users.view', async () => {
    expect((await mkRole(adm, `Нельзя ${uniq()}`, ['dashboard.view'])).status).toBe(403);
    expect((await mkRole(mgr, `Нельзя ${uniq()}`, ['dashboard.view'])).status).toBe(403);
    expect((await get(adm, '/api/roles')).status).toBe(200);
    expect((await get(mgr, '/api/roles')).status).toBe(403); // у MANAGER нет users.view
    const own = (await mkRole(admin, `Для проверки ${uniq()}`, ['dashboard.view'])).body.id;
    expect((await patch(adm, `/api/roles/${own}`).send({ name: 'Взлом', permissions: ['dashboard.view'] })).status).toBe(403);
    expect((await del(adm, `/api/roles/${own}`)).status).toBe(403);
  });

  it('валидация: пустой набор, неизвестные права, roles.manage, зависимости, занятые имена', async () => {
    const n = () => `Роль ${uniq()}`;
    expect((await mkRole(admin, n(), [])).body.message).toMatch(/хотя бы одно право/);
    expect((await mkRole(admin, n(), ['nope.view'])).body.message).toMatch(/Неизвестные права/);
    expect((await mkRole(admin, n(), ['dashboard.view', 'roles.manage'])).body.message).toMatch(/только SUPER_ADMIN/);
    const dep = await mkRole(admin, n(), ['payments.approve']);
    expect(dep.status).toBe(400); expect(dep.body.message).toMatch(/Подтверждение и отклонение платежей.*требует права.*Просмотр платежей/);
    expect((await mkRole(admin, 'A', ['dashboard.view'])).status).toBe(400); // слишком короткое имя
    expect((await mkRole(admin, 'viewer', ['dashboard.view'])).body.message).toMatch(/занято встроенной/);
    expect((await mkRole(admin, 'Финансы', ['dashboard.view'])).body.message).toMatch(/занято встроенной/);
    const name = `Дубль ${uniq()}`;
    expect((await mkRole(admin, name, ['dashboard.view'])).status).toBe(201);
    expect((await mkRole(admin, name.toUpperCase(), ['dashboard.view'])).status).toBe(409); // без учёта регистра
  });

  it('база данных сама отклоняет roles.manage в настраиваемой роли и дубли имён без учёта регистра', async () => {
    await expect(prisma.customRole.create({ data: { name: `DB-${uniq()}`, permissions: ['roles.manage'] } })).rejects.toThrow();
    const name = `DbDup-${uniq()}`;
    await prisma.customRole.create({ data: { name, permissions: ['dashboard.view'] } });
    await expect(prisma.customRole.create({ data: { name: name.toLowerCase(), permissions: ['dashboard.view'] } })).rejects.toThrow();
  });
});

describe('настраиваемые роли: права действуют на сервере', () => {
  it('пользователь получает ровно отмеченные права; остальное — 403; изменение роли действует сразу, без повторного входа', async () => {
    const role = (await mkRole(admin, `Снабженец ${uniq()}`, ['dashboard.view', 'payments.view', 'payments.create'])).body;
    const u = await user(admin, `rl-u1-${uniq()}@example.test`, { customRoleId: role.id });
    const me = (await get(u, '/api/auth/me')).body.user;
    expect(me.customRole).toEqual({ id: role.id, name: role.name });
    expect(me.permissions).toEqual(['dashboard.view', 'payments.view', 'payments.create']);

    expect((await get(u, '/api/payments')).status).toBe(200);
    expect((await get(u, '/api/suppliers')).status).toBe(403); // нет suppliers.view
    expect((await get(u, '/api/users')).status).toBe(403);
    expect((await post(u, `/api/payments/${randomUUID()}/approve`).send({})).status).toBe(403);
    expect((await mkRole(u, `X ${uniq()}`, ['dashboard.view'])).status).toBe(403);

    // добавили право — действует на той же сессии
    expect((await patch(admin, `/api/roles/${role.id}`).send({ name: role.name, permissions: ['dashboard.view', 'payments.view', 'payments.create', 'suppliers.view'] })).status).toBe(200);
    expect((await get(u, '/api/suppliers')).status).toBe(200);
    // убрали — доступ закрыт сразу
    expect((await patch(admin, `/api/roles/${role.id}`).send({ name: role.name, permissions: ['dashboard.view', 'payments.view'] })).status).toBe(200);
    expect((await get(u, '/api/suppliers')).status).toBe(403);
    expect((await post(u, '/api/payments').send({ contractId: randomUUID(), paymentDate: '2026-01-01', amount: '1', idempotencyKey: randomUUID() })).status).toBe(403); // payments.create убрано
  });

  it('настраиваемая роль «Казначей» реально подтверждает платёж; правило «не подтверждать свой платёж» сохраняется', async () => {
    const role = (await mkRole(admin, `Казначей ${uniq()}`, ['dashboard.view', 'payments.view', 'payments.create', 'payments.approve', 'contracts.view'])).body;
    const tre = await user(admin, `rl-tre-${uniq()}@example.test`, { customRoleId: role.id });
    const sup = (await post(mgr, '/api/suppliers').send({ name: `RL-SUP-${uniq()}` })).body.id;
    const c = (await post(mgr, '/api/contracts').send({ supplierId: sup, number: `RL-${uniq()}`, amount: '1000', currency: 'USD', openingPaid: '0' })).body.id;
    const p = await post(mgr, '/api/payments').send({ contractId: c, paymentDate: '2026-01-10', amount: '300', submit: true, idempotencyKey: randomUUID() });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    expect((await post(tre, `/api/payments/${p.body.id}/approve`).send({})).status).toBe(201);
    expect((await get(admin, `/api/contracts/${c}`)).body.debt).toBe('700.00');

    const own = await post(tre, '/api/payments').send({ contractId: c, paymentDate: '2026-01-11', amount: '100', submit: true, idempotencyKey: randomUUID() });
    expect(own.status).toBe(201);
    expect((await post(tre, `/api/payments/${own.body.id}/approve`).send({})).status).toBe(403); // свой платёж подтверждать нельзя
  });

  it('удалить роль с пользователями нельзя; после переназначения — можно; сессии при смене роли сбрасываются', async () => {
    const role = (await mkRole(admin, `Временная ${uniq()}`, ['dashboard.view'])).body;
    const u = await user(admin, `rl-u2-${uniq()}@example.test`, { customRoleId: role.id });
    const blocked = await del(admin, `/api/roles/${role.id}`);
    expect(blocked.status).toBe(409); expect(blocked.body.message).toMatch(/назначена пользователям \(1\)/);

    const sw = await patch(admin, `/api/users/${u.id}`).send({ role: 'VIEWER' });
    expect(sw.status).toBe(200); expect(sw.body.customRole).toBeNull(); expect(sw.body.role).toBe('VIEWER');
    expect((await get(u, '/api/auth/me')).status).toBe(401); // сессия отозвана при смене роли
    expect((await del(admin, `/api/roles/${role.id}`)).status).toBe(200);
    expect((await get(admin, '/api/roles')).body.custom.some((c: any) => c.id === role.id)).toBe(false);
  });

  it('роль и customRoleId одновременно — 400; несуществующая роль — 400; без роли — 400', async () => {
    const role = (await mkRole(admin, `Для ошибок ${uniq()}`, ['dashboard.view'])).body;
    const base = { email: `rl-e-${uniq()}@example.test`, name: 'E', password: PW };
    expect((await post(admin, '/api/users').send({ ...base, role: 'VIEWER', customRoleId: role.id })).status).toBe(400);
    expect((await post(admin, '/api/users').send({ ...base, customRoleId: randomUUID() })).status).toBe(400);
    expect((await post(admin, '/api/users').send(base)).status).toBe(400);
  });
});

describe('настраиваемые роли: защита от повышения привилегий и аудит', () => {
  it('ADMIN не может назначить роль с правами, которых нет у него самого (подтверждение платежей); SUPER_ADMIN — может', async () => {
    const role = (await mkRole(admin, `Сильная ${uniq()}`, ['payments.view', 'payments.approve'])).body;
    const email = `rl-e2-${uniq()}@example.test`;
    expect((await post(adm, '/api/users').send({ email, name: 'E2', customRoleId: role.id, password: PW })).status).toBe(403);
    expect((await post(admin, '/api/users').send({ email, name: 'E2', customRoleId: role.id, password: PW })).status).toBe(201);
    // менее сильную роль ADMIN назначить может
    const weak = (await mkRole(admin, `Слабая ${uniq()}`, ['dashboard.view'])).body;
    expect((await post(adm, '/api/users').send({ email: `rl-e3-${uniq()}@example.test`, name: 'E3', customRoleId: weak.id, password: PW })).status).toBe(201);
  });

  it('пользователь с настраиваемой ролью не может менять собственную роль', async () => {
    const role = (await mkRole(admin, `Менеджер прав ${uniq()}`, ['users.view', 'users.manage'])).body;
    const u = await user(admin, `rl-self-${uniq()}@example.test`, { customRoleId: role.id });
    expect((await patch(u, `/api/users/${u.id}`).send({ role: 'ADMIN' })).status).toBe(400); // «Нельзя изменить собственную роль»
  });

  it('создание, изменение и удаление ролей попадают в журнал аудита с составом изменений', async () => {
    const name = `Аудит ${uniq()}`;
    const r = (await mkRole(admin, name, ['dashboard.view'])).body;
    await patch(admin, `/api/roles/${r.id}`).send({ name, permissions: ['dashboard.view', 'reports.view'] });
    await del(admin, `/api/roles/${r.id}`);
    const rows = await prisma.auditLog.findMany({ where: { entityId: r.id }, orderBy: { at: 'asc' } });
    expect(rows.map((x) => x.action)).toEqual(['role.create', 'role.update', 'role.delete']);
    expect((rows[1]!.meta as any)).toMatchObject({ added: ['reports.view'], removed: [] });
  });
});
