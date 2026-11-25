import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaClient } from '@prisma/client';
import ExcelJS from 'exceljs';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';

let app: NestExpressApplication, prisma: PrismaClient;
const PW = 'StrongPassw0rd!x';
type S = { agent: ReturnType<typeof request.agent>; csrf: string };

async function login(email: string, password: string): Promise<S & { status: number }> {
  const agent = request.agent(app.getHttpServer());
  const r = await agent.post('/api/auth/login').send({ email, password });
  return { agent, csrf: r.body?.user?.csrfToken, status: r.status };
}
const post = (s: S, u: string) => s.agent.post(u).set('x-csrf-token', s.csrf);
const patch = (s: S, u: string) => s.agent.patch(u).set('x-csrf-token', s.csrf);
async function user(admin: S, email: string, role: string) {
  await post(admin, '/api/users').send({ email, name: email.split('@')[0], role, password: PW });
  const a = await login(email, PW); await post(a, '/api/auth/change-password').send({ current: PW, next: PW + '2' });
  return login(email, PW + '2');
}
let admin: S, mgr: S, fin: S, fin2: S, viewer: S;

beforeAll(async () => {
  app = await createApp({ logger: false }); await app.init(); prisma = new PrismaClient();
  let r = await login('root@example.test', 'InitialPassw0rd!');
  if (r.status === 200) await post(r, '/api/auth/change-password').send({ current: 'InitialPassw0rd!', next: PW });
  admin = await login('root@example.test', PW);
  mgr = await user(admin, 'pmgr@example.test', 'MANAGER'); fin = await user(admin, 'pfin@example.test', 'FINANCE');
  fin2 = await user(admin, 'pfin2@example.test', 'FINANCE'); viewer = await user(admin, 'pview@example.test', 'VIEWER');
});
afterAll(async () => { await prisma.$disconnect(); await app.close(); });

const today = new Date().toISOString().slice(0, 10);
async function newContract(o: { supplier?: string; number?: string; amount?: string; paid?: string; currency?: string } = {}) {
  const sup = await post(mgr, '/api/suppliers').send({ name: o.supplier ?? `PAY-SUP-${randomUUID().slice(0, 8)}` });
  const c = await post(mgr, '/api/contracts').send({ supplierId: sup.body.id, number: o.number ?? `PC-${randomUUID().slice(0, 6)}`, amount: o.amount ?? '1000', currency: o.currency ?? 'USD', openingPaid: o.paid ?? '0' });
  expect(c.status).toBe(201);
  return { id: c.body.id as string, supplierId: sup.body.id as string };
}
const pay = (s: S, contractId: string, o: object = {}) => post(s, '/api/payments').send({ contractId, paymentDate: today, amount: '100', idempotencyKey: randomUUID(), ...o });
const card = async (id: string) => (await viewer.agent.get(`/api/contracts/${id}`)).body;
async function approved(contractId: string, amount: string, extra: object = {}) {
  const p = await pay(mgr, contractId, { amount, submit: true, confirmDuplicate: true, ...extra });
  expect(p.status).toBe(201);
  const a = await post(fin, `/api/payments/${p.body.id}/approve`).send({ confirmOverpayment: true });
  expect(a.status).toBe(201);
  return p.body.id as string;
}

