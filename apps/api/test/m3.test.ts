import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaClient } from '@prisma/client';
import ExcelJS from 'exceljs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';

let app: NestExpressApplication;
let prisma: PrismaClient;
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

async function adminSession(): Promise<S> {
  // Файлы тестов делят БД: начальный админ мог быть уже подготовлен другим файлом.
  let r = await login('root@example.test', 'InitialPassw0rd!');
  if (r.status === 200) { await post(r, '/api/auth/change-password').send({ current: 'InitialPassw0rd!', next: PW }); }
  r = await login('root@example.test', PW);
  expect(r.status).toBe(200);
  return r;
}
async function user(admin: S, email: string, role: string) {
  await post(admin, '/api/users').send({ email, name: email, role, password: PW });
  const s = await login(email, PW);
  await post(s, '/api/auth/change-password').send({ current: PW, next: PW + '2' });
  return login(email, PW + '2');
}

let admin: S, mgr: S, fin: S, viewer: S;
const ids: Record<string, string> = {};

beforeAll(async () => {
  app = await createApp({ logger: false });
  await app.init();
  prisma = new PrismaClient();
  admin = await adminSession();
  mgr = await user(admin, 'm3mgr@example.test', 'MANAGER');
  fin = await user(admin, 'm3fin@example.test', 'FINANCE');
  viewer = await user(admin, 'm3view@example.test', 'VIEWER');
});
afterAll(async () => { await prisma.$disconnect(); await app.close(); });

const newContract = (s: S, o: object) => post(s, '/api/contracts').send({ number: 'Д-1 от 01.02.2026', amount: '1000', currency: 'USD', openingPaid: '400', ...o });

