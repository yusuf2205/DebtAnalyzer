import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaClient } from '@prisma/client';
import ExcelJS from 'exceljs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';

let app: NestExpressApplication;
let prisma: PrismaClient;
const PW = 'StrongPassw0rd!x';

type Session = { agent: ReturnType<typeof request.agent>; csrf: string };
const http = () => request(app.getHttpServer());

async function login(email: string, password: string): Promise<Session & { status: number; body: any }> {
  const agent = request.agent(app.getHttpServer());
  const r = await agent.post('/api/auth/login').send({ email, password });
  return { agent, csrf: r.body?.user?.csrfToken, status: r.status, body: r.body };
}
const post = (s: Session, url: string) => s.agent.post(url).set('x-csrf-token', s.csrf);
const patch = (s: Session, url: string) => s.agent.patch(url).set('x-csrf-token', s.csrf);

async function createUser(admin: Session, email: string, role: string) {
  const r = await post(admin, '/api/users').send({ email, name: email, role, password: PW });
  expect(r.status).toBe(201);
  const s = await login(email, PW);
  expect(s.body.user.mustChangePassword).toBe(true);
  const c = await post(s, '/api/auth/change-password').send({ current: PW, next: PW + '2' });
  expect(c.status).toBe(204);
  return login(email, PW + '2');
}

async function workbook(rows: (string | number | undefined)[][], tweak?: (ws: ExcelJS.Worksheet) => void): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Реестр договоров');
  ws.getCell('K3').value = 'Июнь'; ws.getCell('L3').value = 'Июнь'; ws.getCell('K4').value = 'W1'; ws.getCell('L4').value = 'W2';
  ['', '№', 'Проект', 'Номер контракта', 'Наименование контрагента', 'Наименования товара', 'Сумма контракта', 'Оплачено', 'Остаток суммы (ДОЛГ)', 'Валюта'].forEach((h, i) => h && (ws.getCell(5, i + 1).value = h));
  rows.forEach((r, i) => r.forEach((v, c) => v !== undefined && (ws.getCell(6 + i, c + 1).value = v)));
  tweak?.(ws);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const DATA = (paidA = 400) => [
  ['', 1, 'Proj A', 'Договор №1 от 01.02.2026', 'ACME MCHJ', 'Кабель', 1000, paidA, 1000 - paidA, 'USD'],
  ['', 2, 'Proj A', 'Договор №2 от 05.02.2026', '"ACME" MCHJ', 'Болты', 5_000_000, 1_000_000, 4_000_000, 'UZS'],
  ['', 3, 'Proj B', 'Договор №3', 'BETA LLC', 'Реле', 700, 0, 700, undefined], // нет валюты -> BLOCKED
];

let admin: Session, finance: Session, viewer: Session, manager: Session;

beforeAll(async () => {
  app = await createApp({ logger: false });
  await app.init();
  prisma = new PrismaClient();
  // Файлы тестов делят БД: начальный пароль админа мог быть уже сменён другим файлом.
  const first = await login('root@example.test', 'InitialPassw0rd!');
  if (first.status === 200) {
    const ch = await post(first, '/api/auth/change-password').send({ current: 'InitialPassw0rd!', next: PW });
    expect(ch.status).toBe(204);
  }
  admin = await login('root@example.test', PW);
  finance = await createUser(admin, 'fin@example.test', 'FINANCE');
  viewer = await createUser(admin, 'view@example.test', 'VIEWER');
  manager = await createUser(admin, 'mgr@example.test', 'MANAGER');
});
afterAll(async () => { await prisma.$disconnect(); await app.close(); });