describe('M4: платежи — создание и валидация', () => {
  it('черновик не влияет на долг; валюта берётся из договора; права на создание', async () => {
    const c = await newContract({ amount: '1000', paid: '200', currency: 'EUR' });
    expect((await pay(viewer, c.id)).status).toBe(403);
    const r = await pay(mgr, c.id, { currency: 'USD' }); // чужая валюта из тела игнорируется
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'DRAFT', currency: 'EUR', amount: '100.00', kind: 'PAYMENT' });
    expect((await card(c.id))).toMatchObject({ debt: '800.00', openingPaid: '200.00', newPaid: '0.00' });
  });

  it('валидация: сумма > 0, дата не в будущем, архивный договор, формат', async () => {
    const c = await newContract();
    expect((await pay(mgr, c.id, { amount: '0' })).status).toBe(400);
    expect((await pay(mgr, c.id, { amount: '10.123' })).status).toBe(400);
    expect((await pay(mgr, c.id, { amount: '-5' })).status).toBe(400);
    expect((await pay(mgr, c.id, { paymentDate: '2999-01-01' })).status).toBe(400);
    expect((await pay(mgr, randomUUID())).status).toBe(400);
    await post(mgr, `/api/contracts/${c.id}/archive`);
    expect((await pay(mgr, c.id)).status).toBe(400);
  });

  it('идемпотентность: повторная отправка той же формы не создаёт второй платёж', async () => {
    const c = await newContract();
    const key = randomUUID();
    const [a, b] = await Promise.all([pay(mgr, c.id, { idempotencyKey: key, submit: true }), pay(mgr, c.id, { idempotencyKey: key, submit: true })]);
    expect([a.status, b.status].every((s) => s === 201)).toBe(true);
    expect(a.body.id).toBe(b.body.id);
    expect(await prisma.payment.count({ where: { contractId: c.id } })).toBe(1);
    expect((await pay(fin, c.id, { idempotencyKey: key })).status).toBe(409); // чужой ключ
  });

  it('дубликаты: один номер транзакции у поставщика и «тот же договор/дата/сумма»', async () => {
    const c = await newContract();
    expect((await pay(mgr, c.id, { transactionNo: 'TX-1', amount: '50', submit: true })).status).toBe(201);
    const same = await pay(mgr, c.id, { transactionNo: 'TX-1', amount: '75' });
    expect(same.status).toBe(409); expect(same.body.code).toBe('DUPLICATE_TRANSACTION');
    const c2 = await post(mgr, '/api/contracts').send({ supplierId: c.supplierId, number: 'OTHER', amount: '10', currency: 'USD' });
    expect((await pay(mgr, c2.body.id, { transactionNo: 'TX-1' })).body.code).toBe('DUPLICATE_TRANSACTION'); // другой договор того же поставщика
    const suspect = await pay(mgr, c.id, { amount: '50' });
    expect(suspect.body.code).toBe('DUPLICATE_SUSPECT');
    expect((await pay(mgr, c.id, { amount: '50', confirmDuplicate: true, submit: true })).status).toBe(201);
    const dups = await fin.agent.get('/api/reconciliation/duplicates');
    expect(dups.body.some((g: any) => g.payments.some((p: any) => p.contract.id === c.id))).toBe(true);
  });
});