describe('M3: контрагенты', () => {
  it('создание, запрет дубля написания, права', async () => {
    const a = await post(mgr, '/api/suppliers').send({ name: '"ALPHA TRADE" MCHJ' });
    expect(a.status).toBe(201); ids.alpha = a.body.id;
    expect((await post(mgr, '/api/suppliers').send({ name: ' "alpha trade"  mchj ' })).status).toBe(409); // то же точное написание
    const b = await post(mgr, '/api/suppliers').send({ name: 'ООО Alpha Trade', taxId: '123456789' });
    expect(b.status).toBe(201); ids.alpha2 = b.body.id;
    const c = await post(mgr, '/api/suppliers').send({ name: 'GAMMA SUPPLY LLC' }); ids.beta = c.body.id;
    expect((await post(viewer, '/api/suppliers').send({ name: 'X Corp' })).status).toBe(403);
  });

  it('похожие названия предлагаются, но НЕ объединяются автоматически', async () => {
    const r = await mgr.agent.get('/api/suppliers/suggestions');
    expect(r.status).toBe(200);
    const g = r.body.find((x: any) => x.suppliers.some((s: any) => s.id === ids.alpha));
    expect(g.suppliers.map((s: any) => s.id).sort()).toEqual([ids.alpha, ids.alpha2].sort());
    expect(g.suppliers.some((s: any) => s.id === ids.beta)).toBe(false);
    expect((await prisma.supplier.findUniqueOrThrow({ where: { id: ids.alpha2 } })).status).toBe('ACTIVE');
  });

  it('алиасы: добавление, конфликт с другим поставщиком, нельзя удалить последний', async () => {
    expect((await post(mgr, `/api/suppliers/${ids.beta}/aliases`).send({ alias: 'Gamma Limited' })).status).toBe(201);
    const clash = await post(mgr, `/api/suppliers/${ids.beta}/aliases`).send({ alias: 'ООО ALPHA TRADE' });
    expect(clash.status).toBe(409); expect(clash.body.message).toMatch(/объедините/);
    const sup = (await mgr.agent.get(`/api/suppliers/${ids.beta}`)).body;
    expect(sup.aliases).toHaveLength(2);
    expect((await del(mgr, `/api/suppliers/${ids.beta}/aliases/${sup.aliases[0].id}`)).status).toBe(200);
    expect((await del(mgr, `/api/suppliers/${ids.beta}/aliases/${sup.aliases[1].id}`)).status).toBe(400);
  });

  it('список: агрегаты строго по валютам, фильтры и сортировка', async () => {
    await newContract(mgr, { supplierId: ids.alpha, amount: '1000', openingPaid: '400', currency: 'USD', executor: 'Исполнитель-1', number: 'A-1' });
    await newContract(mgr, { supplierId: ids.alpha, amount: '5000000', openingPaid: '1000000', currency: 'UZS', executor: 'Исполнитель-1', number: 'A-2' });
    await newContract(mgr, { supplierId: ids.beta, amount: '300', openingPaid: '300', currency: 'USD', number: 'B-1' });
    const r = await mgr.agent.get('/api/suppliers?q=alpha&pageSize=10');
    const row = r.body.items.find((i: any) => i.id === ids.alpha);
    expect(row.contracts).toBe(2);
    expect(row.byCurrency).toEqual([
      expect.objectContaining({ currency: 'USD', amount: '1000.00', paid: '400.00', debt: '600.00' }),
      expect.objectContaining({ currency: 'UZS', amount: '5000000.00', paid: '1000000.00', debt: '4000000.00' }),
    ]);
    expect(r.body.totals.map((t: any) => t.currency)).toEqual(['USD', 'UZS']);
    const onlyDebt = await mgr.agent.get('/api/suppliers?hasDebt=false');
    expect(onlyDebt.body.items.map((i: any) => i.id)).toContain(ids.beta);
    expect(onlyDebt.body.items.map((i: any) => i.id)).not.toContain(ids.alpha);
    const byExec = await mgr.agent.get('/api/suppliers?executor=исполнитель-1');
    expect(byExec.body.items.map((i: any) => i.id)).toEqual([ids.alpha]);
    const sorted = await mgr.agent.get('/api/suppliers?sort=debt&dir=desc&currency=USD&pageSize=500');
    const order = sorted.body.items.map((i: any) => i.id);
    expect(order.indexOf(ids.alpha)).toBeGreaterThanOrEqual(0);
    expect(order.indexOf(ids.alpha)).toBeLessThan(order.indexOf(ids.beta)); // долг USD: alpha 600 > beta 0
    const debts = sorted.body.items.map((i: any) => Number(i.byCurrency.find((c: any) => c.currency === 'USD')?.debt ?? 0));
    expect([...debts].sort((a, b) => b - a)).toEqual(debts);
  });

  it('объединение: договоры и написания переезжают, источник архивируется, всё в аудите; права', async () => {
    expect((await post(viewer, '/api/suppliers/merge').send({ targetId: ids.alpha, sourceIds: [ids.alpha2], confirm: true })).status).toBe(403); // нет suppliers.merge
    expect((await post(fin, '/api/suppliers/merge').send({ targetId: ids.alpha, sourceIds: [ids.alpha] , confirm: true })).status).toBe(403);
    expect((await post(admin, '/api/suppliers/merge').send({ targetId: ids.alpha, sourceIds: [ids.alpha], confirm: true })).status).toBe(400);
    expect((await post(admin, '/api/suppliers/merge').send({ targetId: ids.alpha, sourceIds: [ids.alpha2] })).status).toBe(400); // без confirm
    await newContract(mgr, { supplierId: ids.alpha2, number: 'A2-1', amount: '10', openingPaid: '0' });
    const r = await post(admin, '/api/suppliers/merge').send({ targetId: ids.alpha, sourceIds: [ids.alpha2], confirm: true });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ mergedSuppliers: 1, movedContracts: 1 });
    const src = await prisma.supplier.findUniqueOrThrow({ where: { id: ids.alpha2 } });
    expect(src).toMatchObject({ status: 'ARCHIVED', mergedIntoId: ids.alpha });
    const t = (await mgr.agent.get(`/api/suppliers/${ids.alpha}`)).body;
    expect(t.contracts).toHaveLength(3);
    expect(t.aliases.map((a: any) => a.alias)).toContain('ООО Alpha Trade'); // будущий импорт с этим написанием попадёт к целевому
    expect(t.taxId).toBe('123456789');
    expect((await post(admin, '/api/suppliers/merge').send({ targetId: ids.alpha, sourceIds: [ids.alpha2], confirm: true })).status).toBe(400); // источник уже архивный
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'supplier.merge' } });
    expect((audit.meta as any).movedContracts).toHaveLength(1);
  });

  it('экспорт в Excel: числовые форматы, фильтр, итоги по валютам', async () => {
    const r = await fin.agent.get('/api/suppliers/export').buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
    expect(r.status).toBe(200);
    expect(String(r.headers['content-disposition'])).toMatch(/attachment/);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(r.body);
    const ws = wb.worksheets[0];
    expect(ws.autoFilter).toBeTruthy();
    const row = ws.getRow(2);
    expect(typeof row.getCell(5).value).toBe('number');
    expect(row.getCell(5).numFmt).toBe('#,##0.00');
    const labels = ws.getColumn(1).values as string[];
    expect(labels.filter((v) => v === 'ИТОГО по валюте').length).toBeGreaterThanOrEqual(2);
  });
});

