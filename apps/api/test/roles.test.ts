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

describe('встроенные роли: настройка прав', () => {
  it('SUPER_ADMIN меняет права VIEWER — действует сразу; сброс возвращает стандартные; SUPER_ADMIN менять нельзя; другим — 403', async () => {
    const v = await user(admin, `rl-viewer-${uniq()}@example.test`, { role: 'VIEWER' });
    try {
      expect((await get(v, '/api/contracts')).status).toBe(200);
      const std = (await get(admin, '/api/roles')).body.builtin.find((b: any) => b.key === 'VIEWER');
      expect(std).toMatchObject({ editable: true, customized: false });

      expect((await patch(adm, '/api/roles/builtin/VIEWER').send({ permissions: ['dashboard.view'] })).status).toBe(403);
      expect((await patch(admin, '/api/roles/builtin/SUPER_ADMIN').send({ permissions: ['dashboard.view'] })).status).toBe(400);
      expect((await patch(admin, '/api/roles/builtin/NOPE').send({ permissions: ['dashboard.view'] })).status).toBe(404);
      expect((await patch(admin, '/api/roles/builtin/VIEWER').send({ permissions: ['dashboard.view', 'roles.manage'] })).status).toBe(400);
      expect((await patch(admin, '/api/roles/builtin/VIEWER').send({ permissions: [] })).status).toBe(400);

      const r = await patch(admin, '/api/roles/builtin/VIEWER').send({ permissions: ['dashboard.view'] });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect((await get(v, '/api/contracts')).status).toBe(403); // сразу, без повторного входа
      expect((await get(v, '/api/auth/me')).body.user.permissions).toEqual(['dashboard.view']);
      const after = (await get(admin, '/api/roles')).body.builtin.find((b: any) => b.key === 'VIEWER');
      expect(after).toMatchObject({ customized: true, permissions: ['dashboard.view'] });
      expect(after.defaults.length).toBeGreaterThan(1);

      expect((await del(admin, '/api/roles/builtin/VIEWER')).status).toBe(200);
      expect((await get(v, '/api/contracts')).status).toBe(200);
      const log = await prisma.auditLog.findMany({ where: { entity: 'RoleOverride', entityId: 'VIEWER' }, orderBy: { at: 'desc' }, take: 2 });
      expect(log.map((l) => l.action).sort()).toEqual(['role.builtin_reset', 'role.builtin_update']);
    } finally { await prisma.roleOverride.deleteMany({ where: { role: 'VIEWER' } }); }
  });

  it('права, добавленные встроенной роли сверх стандартных, ADMIN выдать не может, если их нет у него; БД не принимает SUPER_ADMIN и roles.manage', async () => {
    try {
      expect((await patch(admin, '/api/roles/builtin/MANAGER').send({ permissions: ['dashboard.view', 'payments.view', 'payments.approve'] })).status).toBe(200);
      const email = `rl-esc-${uniq()}@example.test`;
      expect((await post(adm, '/api/users').send({ email, name: 'x', role: 'MANAGER', password: PW })).status).toBe(403);
      expect((await post(adm, '/api/users').send({ email, name: 'x', role: 'FINANCE', password: PW })).status).toBe(201); // стандартная роль — как раньше
      expect((await post(admin, '/api/users').send({ email: `rl-esc2-${uniq()}@example.test`, name: 'x', role: 'MANAGER', password: PW })).status).toBe(201);
    } finally { await prisma.roleOverride.deleteMany({ where: { role: 'MANAGER' } }); }
    await expect(prisma.roleOverride.create({ data: { role: 'SUPER_ADMIN', permissions: ['dashboard.view'] } })).rejects.toThrow();
    await expect(prisma.roleOverride.create({ data: { role: 'VIEWER', permissions: ['roles.manage'] } })).rejects.toThrow();
  });
});