describe('M4: платежи — подтверждение и расчёт долга', () => {
  it('только подтверждённые платежи уменьшают долг; ожидающие — нет', async () => {
    const c = await newContract({ amount: '1000', paid: '200' });
    const p = await pay(mgr, c.id, { amount: '300', submit: true });
    expect(p.body.status).toBe('PENDING');
    expect(await card(c.id)).toMatchObject({ debt: '800.00' });
    expect((await post(viewer, `/api/payments/${p.body.id}/approve`).send({})).status).toBe(403);
    expect((await post(mgr, `/api/payments/${p.body.id}/approve`).send({})).status).toBe(403);
    const a = await post(fin, `/api/payments/${p.body.id}/approve`).send({});
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({ status: 'APPROVED', signedAmount: '300.00' });
    expect(a.body.approvedBy.name).toBe('pfin');
    expect(await card(c.id)).toMatchObject({ debt: '500.00', newPaid: '300.00', paid: '500.00', state: 'PARTIAL' });
    const list = (await viewer.agent.get(`/api/contracts?supplierId=${c.supplierId}`)).body;
    expect(list.items[0]).toMatchObject({ debt: '500.00' });
    expect(list.totals[0]).toMatchObject({ currency: 'USD', paid: '500.00', debt: '500.00' });
    const sup = (await viewer.agent.get(`/api/suppliers/${c.supplierId}`)).body;
    expect(sup.totals[0]).toMatchObject({ paid: '500.00', debt: '500.00' });
  });

  it('разделение обязанностей: создавший не подтверждает свой платёж; повторное подтверждение невозможно', async () => {
    const c = await newContract();
    const p = await pay(fin, c.id, { submit: true });
    const self = await post(fin, `/api/payments/${p.body.id}/approve`).send({});
    expect(self.status).toBe(403);
    expect((await post(fin2, `/api/payments/${p.body.id}/approve`).send({})).status).toBe(201);
    expect((await post(fin2, `/api/payments/${p.body.id}/approve`).send({})).status).toBe(409);
  });

  it('частичная → полная оплата; переплата только с явным подтверждением', async () => {
    const c = await newContract({ amount: '1000' });
    await approved(c.id, '400');
    await approved(c.id, '600');
    expect(await card(c.id)).toMatchObject({ debt: '0.00', state: 'PAID' });
    const extra = await pay(mgr, c.id, { amount: '50', submit: true, confirmDuplicate: true });
    const denied = await post(fin, `/api/payments/${extra.body.id}/approve`).send({});
    expect(denied.status).toBe(409); expect(denied.body).toMatchObject({ code: 'OVERPAYMENT', overpaid: '50.00' });
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: extra.body.id } })).status).toBe('PENDING');
    expect((await post(fin, `/api/payments/${extra.body.id}/approve`).send({ confirmOverpayment: true })).status).toBe(201);
    expect(await card(c.id)).toMatchObject({ debt: '0.00', overpaid: '50.00', state: 'OVERPAID' });
  });

  it('возврат увеличивает долг; возврат больше оплаченного запрещён', async () => {
    const c = await newContract({ amount: '1000' });
    await approved(c.id, '500');
    const big = await pay(mgr, c.id, { amount: '600', kind: 'REFUND', submit: true });
    expect((await post(fin, `/api/payments/${big.body.id}/approve`).send({})).status).toBe(400);
    const ok = await approved(c.id, '200', { kind: 'REFUND' });
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: ok } })).signedAmount?.toFixed(2)).toBe('-200.00');
    expect(await card(c.id)).toMatchObject({ debt: '700.00', paid: '300.00' });
  });

  it('гонка: два одновременных подтверждения не «пробивают» лимит переплаты', async () => {
    const c = await newContract({ amount: '1000' });
    const a = await pay(mgr, c.id, { amount: '600', submit: true }), b = await pay(mgr, c.id, { amount: '700', submit: true });
    const [r1, r2] = await Promise.all([post(fin, `/api/payments/${a.body.id}/approve`).send({}), post(fin2, `/api/payments/${b.body.id}/approve`).send({})]);
    expect([r1.status, r2.status].sort()).toEqual([201, 409]);
    expect([r1, r2].find((r) => r.status === 409)!.body.code).toBe('OVERPAYMENT');
    expect((await card(c.id)).overpaid).toBe('0.00');
  });

  it('двойное нажатие «подтвердить» — одно подтверждение', async () => {
    const c = await newContract();
    const p = await pay(mgr, c.id, { submit: true });
    const [x, y] = await Promise.all([post(fin, `/api/payments/${p.body.id}/approve`).send({}), post(fin2, `/api/payments/${p.body.id}/approve`).send({})]);
    expect([x.status, y.status].sort()).toEqual([201, 409]);
    expect((await card(c.id)).newPaid).toBe('100.00');
  });
});

describe('M4: отклонение, отмена, редактирование', () => {
  it('отклонение требует причину; отклонённый платёж можно исправить и снова отправить', async () => {
    const c = await newContract();
    const p = await pay(mgr, c.id, { submit: true });
    expect((await post(fin, `/api/payments/${p.body.id}/reject`).send({})).status).toBe(400);
    const r = await post(fin, `/api/payments/${p.body.id}/reject`).send({ reason: 'Нет платёжного поручения' });
    expect(r.body).toMatchObject({ status: 'REJECTED', rejectReason: 'Нет платёжного поручения' });
    expect((await card(c.id)).newPaid).toBe('0.00');
    expect((await patch(fin, `/api/payments/${p.body.id}`).send({ amount: '90' })).status).toBe(403); // чужой платёж
    const fixed = await patch(mgr, `/api/payments/${p.body.id}`).send({ amount: '90', bankDocument: 'ПП-17' });
    expect(fixed.body).toMatchObject({ status: 'DRAFT', amount: '90.00', bankDocument: 'ПП-17', rejectReason: null });
    expect((await post(mgr, `/api/payments/${p.body.id}/submit`)).body.status).toBe('PENDING');
  });

  it('отмена: черновик/ожидающий можно, подтверждённый — нельзя (только сторно)', async () => {
    const c = await newContract();
    const d = await pay(mgr, c.id);
    expect((await post(viewer, `/api/payments/${d.body.id}/cancel`).send({})).status).toBe(403);
    expect((await post(mgr, `/api/payments/${d.body.id}/cancel`).send({ reason: 'ошибка' })).body.status).toBe('CANCELLED');
    expect((await post(mgr, `/api/payments/${d.body.id}/submit`)).status).toBe(409);
    const id = await approved(c.id, '10');
    expect((await post(fin, `/api/payments/${id}/cancel`).send({})).status).toBe(400);
    expect((await patch(mgr, `/api/payments/${id}`).send({ amount: '1' })).status).toBe(400);
  });
});