describe('M3: договоры', () => {
  it('создание: валидация и права', async () => {
    expect((await newContract(viewer, { supplierId: ids.alpha })).status).toBe(403);
    expect((await newContract(mgr, { supplierId: ids.alpha, amount: '10.123' })).status).toBe(400);
    expect((await newContract(mgr, { supplierId: ids.alpha, amount: '100', openingPaid: '150' })).status).toBe(400);
    expect((await newContract(mgr, { supplierId: ids.alpha2 })).status).toBe(400); // архивный поставщик
    const r = await newContract(mgr, { supplierId: ids.alpha, number: 'Д-77', amount: '2500.50', openingPaid: '500.25', currency: 'EUR', project: 'Navoi', goods: 'Кабель', contractDate: '2026-03-01' });
    expect(r.status).toBe(201); ids.c = r.body.id;
  });

  it('карточка: расчёт долга по формуле, пустые платежи, план отдельно', async () => {
    const c = (await viewer.agent.get(`/api/contracts/${ids.c}`)).body;
    expect(c).toMatchObject({ amount: '2500.50', openingPaid: '500.25', debt: '2000.25', overpaid: '0.00', state: 'PARTIAL', payments: [], contractDate: '2026-03-01' });
    expect(c.debtDetails).toMatchObject({ newApprovedPaid: '0.00', totalPaid: '500.25' });
  });

  it('список: поиск по поставщику/алиасу, фильтры, сортировка, итоги по валютам', async () => {
    const q = await viewer.agent.get('/api/contracts?q=%D0%9E%D0%9E%D0%9E%20alpha'); // «ООО alpha» — алиас объединённого поставщика
    expect(q.body.total).toBeGreaterThanOrEqual(4);
    const eur = await viewer.agent.get(`/api/contracts?currency=EUR&supplierId=${ids.alpha}`);
    expect(eur.body.items.map((i: any) => i.id)).toEqual([ids.c]);
    expect(eur.body.totals).toEqual([expect.objectContaining({ currency: 'EUR', amount: '2500.50', debt: '2000.25' })]);
    const paid = await viewer.agent.get('/api/contracts?state=PAID');
    expect(paid.body.items.every((i: any) => i.state === 'PAID')).toBe(true);
    const open = await viewer.agent.get(`/api/contracts?state=OPEN&sort=debt&dir=desc&currency=UZS&supplierId=${ids.alpha}`);
    expect(open.body.items[0].number).toBe('A-2');
    expect((await viewer.agent.get('/api/contracts?sort=hack')).status).toBe(400);
  });

  it('редактирование: «Оплачено» не меняется; сумма — только с причиной и в аудит', async () => {
    expect((await patch(mgr, `/api/contracts/${ids.c}`).send({ openingPaid: '0' })).status).toBe(400); // strict: поле запрещено
    expect((await patch(mgr, `/api/contracts/${ids.c}`).send({ amount: '3000' })).status).toBe(400); // без причины
    expect((await patch(mgr, `/api/contracts/${ids.c}`).send({ amount: '100', reason: 'ошибка ввода' })).status).toBe(400); // меньше оплаченного
    expect((await patch(mgr, `/api/contracts/${ids.c}`).send({ amount: '3000', reason: 'Доп. соглашение №2' })).status).toBe(200);
    expect((await patch(mgr, `/api/contracts/${ids.c}`).send({ goods: 'Кабель ВВГ', executor: 'Дилшод' })).status).toBe(200);
    const c = (await mgr.agent.get(`/api/contracts/${ids.c}`)).body;
    expect(c).toMatchObject({ amount: '3000.00', debt: '2499.75', goods: 'Кабель ВВГ' });
    const entry = c.history.find((h: any) => h.action === 'contract.update_financial');
    expect(entry.meta.reason).toBe('Доп. соглашение №2');
    expect(entry.before.amount).toBe('2500.5');
    expect((await patch(viewer, `/api/contracts/${ids.c}`).send({ goods: 'x' })).status).toBe(403);
  });

  it('архивирование скрывает договор из списка, но не удаляет; редактирование архивного запрещено', async () => {
    expect((await post(viewer, `/api/contracts/${ids.c}/archive`)).status).toBe(403);
    expect((await post(mgr, `/api/contracts/${ids.c}/archive`)).status).toBe(201);
    expect((await mgr.agent.get(`/api/contracts?currency=EUR&supplierId=${ids.alpha}`)).body.total).toBe(0);
    expect((await mgr.agent.get(`/api/contracts?currency=EUR&status=ARCHIVED&supplierId=${ids.alpha}`)).body.total).toBe(1);
    expect((await patch(mgr, `/api/contracts/${ids.c}`).send({ goods: 'z' })).status).toBe(400);
    expect((await post(mgr, `/api/contracts/${ids.c}/restore`)).status).toBe(201);
    expect((await mgr.agent.get(`/api/contracts?currency=EUR&supplierId=${ids.alpha}`)).body.total).toBe(1);
  });

  it('архивные договоры не входят в итоги поставщика', async () => {
    await post(mgr, `/api/contracts/${ids.c}/archive`);
    const t = (await mgr.agent.get(`/api/suppliers/${ids.alpha}`)).body;
    expect(t.totals.find((x: any) => x.currency === 'EUR')).toBeUndefined();
    await post(mgr, `/api/contracts/${ids.c}/restore`);
  });

  it('документы: загрузка, проверка содержимого, скачивание вложением, мягкое удаление', async () => {
    const pdf = Buffer.from('%PDF-1.4\n%test');
    expect((await post(mgr, `/api/contracts/${ids.c}/documents`).attach('file', Buffer.from('MZ-exe'), 'a.exe')).status).toBe(400);
    expect((await post(mgr, `/api/contracts/${ids.c}/documents`).attach('file', Buffer.from('not a pdf'), 'fake.pdf')).status).toBe(400);
    expect((await post(viewer, `/api/contracts/${ids.c}/documents`).attach('file', pdf, 'a.pdf')).status).toBe(403);
    const up = await post(mgr, `/api/contracts/${ids.c}/documents`).attach('file', pdf, 'Договор.pdf');
    expect(up.status).toBe(201); expect(up.body.filename).toBe('Договор.pdf');
    const dl = await viewer.agent.get(`/api/contracts/${ids.c}/documents/${up.body.id}`);
    expect(dl.status).toBe(200);
    expect(String(dl.headers['content-disposition'])).toMatch(/^attachment/);
    expect(dl.headers['content-type']).toMatch(/application\/pdf/);
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
    expect((await mgr.agent.get(`/api/contracts/${ids.c}`)).body.documents).toHaveLength(1);
    expect((await del(mgr, `/api/contracts/${ids.c}/documents/${up.body.id}`)).status).toBe(200);
    expect((await mgr.agent.get(`/api/contracts/${ids.c}`)).body.documents).toHaveLength(0);
    expect((await viewer.agent.get(`/api/contracts/${ids.c}/documents/${up.body.id}`)).status).toBe(404);
    expect(await prisma.contractDocument.count({ where: { id: up.body.id } })).toBe(1); // запись и файл сохранены
  });

  it('экспорт договоров доступен ролям с reports.export и пишется в аудит', async () => {
    const r = await viewer.agent.get('/api/contracts/export?currency=USD').buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
    expect(r.status).toBe(200);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(r.body);
    expect(wb.worksheets[0].getRow(1).getCell(1).value).toBe('Договор');
    expect(await prisma.auditLog.count({ where: { action: 'export.contracts' } })).toBeGreaterThan(0);
  });
});