describe('массовые действия над договорами', () => {
  async function three() {
    const sup = (await post(admin, '/api/suppliers').send({ name: `BULK-${uniq()}` })).body.id;
    const mk = async () => (await post(admin, '/api/contracts').send({ supplierId: sup, number: `BK-${uniq()}`, amount: '1000', currency: 'USD', openingPaid: '0' })).body.id as string;
    return [await mk(), await mk(), await mk()];
  }
  const bulk = (s: S, body: object) => post(s, '/api/contracts/bulk').send(body);

  it('архив/восстановление/исполнитель: счётчики, повторы пропускаются, архивным исполнителя не меняют; каждое изменение — в аудите с пометкой bulk', async () => {
    const [a, b, c] = await three();
    expect((await bulk(mgr, { action: 'archive', ids: [a, b] })).body).toEqual({ updated: 2, skipped: 0 });
    expect((await bulk(mgr, { action: 'archive', ids: [a, b, randomUUID()] })).body).toEqual({ updated: 0, skipped: 3 }); // уже в архиве / не найден
    const ex = await bulk(mgr, { action: 'executor', ids: [a, c], executor: 'Иванов' });
    expect(ex.body).toEqual({ updated: 1, skipped: 1 }); // архивный a пропущен
    expect((await prisma.contract.findUniqueOrThrow({ where: { id: c } })).executor).toBe('Иванов');
    expect((await prisma.contract.findUniqueOrThrow({ where: { id: a } })).executor).toBeNull();
    expect((await bulk(mgr, { action: 'executor', ids: [c], executor: null })).body).toEqual({ updated: 1, skipped: 0 }); // очистка
    expect((await bulk(mgr, { action: 'restore', ids: [a] })).body).toEqual({ updated: 1, skipped: 0 });
    const log = await prisma.auditLog.findMany({ where: { entityId: { in: [a, b, c] }, entity: 'Contract' } });
    const bulkLogs = log.filter((l) => (l.meta as any)?.bulk);
    expect(bulkLogs.map((l) => l.action).sort()).toEqual(['contract.archive', 'contract.archive', 'contract.restore', 'contract.update', 'contract.update']);
  });

  it('права как у одиночных операций; валидация; суммы массово не меняются', async () => {
    const [a] = await three();
    const viewer = await user(admin, `rl-bv-${uniq()}@example.test`, { role: 'VIEWER' });
    expect((await bulk(viewer, { action: 'archive', ids: [a] })).status).toBe(403);
    // роль с «архивированием», но без «изменения договоров»
    const role = (await mkRole(admin, `Архивариус ${uniq()}`, ['contracts.view', 'contracts.archive'])).body;
    const arch = await user(admin, `rl-ba-${uniq()}@example.test`, { customRoleId: role.id });
    expect((await bulk(arch, { action: 'executor', ids: [a], executor: 'X' })).status).toBe(403);
    expect((await bulk(arch, { action: 'archive', ids: [a] })).body).toEqual({ updated: 1, skipped: 0 });
    expect((await bulk(admin, { action: 'archive', ids: [] })).status).toBe(400);
    expect((await bulk(admin, { action: 'archive', ids: Array.from({ length: 501 }, () => randomUUID()) })).status).toBe(400);
    expect((await bulk(admin, { action: 'executor', ids: [a] })).status).toBe(400); // не указан исполнитель
    expect((await bulk(admin, { action: 'archive', ids: ['not-a-uuid'] })).status).toBe(400);
    expect((await bulk(admin, { action: 'amount', ids: [a] })).status).toBe(400);   // других действий нет
  });
});