describe('M4: неизменяемость, сторно, исправление', () => {
  it('подтверждённый платёж нельзя изменить или удалить даже напрямую в БД', async () => {
    const c = await newContract();
    const id = await approved(c.id, '120', { transactionNo: 'IMM-1' });
    await expect(prisma.payment.update({ where: { id }, data: { amount: '1' } })).rejects.toThrow(/immutable/);
    await expect(prisma.payment.update({ where: { id }, data: { status: 'CANCELLED' } })).rejects.toThrow(/immutable/);
    await expect(prisma.payment.delete({ where: { id } })).rejects.toThrow(/cannot be deleted/);
    await expect(prisma.payment.update({ where: { id }, data: { signedAmount: '999' } })).rejects.toThrow(/immutable/);
    await prisma.payment.update({ where: { id }, data: { comment: 'допустимая правка комментария' } }); // не финансовое поле
    const draft = await pay(mgr, c.id, { amount: '5', confirmDuplicate: true });
    await prisma.payment.delete({ where: { id: draft.body.id } }); // черновик удалять можно
  });

  it('сторно: отдельная запись, оригинал сохраняется, долг возвращается; повторное сторно и права', async () => {
    const c = await newContract({ amount: '1000' });
    const id = await approved(c.id, '400');
    expect((await post(mgr, `/api/payments/${id}/reverse`).send({ reason: 'ошибочный платёж' })).status).toBe(403);
    expect((await post(fin, `/api/payments/${id}/reverse`).send({})).status).toBe(400);
    const rev = await post(fin2, `/api/payments/${id}/reverse`).send({ reason: 'ошибочный платёж' });
    expect(rev.status).toBe(201);
    expect(rev.body).toMatchObject({ kind: 'REVERSAL', status: 'APPROVED', signedAmount: '-400.00', reversesPaymentId: id });
    expect(await card(c.id)).toMatchObject({ debt: '1000.00', newPaid: '0.00' });
    const orig = (await viewer.agent.get(`/api/payments/${id}`)).body;
    expect(orig).toMatchObject({ status: 'APPROVED', reversedByPaymentId: rev.body.id });
    expect((await post(fin, `/api/payments/${id}/reverse`).send({ reason: 'ещё раз' })).status).toBe(409);
    expect((await post(fin, `/api/payments/${rev.body.id}/reverse`).send({ reason: 'сторно сторно' })).status).toBe(400);
    expect((await post(fin, `/api/payments/${randomUUID()}/reverse`).send({ reason: 'нет такого' })).status).toBe(404);
  });

  it('сторно возврата возвращает оплату', async () => {
    const c = await newContract({ amount: '1000' });
    await approved(c.id, '500');
    const ref = await approved(c.id, '100', { kind: 'REFUND' });
    expect(await card(c.id)).toMatchObject({ debt: '600.00' });
    expect((await post(fin, `/api/payments/${ref}/reverse`).send({ reason: 'возврат не состоялся' })).body.signedAmount).toBe('100.00');
    expect(await card(c.id)).toMatchObject({ debt: '500.00' });
  });

  it('исправление = сторно + новый платёж на подтверждение (с тем же номером транзакции)', async () => {
    const c = await newContract({ amount: '1000' });
    const id = await approved(c.id, '300', { transactionNo: 'FIX-1' });
    const key = randomUUID();
    const r = await post(fin, `/api/payments/${id}/correct`).send({ reason: 'неверная сумма', amount: '350', idempotencyKey: key });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'PENDING', amount: '350.00', correctsPaymentId: id, transactionNo: 'FIX-1' });
    expect(await card(c.id)).toMatchObject({ newPaid: '0.00', debt: '1000.00' }); // оригинал сторнирован, новый ещё не подтверждён
    expect((await post(fin, `/api/payments/${id}/correct`).send({ reason: 'неверная сумма', amount: '350', idempotencyKey: key })).body.idempotentReplay).toBe(true);
    expect((await post(fin2, `/api/payments/${r.body.id}/approve`).send({})).status).toBe(201);
    expect(await card(c.id)).toMatchObject({ newPaid: '350.00', debt: '650.00' });
  });

  it('вся история в журнале аудита; экспорт в Excel пишется в аудит', async () => {
    const c = await newContract();
    const id = await approved(c.id, '10');
    await post(fin, `/api/payments/${id}/reverse`).send({ reason: 'проверка журнала' });
    const h = (await viewer.agent.get(`/api/payments/${id}`)).body.history.map((x: any) => x.action);
    expect(h).toEqual(expect.arrayContaining(['payment.create', 'payment.approve', 'payment.reverse']));
    const x = await viewer.agent.get(`/api/payments/export?contractId=${c.id}`).buffer(true).parse((res, cb) => { const b: Buffer[] = []; res.on('data', (d: Buffer) => b.push(d)); res.on('end', () => cb(null, Buffer.concat(b))); });
    expect(x.status).toBe(200);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(x.body);
    expect(wb.worksheets[0].rowCount).toBe(3); // заголовок + платёж + сторно
    expect(await prisma.auditLog.count({ where: { action: 'export.payments' } })).toBeGreaterThan(0);
  });

  it('список: фильтры, итоги по валютам, счётчики статусов', async () => {
    const c = await newContract({ amount: '1000', currency: 'UZS' });
    await approved(c.id, '250');
    await pay(mgr, c.id, { amount: '77', submit: true });
    const r = (await viewer.agent.get(`/api/payments?contractId=${c.id}`)).body;
    expect(r.total).toBe(2);
    expect(r.byStatus).toMatchObject({ APPROVED: 1, PENDING: 1 });
    expect(r.totals).toEqual([{ currency: 'UZS', approvedNet: '250.00', pending: '77.00' }]);
    expect((await viewer.agent.get(`/api/payments?contractId=${c.id}&status=PENDING`)).body.items).toHaveLength(1);
    expect((await viewer.agent.get('/api/payments?status=HACK')).status).toBe(400);
  });
});