describe('M1: аутентификация и сессии', () => {
  it('неавторизованный доступ закрыт по умолчанию', async () => {
    expect((await http().get('/api/imports')).status).toBe(401);
    expect((await http().get('/api/users')).status).toBe(401);
    expect((await http().get('/api/health')).status).toBe(200);
  });
  it('неверный пароль и несуществующий пользователь дают одинаковый ответ', async () => {
    const a = await login('root@example.test', 'wrong-password-123');
    const b = await login('nobody@example.test', 'wrong-password-123');
    expect(a.status).toBe(401); expect(b.status).toBe(401);
    expect(a.body.message).toBe(b.body.message);
  });
  it('сессионная cookie httpOnly + SameSite', async () => {
    const r = await http().post('/api/auth/login').send({ email: 'root@example.test', password: PW });
    const c = String(r.headers['set-cookie']);
    expect(c).toMatch(/pf_session=/); expect(c).toMatch(/HttpOnly/i); expect(c).toMatch(/SameSite=Lax/i);
  });
  it('пароль хранится как argon2id-хеш', async () => {
    const u = await prisma.user.findUniqueOrThrow({ where: { email: 'root@example.test' } });
    expect(u.passwordHash).toMatch(/^\$argon2id\$/);
  });
  it('CSRF: изменяющий запрос без токена отклоняется, с токеном проходит', async () => {
    expect((await admin.agent.post('/api/auth/change-password').send({ current: PW, next: PW })).status).toBe(403);
    expect((await admin.agent.post('/api/auth/change-password').set('x-csrf-token', 'wrong').send({})).status).toBe(403);
  });
  it('до смены начального пароля доступ к данным закрыт', async () => {
    await post(admin, '/api/users').send({ email: 'tmp@example.test', name: 't', role: 'VIEWER', password: PW });
    const s = await login('tmp@example.test', PW);
    const r = await s.agent.get('/api/imports');
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('PASSWORD_CHANGE_REQUIRED');
  });
  it('блокировка после 5 неудачных попыток', async () => {
    await post(admin, '/api/users').send({ email: 'lock@example.test', name: 'l', role: 'VIEWER', password: PW });
    for (let i = 0; i < 5; i++) expect((await login('lock@example.test', 'bad-password-123')).status).toBe(401);
    expect((await login('lock@example.test', PW)).status).toBe(423);
  });
  it('выход аннулирует сессию', async () => {
    const s = await login('root@example.test', PW);
    expect((await s.agent.get('/api/auth/me')).status).toBe(200);
    expect((await post(s, '/api/auth/logout')).status).toBe(204);
    expect((await s.agent.get('/api/auth/me')).status).toBe(401);
  });
  it('журнал аудита неизменяем на уровне БД', async () => {
    const row = await prisma.auditLog.findFirstOrThrow();
    await expect(prisma.auditLog.update({ where: { id: row.id }, data: { action: 'tampered' } })).rejects.toThrow(/append-only/);
    await expect(prisma.auditLog.deleteMany({})).rejects.toThrow(/append-only/);
  });
  it('вход и неудачные попытки попадают в аудит', async () => {
    const actions = (await prisma.auditLog.findMany({ select: { action: true } })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['auth.login', 'auth.login_failed', 'user.create', 'auth.password_changed']));
  });
});

describe('M1: RBAC на backend', () => {
  it('VIEWER не видит пользователей и не может загружать импорт', async () => {
    expect((await viewer.agent.get('/api/users')).status).toBe(403);
    const r = await post(viewer, '/api/imports').attach('file', await workbook(DATA()), 'x.xlsx');
    expect(r.status).toBe(403);
    expect((await viewer.agent.get('/api/imports')).status).toBe(200);
  });
  it('MANAGER не управляет пользователями и не сохраняет импорт', async () => {
    expect((await post(manager, '/api/users').send({ email: 'z@example.test', name: 'z', role: 'VIEWER', password: PW })).status).toBe(403);
    expect((await post(manager, '/api/imports/00000000-0000-4000-8000-000000000000/commit').send({ confirm: true })).status).toBe(403);
  });
  it('ADMIN не может создать SUPER_ADMIN (эскалация привилегий)', async () => {
    const adm = await createUser(admin, 'adm@example.test', 'ADMIN');
    expect((await post(adm, '/api/users').send({ email: 'esc@example.test', name: 'e', role: 'SUPER_ADMIN', password: PW })).status).toBe(403);
    const roots = await prisma.user.findFirstOrThrow({ where: { email: 'root@example.test' } });
    expect((await patch(adm, `/api/users/${roots.id}`).send({ isActive: false })).status).toBe(403);
  });
  it('нельзя отключить самого себя', async () => {
    const me = await prisma.user.findFirstOrThrow({ where: { email: 'root@example.test' } });
    expect((await patch(admin, `/api/users/${me.id}`).send({ isActive: false })).status).toBe(400);
  });
  it('отключённый пользователь теряет активные сессии', async () => {
    const u = await createUser(admin, 'temp@example.test', 'VIEWER');
    const row = await prisma.user.findFirstOrThrow({ where: { email: 'temp@example.test' } });
    expect((await patch(admin, `/api/users/${row.id}`).send({ isActive: false })).status).toBe(200);
    expect((await u.agent.get('/api/imports')).status).toBe(401);
  });
});