describe('местный / зарубежный', () => {
  async function pair() {
    const mkSup = async (name: string) => (await post(admin, '/api/suppliers').send({ name })).body.id as string;
    const mk = async (supplierId: string, currency: string) => (await post(admin, '/api/contracts').send({ supplierId, number: `OR-${uniq()}`, amount: '1000', currency, openingPaid: '0' })).body.id as string;
    const tag = uniq();
    const local = await mk(await mkSup(`LOC-${tag} MCHJ`), 'USD');      // MCHJ → местный, хотя договор в USD
    const foreign = await mk(await mkSup(`FOR-${tag} TRADING LTD`), 'EUR'); // иностранная валюта, местных признаков нет
    const uzs = await mk(await mkSup(`Ivanov ${tag}`), 'UZS');          // UZS → местный
    return { tag, local, foreign, uzs };
  }
  const list = async (q: string) => (await admin.agent.get(`/api/contracts?${q}&pageSize=500&status=ALL`)).body;

  it('предложение считается, но не записывается; фильтр идёт по действующему значению; подтверждение фиксирует', async () => {
    const { tag, local, foreign, uzs } = await pair();
    const rows = (await list(`q=${tag}`)).items;
    const by = (id: string) => rows.find((r: any) => r.id === id);
    expect(by(local)).toMatchObject({ origin: null, originSuggested: 'LOCAL', originEffective: 'LOCAL' });
    expect(by(foreign)).toMatchObject({ origin: null, originSuggested: 'FOREIGN', originEffective: 'FOREIGN' });
    expect(by(uzs)).toMatchObject({ originSuggested: 'LOCAL' });
    expect((await list(`q=${tag}&origin=LOCAL`)).items.map((r: any) => r.id).sort()).toEqual([local, uzs].sort());
    expect((await list(`q=${tag}&origin=FOREIGN`)).items.map((r: any) => r.id)).toEqual([foreign]);
    expect((await prisma.contract.findUniqueOrThrow({ where: { id: foreign } })).origin).toBeNull(); // ничего не записано без подтверждения

    // ручное решение сильнее предложения
    expect((await patch(admin, `/api/contracts/${foreign}`).send({ origin: 'LOCAL' })).status).toBe(200);
    expect((await list(`q=${tag}&origin=LOCAL`)).items.map((r: any) => r.id).sort()).toEqual([local, uzs, foreign].sort());
    expect(by(foreign)).toBeDefined();
    expect((await list(`q=${tag}`)).items.find((r: any) => r.id === foreign)).toMatchObject({ origin: 'LOCAL', originSuggested: 'FOREIGN', originEffective: 'LOCAL' });
  });

  it('массово: «принять предложения» только для неподтверждённых; явное значение; сброс; аудит; права', async () => {
    const { tag, local, foreign, uzs } = await pair();
    expect((await post(admin, '/api/contracts/bulk').send({ action: 'origin', ids: [uzs], origin: 'FOREIGN' })).body).toEqual({ updated: 1, skipped: 0 });
    const acc = await post(admin, '/api/contracts/bulk').send({ action: 'origin-accept', ids: [local, foreign, uzs] });
    expect(acc.body).toEqual({ updated: 2, skipped: 1 }); // uzs уже подтверждён вручную
    const rows = (await list(`q=${tag}`)).items;
    expect(rows.find((r: any) => r.id === local)).toMatchObject({ origin: 'LOCAL' });
    expect(rows.find((r: any) => r.id === foreign)).toMatchObject({ origin: 'FOREIGN' });
    expect(rows.find((r: any) => r.id === uzs)).toMatchObject({ origin: 'FOREIGN' }); // осталось выбранное вручную, не предложение
    expect((await post(admin, '/api/contracts/bulk').send({ action: 'origin', ids: [local], origin: null })).body).toEqual({ updated: 1, skipped: 0 });
    expect((await post(admin, '/api/contracts/bulk').send({ action: 'origin', ids: [local] })).status).toBe(400); // значение не указано
    const logs = await prisma.auditLog.findMany({ where: { entityId: foreign, entity: 'Contract' } });
    expect(logs.some((l) => (l.meta as any)?.acceptedSuggestion === true)).toBe(true);
    const viewer = await user(admin, `rl-ov-${uniq()}@example.test`, { role: 'VIEWER' });
    expect((await post(viewer, '/api/contracts/bulk').send({ action: 'origin-accept', ids: [local] })).status).toBe(403);
  });

  it('фильтр «местный / зарубежный» работает на Dashboard и в отчётах', async () => {
    const { tag } = await pair();
    const d = (await admin.agent.get(`/api/dashboard?origin=FOREIGN`)).body;
    const all = (await admin.agent.get(`/api/dashboard`)).body;
    expect(d.kpi.contracts).toBeLessThan(all.kpi.contracts);
    expect(d.kpi.contracts).toBeGreaterThanOrEqual(1);
    expect((await admin.agent.get('/api/dashboard?origin=XXX')).status).toBe(400);
    expect(tag).toBeTruthy();
  });
});