// ---------------- Сверка ----------------
async function xlsx(rows: [string, string, number, number][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Реестр договоров');
  ['', '№', 'Проект', 'Номер контракта', 'Наименование контрагента', 'Наименования товара', 'Сумма контракта', 'Оплачено', 'Остаток суммы (ДОЛГ)', 'Валюта'].forEach((h, i) => h && (ws.getCell(5, i + 1).value = h));
  rows.forEach(([sup, no, amount, paid], i) => {
    const r = 6 + i; ws.getCell(r, 2).value = i + 1; ws.getCell(r, 3).value = 'P'; ws.getCell(r, 4).value = no; ws.getCell(r, 5).value = sup; ws.getCell(r, 6).value = 'Товар';
    ws.getCell(r, 7).value = amount; ws.getCell(r, 8).value = paid; if (amount - paid) ws.getCell(r, 9).value = amount - paid; ws.getCell(r, 10).value = 'USD';
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}
async function importAndCommit(rows: [string, string, number, number][]) {
  const up = await post(mgr, '/api/imports').attach('file', await xlsx(rows), `rc-${randomUUID().slice(0, 6)}.xlsx`);
  await post(mgr, `/api/imports/${up.body.id}/analyze`).send({ sheetName: 'Реестр договоров' });
  const c = await post(fin, `/api/imports/${up.body.id}/commit`).send({ confirm: true, planYear: 2026 });
  expect(c.status).toBe(201);
  return c.body;
}
const byNo = (no: string) => prisma.contract.findFirstOrThrow({ where: { number: no } });
const taskOf = async (no: string, status = 'PENDING') => (await fin.agent.get(`/api/reconciliation?status=${status}&pageSize=200`)).body.items.find((t: any) => t.contract?.number === no);

describe('M4: сверка с источником (без двойного учёта)', () => {
  const sfx = randomUUID().slice(0, 6);
  const N = (k: number) => `RC${sfx}-${k}`;
  const SUP = (k: number) => `RC-SUPPLIER-${sfx}-${k}`;
  const base: [string, string, number, number][] = [[SUP(1), N(1), 1000, 0], [SUP(2), N(2), 1000, 0], [SUP(3), N(3), 1000, 0], [SUP(4), N(4), 1000, 0], [SUP(5), N(5), 1000, 400]];

  beforeAll(async () => {
    await importAndCommit(base);
    // Новые платежи приложения (подтверждены): договор 1 — 300+200, договор 2 — 500, договор 3 — 500
    const c1 = await byNo(N(1)), c2 = await byNo(N(2)), c3 = await byNo(N(3));
    await approved(c1.id, '300'); await approved(c1.id, '200'); await approved(c2.id, '500'); await approved(c3.id, '500');
  });

  it('повторный импорт с изменением «Оплачено» создаёт задачи сверки и НЕ меняет договоры', async () => {
    const rep = await importAndCommit([[SUP(1), N(1), 1000, 500], [SUP(2), N(2), 1000, 800], [SUP(3), N(3), 1000, 100], [SUP(4), N(4), 1000, 500], [SUP(5), N(5), 1000, 100]]);
    expect(rep).toMatchObject({ contractsCreated: 0, contractsChangedInSource: 5, reconciliationTasks: 5 });
    for (const k of [1, 2, 3, 4, 5]) expect((await byNo(N(k))).openingPaid.toFixed(2)).toBe(k === 5 ? '400.00' : '0.00');
    const t = await taskOf(N(1));
    expect(t).toMatchObject({ status: 'PENDING', delta: '500.00' });
    expect(t.candidates.map((c: any) => c.amount).sort()).toEqual(['200.00', '300.00']);
    expect(t.suggestedPaymentIds).toHaveLength(2); // 300+200 = 500 — точное совпадение найдено автоматически
  });

  it('права: смотреть — да, решать — только FINANCE/админы', async () => {
    const t = await taskOf(N(1));
    expect((await viewer.agent.get('/api/reconciliation/stats')).status).toBe(200);
    expect((await post(viewer, `/api/reconciliation/${t.id}/confirm`).send({})).status).toBe(403);
    expect((await post(mgr, `/api/reconciliation/${t.id}/confirm`).send({})).status).toBe(403);
  });

  it('точное сопоставление: платежи «поглощаются» начальным остатком, долг не меняется — двойного учёта нет', async () => {
    const c = await byNo(N(1));
    expect(await card(c.id)).toMatchObject({ debt: '500.00', openingPaid: '0.00', newPaid: '500.00' }); // до сверки: 1000 − 0 − 500
    const t = await taskOf(N(1));
    const m = await post(fin, `/api/reconciliation/${t.id}/match`).send({ paymentIds: t.suggestedPaymentIds });
    expect(m.body.status).toBe('MATCHED');
    expect((await card(c.id)).debt).toBe('500.00'); // сопоставление ничего не применяет
    const ok = await post(fin, `/api/reconciliation/${t.id}/confirm`).send({});
    expect(ok.status).toBe(201);
    expect(ok.body.status).toBe('CONFIRMED');
    expect(ok.body.resolution).toMatchObject({ matchedAmount: '500.00', difference: '0.00', acceptedDifference: false });
    expect(await card(c.id)).toMatchObject({ debt: '500.00', openingPaid: '500.00', newPaid: '0.00' }); // после: 1000 − 500 − 0 — тот же долг
    const ps = await prisma.payment.findMany({ where: { contractId: c.id } });
    expect(ps.every((p) => p.reflectedInOpening && p.reflectedTaskId === t.id)).toBe(true);
    expect((await prisma.contract.findUniqueOrThrow({ where: { id: c.id } })).sourcePaid?.toFixed(2)).toBe('500.00');
    expect((await post(fin, `/api/reconciliation/${t.id}/confirm`).send({})).status).toBe(409); // закрытая задача
  });

  it('расхождение: прирост в источнике больше сопоставленных платежей — нужно явное подтверждение', async () => {
    const c = await byNo(N(2));
    const t = await taskOf(N(2));
    expect(t).toMatchObject({ delta: '800.00' });
    const denied = await post(fin, `/api/reconciliation/${t.id}/confirm`).send({ paymentIds: [t.candidates[0].id] });
    expect(denied.status).toBe(409);
    expect(denied.body).toMatchObject({ code: 'RECON_DIFFERENCE', difference: '300.00' });
    expect((await byNo(N(2))).openingPaid.toFixed(2)).toBe('0.00'); // откат: ничего не применено
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: t.candidates[0].id } })).reflectedInOpening).toBe(false);
    const ok = await post(fin, `/api/reconciliation/${t.id}/confirm`).send({ paymentIds: [t.candidates[0].id], acceptDifference: true, note: 'Оплата прошла напрямую директором' });
    expect(ok.body.resolution).toMatchObject({ difference: '300.00', acceptedDifference: true, note: 'Оплата прошла напрямую директором' });
    expect(await card(c.id)).toMatchObject({ openingPaid: '800.00', newPaid: '0.00', debt: '200.00' });
  });

  it('нельзя сопоставить платежей больше, чем прирост в источнике (это двойной учёт)', async () => {
    const t = await taskOf(N(3));
    expect(t).toMatchObject({ delta: '100.00' });
    const r = await post(fin, `/api/reconciliation/${t.id}/confirm`).send({ paymentIds: [t.candidates[0].id], acceptDifference: true });
    expect(r.status).toBe(400); expect(r.body.message).toMatch(/двойному учёту/);
    expect((await byNo(N(3))).openingPaid.toFixed(2)).toBe('0.00');
  });

  it('платёж другого договора или неподтверждённый платёж сопоставить нельзя', async () => {
    const t = await taskOf(N(3)), other = await byNo(N(2));
    const foreign = await prisma.payment.findFirstOrThrow({ where: { contractId: other.id } });
    expect((await post(fin, `/api/reconciliation/${t.id}/match`).send({ paymentIds: [foreign.id] })).status).toBe(400);
    const pending = await pay(mgr, (await byNo(N(3))).id, { amount: '5', submit: true });
    expect((await post(fin, `/api/reconciliation/${t.id}/match`).send({ paymentIds: [pending.body.id] })).status).toBe(400);
  });

  it('отклонение оставляет данные приложения и не создаёт задачу при повторном импорте того же значения', async () => {
    const t = await taskOf(N(4));
    expect((await post(fin, `/api/reconciliation/${t.id}/reject`).send({})).status).toBe(400);
    const r = await post(fin, `/api/reconciliation/${t.id}/reject`).send({ reason: 'В таблице ошибка, оплаты не было' });
    expect(r.body).toMatchObject({ status: 'REJECTED' });
    const c = await byNo(N(4));
    expect(c.openingPaid.toFixed(2)).toBe('0.00');
    expect(c.sourcePaid?.toFixed(2)).toBe('500.00');
    const rep = await importAndCommit([[SUP(4), N(4), 1000, 500]]);
    expect(rep.reconciliationTasks).toBe(0);
    expect(await taskOf(N(4))).toBeUndefined();
  });

  it('источник уменьшил «Оплачено»: сопоставлять нечего, нужно явное подтверждение и запись причины', async () => {
    const t = await taskOf(N(5));
    expect(t).toMatchObject({ delta: '-300.00', candidates: [] });
    const denied = await post(fin, `/api/reconciliation/${t.id}/confirm`).send({});
    expect(denied.status).toBe(409); expect(denied.body.code).toBe('RECON_DIFFERENCE');
    const ok = await post(fin, `/api/reconciliation/${t.id}/confirm`).send({ acceptDifference: true, note: 'Банк вернул платёж' });
    expect(ok.status).toBe(201);
    expect(await card((await byNo(N(5))).id)).toMatchObject({ openingPaid: '100.00', debt: '900.00' });
  });

  it('статистика и фильтры списка задач; решения в журнале аудита', async () => {
    const st = (await viewer.agent.get('/api/reconciliation/stats')).body;
    expect(st.byStatus.CONFIRMED).toBeGreaterThanOrEqual(3);
    expect(st.byStatus.REJECTED).toBeGreaterThanOrEqual(1);
    const closed = (await viewer.agent.get('/api/reconciliation?open=false&pageSize=200')).body.items;
    expect(closed.every((x: any) => x.status === 'CONFIRMED' || x.status === 'REJECTED')).toBe(true);
    const t = (await fin.agent.get(`/api/reconciliation/${closed.find((x: any) => x.contract?.number === N(1)).id}`)).body;
    expect(t.history.map((h: any) => h.action)).toEqual(expect.arrayContaining(['reconciliation.match', 'reconciliation.confirm']));
    expect((await viewer.agent.get('/api/reconciliation?status=HACK')).status).toBe(400);
  });
});