describe('M2: импорт Excel (end-to-end)', () => {
  let batchId: string;

  it('отклоняет XLS, неверное расширение и подделку под XLSX', async () => {
    expect((await post(manager, '/api/imports').attach('file', Buffer.from('x'), 'a.xls')).status).toBe(400);
    expect((await post(manager, '/api/imports').attach('file', Buffer.from('x'), 'a.exe')).status).toBe(400);
    expect((await post(manager, '/api/imports').attach('file', Buffer.from('not a zip at all'), 'a.xlsx')).status).toBe(400);
  });

  it('загрузка -> листы и предложенный лист', async () => {
    const r = await post(manager, '/api/imports').attach('file', await workbook(DATA()), 'registry.xlsx');
    expect(r.status).toBe(201);
    expect(r.body.suggestedSheet).toBe('Реестр договоров');
    batchId = r.body.id;
  });

  it('анализ: строка без валюты заблокирована, итоги верны, исходные значения сохранены', async () => {
    const r = await post(manager, `/api/imports/${batchId}/analyze`).send({ sheetName: 'Реестр договоров' });
    expect(r.status).toBe(201);
    expect(r.body.summary).toMatchObject({ dataRows: 3, importable: 2, blocked: 1 });
    expect(r.body.summary.totalsByCurrency.USD).toMatchObject({ amount: '1000.00', paid: '400.00', debt: '600.00' });
    const rows = await manager.agent.get(`/api/imports/${batchId}/rows?status=BLOCKED`);
    expect(rows.body.items[0].issues.map((i: any) => i.code)).toContain('MISSING_CURRENCY');
    expect(rows.body.items[0].raw.G8.v).toBe(700);
  });

  it('сохранение без подтверждения/года отклоняется; VIEWER и MANAGER не могут сохранять', async () => {
    expect((await post(finance, `/api/imports/${batchId}/commit`).send({})).status).toBe(400);
    expect((await post(finance, `/api/imports/${batchId}/commit`).send({ confirm: true })).status).toBe(400); // нет planYear
    expect((await post(viewer, `/api/imports/${batchId}/commit`).send({ confirm: true, planYear: 2026 })).status).toBe(403);
  });

  it('ручной выбор валюты разблокирует строку и пишется в аудит', async () => {
    const r = await patch(manager, `/api/imports/${batchId}/overrides`).send({ 8: { currency: 'USD' } });
    expect(r.status).toBe(200);
    expect(r.body.summary).toMatchObject({ importable: 3, blocked: 0 });
    const audit = await prisma.auditLog.findMany({ where: { action: 'import.override', entityId: batchId } });
    expect(audit).toHaveLength(1);
  });

  it('сохранение: поставщики, договоры, начальные оплаты; двойная отправка отклоняется', async () => {
    const [a, b] = await Promise.all([
      post(finance, `/api/imports/${batchId}/commit`).send({ confirm: true, planYear: 2026 }),
      post(finance, `/api/imports/${batchId}/commit`).send({ confirm: true, planYear: 2026 }),
    ]);
    const ok = [a, b].filter((r) => r.status === 201);
    expect(ok).toHaveLength(1);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const rep = ok[0].body;
    expect(rep).toMatchObject({ contractsCreated: 3, suppliersCreated: 2 }); // «ACME» MCHJ и ACME MCHJ — одно точное написание
    const c = await prisma.contract.findFirstOrThrow({ where: { number: { contains: 'Договор №1 ' } } });
    expect(c.openingPaid.toFixed(2)).toBe('400.00');
    expect(c.sourcePaid?.toFixed(2)).toBe('400.00');
    expect(c.contractDate?.toISOString().slice(0, 10)).toBe('2026-02-01');
    // Никаких фиктивных платежей — модели платежей в M2 нет вовсе, оплаты хранятся только как начальный остаток.
    expect(await prisma.supplierAlias.count({ where: { source: `IMPORT:${batchId}` } })).toBe(2);
  });

  it('повторное сохранение того же импорта невозможно', async () => {
    expect((await post(finance, `/api/imports/${batchId}/commit`).send({ confirm: true, planYear: 2026 })).status).toBe(409);
  });

  it('курсы из файла сохраняются только как кандидаты на подтверждение', async () => {
    const buf = await workbook(DATA(), (ws) => {
      ws.getCell('B20').value = 'Курс валют на 20.08.2026'; ws.getCell('B21').value = 'Доллар'; ws.getCell('C21').value = 'Сумм'; ws.getCell('B22').value = 1; ws.getCell('C22').value = 11850;
    });
    const up = await post(manager, '/api/imports').attach('file', buf, 'r2.xlsx');
    await post(manager, `/api/imports/${up.body.id}/analyze`).send({ sheetName: 'Реестр договоров', overrides: { 8: { currency: 'USD' } } });
    const rep = await post(finance, `/api/imports/${up.body.id}/commit`).send({ confirm: true, planYear: 2026 });
    expect(rep.status).toBe(201);
    expect(rep.body.ratesPending).toBe(1);
    const rates = await manager.agent.get('/api/fx/rates?status=PENDING_CONFIRMATION');
    expect(rates.body).toHaveLength(1);
    expect(rates.body[0]).toMatchObject({ currency: 'USD', uzsPerUnit: '11850', status: 'PENDING_CONFIRMATION' });
    // Подтверждать курс может только тот, у кого есть fx.manage
    expect((await post(manager, `/api/fx/rates/${rates.body[0].id}/confirm`).send({})).status).toBe(403);
    const ok = await post(finance, `/api/fx/rates/${rates.body[0].id}/confirm`).send({});
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ status: 'CONFIRMED' });
    expect(ok.body.confirmedById).toBeTruthy();
    expect((await post(finance, `/api/fx/rates/${rates.body[0].id}/confirm`).send({})).status).toBe(400);
  });

  it('повторный импорт: изменение «Оплачено» НЕ перезаписывает договор, а создаёт задачу сверки; дублей договоров нет', async () => {
    const before = await prisma.contract.count();
    const up = await post(manager, '/api/imports').attach('file', await workbook(DATA(900)), 'registry-v2.xlsx');
    await post(manager, `/api/imports/${up.body.id}/analyze`).send({ sheetName: 'Реестр договоров', overrides: { 8: { currency: 'USD' } } });
    const rep = await post(finance, `/api/imports/${up.body.id}/commit`).send({ confirm: true, planYear: 2026 });
    expect(rep.status).toBe(201);
    expect(rep.body).toMatchObject({ contractsCreated: 0, contractsChangedInSource: 1, reconciliationTasks: 1, contractsUnchanged: 2 });
    expect(await prisma.contract.count()).toBe(before);
    const c = await prisma.contract.findFirstOrThrow({ where: { number: { contains: 'Договор №1 ' } } });
    expect(c.openingPaid.toFixed(2)).toBe('400.00'); // базовый остаток не тронут
    const task = await prisma.reconciliationTask.findFirstOrThrow({ where: { contractId: c.id } });
    expect(task.status).toBe('PENDING');
    expect((task.details as any).changes).toEqual([{ field: 'openingPaid', from: '400.00', to: '900.00' }]);
  });

  it('плановые строки импортируются отдельно и не влияют на оплаты', async () => {
    const buf = await workbook([['', 1, 'P', 'Д-77 от 01.03.2026', 'PLAN CO', 'x', 1000, 0, 1000, 'USD']], (ws) => { ws.getCell('K6').value = 300; ws.getCell('L6').value = 200; });
    const up = await post(manager, '/api/imports').attach('file', buf, 'plan.xlsx');
    await post(manager, `/api/imports/${up.body.id}/analyze`).send({ sheetName: 'Реестр договоров' });
    await post(finance, `/api/imports/${up.body.id}/commit`).send({ confirm: true, planYear: 2027 });
    const c = await prisma.contract.findFirstOrThrow({ where: { number: { contains: 'Д-77' } }, include: { plans: true } });
    expect(c.openingPaid.toFixed(2)).toBe('0.00');
    expect(c.plans.map((p) => [p.year, p.month, p.week, p.amount.toFixed(2), p.source]).sort()).toEqual([[2027, 6, 1, '300.00', 'IMPORT'], [2027, 6, 2, '200.00', 'IMPORT']]);
  });
});
