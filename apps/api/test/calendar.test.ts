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
const put = (s: S, u: string) => s.agent.put(u).set('x-csrf-token', s.csrf);
const del = (s: S, u: string) => s.agent.delete(u).set('x-csrf-token', s.csrf);
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
  mgr = await user(admin, 'cmgr@example.test', 'MANAGER'); fin = await user(admin, 'cfin@example.test', 'FINANCE');
  fin2 = await user(admin, 'cfin2@example.test', 'FINANCE'); viewer = await user(admin, 'cview@example.test', 'VIEWER');
});
afterAll(async () => { await prisma.$disconnect(); await app.close(); });

async function newContract(o: { supplier?: string; amount?: string; currency?: string; paid?: string } = {}) {
  const sup = await post(mgr, '/api/suppliers').send({ name: o.supplier ?? `CAL-SUP-${randomUUID().slice(0, 8)}` });
  const c = await post(mgr, '/api/contracts').send({ supplierId: sup.body.id, number: `CC-${randomUUID().slice(0, 6)}`, amount: o.amount ?? '10000', currency: o.currency ?? 'USD', openingPaid: o.paid ?? '0' });
  expect(c.status).toBe(201);
  return { id: c.body.id as string, supplierId: sup.body.id as string };
}
const plan = (s: S, contractId: string, o: object = {}) => post(s, '/api/calendar/plans').send({ contractId, year: 2025, month: 3, week: 1, amount: '1000', ...o });
const card = async (id: string) => (await viewer.agent.get(`/api/contracts/${id}`)).body;
async function paid(contractId: string, date: string, amount: string, kind = 'PAYMENT') {
  const p = await post(mgr, '/api/payments').send({ contractId, paymentDate: date, amount, kind, submit: true, confirmDuplicate: true, idempotencyKey: randomUUID() });
  expect(p.status).toBe(201);
  expect((await post(fin, `/api/payments/${p.body.id}/approve`).send({ confirmOverpayment: true })).status).toBe(201);
  return p.body.id as string;
}
const month = (q: string) => viewer.agent.get(`/api/calendar/month?year=2025&month=3&${q}`).then((r) => r.body);

describe('M5: операции с планом', () => {
  it('создание: права, валидация, валюта из договора, один план на договор и неделю', async () => {
    const c = await newContract({ currency: 'EUR' });
    expect((await plan(viewer, c.id)).status).toBe(403);
    expect((await plan(mgr, c.id, { amount: '0' })).status).toBe(400);
    expect((await plan(mgr, c.id, { month: 13 })).status).toBe(400);
    expect((await plan(mgr, c.id, { week: 5 })).status).toBe(400);
    expect((await plan(mgr, c.id, { amount: '10.999' })).status).toBe(400);
    expect((await plan(mgr, randomUUID())).status).toBe(400);
    const ok = await plan(mgr, c.id);
    expect(ok.status).toBe(201);
    expect(await prisma.planEntry.findUniqueOrThrow({ where: { id: ok.body.id } })).toMatchObject({ currency: 'EUR', source: 'MANUAL' });
    const dup = await plan(mgr, c.id, { amount: '5' });
    expect(dup.status).toBe(409); expect(dup.body).toMatchObject({ code: 'PLAN_EXISTS', planId: ok.body.id });
    await post(mgr, `/api/contracts/${c.id}/archive`);
    expect((await plan(mgr, c.id, { week: 2 })).status).toBe(400);
  });

  it('план никогда не уменьшает долг', async () => {
    const c = await newContract({ amount: '5000', paid: '1000' });
    const before = await card(c.id);
    for (const w of [1, 2, 3]) await plan(mgr, c.id, { week: w, amount: '1500' });
    const after = await card(c.id);
    expect(after).toMatchObject({ debt: before.debt, paid: before.paid, newPaid: '0.00', planned: '4500.00' });
  });

  it('правка суммы и комментария, удаление; всё в журнале', async () => {
    const c = await newContract();
    const p = (await plan(mgr, c.id)).body;
    expect((await patch(viewer, `/api/calendar/plans/${p.id}`).send({ amount: '1' })).status).toBe(403);
    expect((await patch(mgr, `/api/calendar/plans/${p.id}`).send({ amount: '-1' })).status).toBe(400);
    expect((await patch(mgr, `/api/calendar/plans/${p.id}`).send({ hack: 1 })).status).toBe(400);
    const u = await patch(fin, `/api/calendar/plans/${p.id}`).send({ amount: '1234.50', note: 'По согласованию с поставщиком' });
    expect(u.body).toMatchObject({ amount: '1234.50', note: 'По согласованию с поставщиком' });
    expect((await del(mgr, `/api/calendar/plans/${p.id}`)).status).toBe(200);
    expect(await prisma.planEntry.count({ where: { id: p.id } })).toBe(0);
    const actions = (await prisma.auditLog.findMany({ where: { entityId: p.id }, select: { action: true } })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['plan.create', 'plan.update', 'plan.delete']));
  });

  it('перенос на другую неделю; на занятую — суммы складываются; та же неделя — ошибка', async () => {
    const c = await newContract();
    const a = (await plan(mgr, c.id, { week: 1, amount: '1000' })).body, b = (await plan(mgr, c.id, { week: 3, amount: '400' })).body;
    expect((await post(mgr, `/api/calendar/plans/${a.id}/move`).send({ year: 2025, month: 3, week: 1 })).status).toBe(400);
    expect((await post(viewer, `/api/calendar/plans/${a.id}/move`).send({ year: 2025, month: 4, week: 2 })).status).toBe(403);
    const moved = await post(mgr, `/api/calendar/plans/${a.id}/move`).send({ year: 2025, month: 4, week: 2 });
    expect(moved.body).toMatchObject({ id: a.id, month: 4, week: 2, amount: '1000.00' });
    const merged = await post(mgr, `/api/calendar/plans/${a.id}/move`).send({ year: 2025, month: 3, week: 3 });
    expect(merged.body).toMatchObject({ id: b.id, amount: '1400.00', month: 3, week: 3 });
    expect(await prisma.planEntry.count({ where: { contractId: c.id } })).toBe(1);
  });

  it('разделение: сумма частей строго равна исходной; недели не повторяются; слияние с существующим планом', async () => {
    const c = await newContract();
    const src = (await plan(mgr, c.id, { week: 1, amount: '1000' })).body;
    await plan(mgr, c.id, { week: 2, amount: '100' });
    const bad = (parts: object[]) => post(mgr, `/api/calendar/plans/${src.id}/split`).send({ parts });
    expect((await bad([{ year: 2025, month: 3, week: 1, amount: '600' }, { year: 2025, month: 3, week: 4, amount: '300' }])).status).toBe(400); // 900 ≠ 1000
    expect((await bad([{ year: 2025, month: 3, week: 1, amount: '500' }, { year: 2025, month: 3, week: 1, amount: '500' }])).status).toBe(400); // повтор недели
    expect((await bad([{ year: 2025, month: 3, week: 1, amount: '1000' }])).status).toBe(400); // одна часть
    expect((await post(viewer, `/api/calendar/plans/${src.id}/split`).send({ parts: [] })).status).toBe(403);
    const ok = await bad([{ year: 2025, month: 3, week: 1, amount: '400' }, { year: 2025, month: 3, week: 2, amount: '350.50' }, { year: 2025, month: 4, week: 3, amount: '249.50' }]);
    expect(ok.status).toBe(201);
    const rows = await prisma.planEntry.findMany({ where: { contractId: c.id }, orderBy: [{ month: 'asc' }, { week: 'asc' }] });
    expect(rows.map((r) => [r.month, r.week, r.amount.toFixed(2)])).toEqual([[3, 1, '400.00'], [3, 2, '450.50'], [4, 3, '249.50']]); // W2: 100 + 350.50
    expect(rows.reduce((s, r) => s + Number(r.amount), 0)).toBe(1100); // 1000 + 100: ничего не потеряно и не создано
    expect(rows.every((r) => r.source === 'MANUAL')).toBe(true);
  });

  it('разделение без исходной недели удаляет исходную запись', async () => {
    const c = await newContract();
    const src = (await plan(mgr, c.id, { week: 1, amount: '900' })).body;
    await post(mgr, `/api/calendar/plans/${src.id}/split`).send({ parts: [{ year: 2025, month: 5, week: 1, amount: '450' }, { year: 2025, month: 5, week: 2, amount: '450' }] });
    expect(await prisma.planEntry.findUnique({ where: { id: src.id } })).toBeNull();
    expect(await prisma.planEntry.count({ where: { contractId: c.id } })).toBe(2);
  });
});

describe('M5: календарь — план против факта', () => {
  let c: { id: string; supplierId: string }, u: { id: string; supplierId: string };
  beforeAll(async () => {
    c = await newContract({ amount: '10000', currency: 'USD' });
    u = await newContract({ amount: '9000000', currency: 'UZS' });
    await plan(mgr, c.id, { week: 1, amount: '3000' }); await plan(mgr, c.id, { week: 2, amount: '2000' }); await plan(mgr, c.id, { week: 4, amount: '1000' });
    await plan(mgr, u.id, { week: 1, amount: '500000' });
    await paid(c.id, '2025-03-03', '2500');  // W1: факт 2500 < план 3000
    await paid(c.id, '2025-03-10', '2500');  // W2: факт 2500 > план 2000
    await paid(c.id, '2025-03-20', '400');   // W3: факт без плана
    await paid(c.id, '2025-03-04', '100', 'REFUND'); // W1: возврат уменьшает факт → 2400
    await paid(u.id, '2025-03-05', '500000'); // UZS W1: план выполнен
    // не считаются фактом: черновик, ожидающий, отклонённый
    await post(mgr, '/api/payments').send({ contractId: c.id, paymentDate: '2025-03-25', amount: '777', idempotencyKey: randomUUID() });
    await post(mgr, '/api/payments').send({ contractId: c.id, paymentDate: '2025-03-26', amount: '888', submit: true, idempotencyKey: randomUUID() });
  });

  it('месяц: план, факт, остаток плана и «сверх плана» — по договору и неделе', async () => {
    const m = await month(`contractId=${c.id}`);
    const row = m.rows[0];
    const by = (w: number) => row.cells.find((x: any) => x.week === w);
    expect(by(1)).toMatchObject({ planned: '3000.00', actual: '2400.00', remaining: '600.00', over: '0.00' });
    expect(by(2)).toMatchObject({ planned: '2000.00', actual: '2500.00', remaining: '0.00', over: '500.00' });
    expect(by(3)).toMatchObject({ planned: null, actual: '400.00', over: '400.00' }); // факт без плана
    expect(by(4)).toMatchObject({ planned: '1000.00', actual: '0.00', remaining: '1000.00' });
    expect(row).toMatchObject({ plannedTotal: '6000.00', actualTotal: '5300.00', currency: 'USD' });
    expect(by(4).source).toBe('MANUAL');
  });

  it('итоги по валютам не смешиваются; остаток не «гасится» переисполнением другой недели', async () => {
    const m = await month(`supplierId=${c.supplierId}`);
    expect(m.totals).toHaveLength(1);
    const t = m.totals[0];
    expect(t.currency).toBe('USD');
    expect(t.total).toEqual({ planned: '6000.00', actual: '5300.00', remaining: '1600.00', over: '900.00', overdue: '1600.00' }); // 600 + 0 + 1000; 0 + 500 + 400
    expect(t.weeks.map((w: any) => w.week)).toEqual([1, 2, 3, 4]);
    const all = await month(`contractId=${u.id}`);
    expect(all.totals[0]).toMatchObject({ currency: 'UZS', total: { planned: '500000.00', actual: '500000.00', remaining: '0.00', over: '0.00' } });
    const both = (await month('')).totals.map((x: any) => x.currency);
    expect(both).toEqual(expect.arrayContaining(['USD', 'UZS']));
  });

  it('просроченные: невыполненный план прошедших недель', async () => {
    const m = await month(`contractId=${c.id}`);
    expect(m.weeks.every((w: any) => w.past)).toBe(true); // 2025 — в прошлом
    expect(m.rows[0].cells.find((x: any) => x.week === 4).overdue).toBe('1000.00');
    expect(m.totals[0].total.remaining).toBe('1600.00');
    expect(m.totals[0].weeks.find((w: any) => w.week === 4).overdue).toBe('1000.00');
    const future = (await viewer.agent.get(`/api/calendar/month?year=2099&month=1&contractId=${c.id}`)).body;
    expect(future.weeks.every((w: any) => !w.past)).toBe(true);
  });

  it('просрочка не превышает долг: оплаченный договор с прошедшим планом (история) — не просрочен', async () => {
    const settled = await newContract({ amount: '1000', paid: '1000', currency: 'USD' }); // долга нет
    const small = await newContract({ amount: '1000', paid: '700', currency: 'USD' });   // долг 300
    await plan(mgr, settled.id, { week: 1, amount: '900' });
    await plan(mgr, small.id, { week: 1, amount: '200' }); await plan(mgr, small.id, { week: 2, amount: '200' }); // невыполнено 400 > долга 300
    const a = (await month(`contractId=${settled.id}`)).rows[0].cells[0];
    expect(a).toMatchObject({ planned: '900.00', remaining: '900.00', overdue: '0.00' }); // «остаток плана» виден, но просрочки нет
    const m = await month(`contractId=${small.id}`);
    expect(m.rows[0].cells.map((x: any) => x.overdue)).toEqual(['200.00', '100.00', '0.00', '0.00']); // нарастающим итогом, максимум 300
    expect(m.totals[0].total).toMatchObject({ remaining: '400.00', overdue: '300.00' });
    const y = (await viewer.agent.get(`/api/calendar/year?year=2025&contractId=${small.id}`)).body;
    expect(y.months.find((x: any) => x.month === 3).currencies[0].overdue).toBe('300.00');
  });

  it('факт — только подтверждённые платежи: черновики, ожидающие и отклонённые не входят', async () => {
    const m = await month(`contractId=${c.id}`);
    expect(m.rows[0].cells.find((x: any) => x.week === 4).actual).toBe('0.00'); // 25–26 марта (777/888) не посчитаны
    expect(m.rows[0].actualTotal).toBe('5300.00');
  });

  it('фильтры: договор, поставщик, валюта, поиск; архивные договоры скрыты', async () => {
    expect((await month(`currency=UZS&contractId=${c.id}`)).rows).toHaveLength(0);
    expect((await month(`supplierId=${u.supplierId}`)).rows.map((r: any) => r.contract.id)).toEqual([u.id]);
    expect((await viewer.agent.get('/api/calendar/month?year=2025&month=3&currency=XXX')).status).toBe(400);
    expect((await viewer.agent.get('/api/calendar/month?year=2025&month=13')).status).toBe(400);
    const arch = await newContract(); await plan(mgr, arch.id); await post(mgr, `/api/contracts/${arch.id}/archive`);
    expect((await month(`contractId=${arch.id}`)).rows).toHaveLength(0);
  });

  it('годовой вид: итоги по месяцам и валютам; месяцы без данных пусты', async () => {
    const y = (await viewer.agent.get(`/api/calendar/year?year=2025&supplierId=${c.supplierId}`)).body;
    expect(y.months).toHaveLength(12);
    const mar = y.months.find((m: any) => m.month === 3).currencies[0];
    expect(mar).toMatchObject({ currency: 'USD', planned: '6000.00', actual: '5300.00', remaining: '1600.00', over: '900.00', overdue: '1600.00' });
    expect(y.months.find((m: any) => m.month === 1).currencies).toEqual([]);
    expect(y.totals[0]).toMatchObject({ currency: 'USD', planned: '6000.00' });
  });

  it('границы недель настраиваются: меняют отнесение факта; права и валидация', async () => {
    expect((await viewer.agent.get('/api/calendar/settings')).body).toMatchObject({ bounds: { w1End: 7, w2End: 14, w3End: 21 } });
    expect((await put(fin, '/api/calendar/settings').send({ w1End: 2, w2End: 9, w3End: 23 })).status).toBe(403);
    expect((await put(admin, '/api/calendar/settings').send({ w1End: 9, w2End: 5, w3End: 23 })).status).toBe(400);
    expect((await put(admin, '/api/calendar/settings').send({ w1End: 7, w2End: 14, w3End: 28 })).status).toBe(400);
    try {
      expect((await put(admin, '/api/calendar/settings').send({ w1End: 2, w2End: 9, w3End: 23 })).status).toBe(200);
      const m = await month(`contractId=${c.id}`);
      const by = (w: number) => m.rows[0].cells.find((x: any) => x.week === w);
      // новые недели: 1–2, 3–9, 10–23, 24–31: платежи 3 и 4 марта → W2; 10 и 20 марта → W3; план остаётся в своих ячейках
      expect(by(1).actual).toBe('0.00'); expect(by(2).actual).toBe('2400.00'); expect(by(3).actual).toBe('2900.00');
      expect(m.weeks.map((w: any) => [w.from, w.to])).toEqual([[1, 2], [3, 9], [10, 23], [24, 31]]);
      expect(await prisma.auditLog.count({ where: { action: 'calendar.settings' } })).toBeGreaterThan(0);
    } finally {
      await put(admin, '/api/calendar/settings').send({ w1End: 7, w2End: 14, w3End: 21 });
    }
    expect((await month(`contractId=${c.id}`)).rows[0].cells.find((x: any) => x.week === 1).actual).toBe('2400.00');
  });

  it('долг без плана: только договоры с долгом и без плана на текущие/будущие недели', async () => {
    const d = await newContract({ amount: '777', currency: 'RUB' });
    const full = await newContract({ amount: '100', currency: 'RUB', paid: '100' });
    let r = (await viewer.agent.get('/api/calendar/unplanned?currency=RUB')).body;
    expect(r.items.map((i: any) => i.contractId)).toContain(d.id);
    expect(r.items.map((i: any) => i.contractId)).not.toContain(full.id); // нет долга
    expect(r.totals.find((t: any) => t.currency === 'RUB')).toBeTruthy();
    await plan(mgr, d.id, { year: 2025, month: 1, week: 1, amount: '10' }); // прошлая неделя — не считается
    expect((await viewer.agent.get('/api/calendar/unplanned?currency=RUB')).body.items.map((i: any) => i.contractId)).toContain(d.id);
    await plan(mgr, d.id, { year: 2099, month: 1, week: 1, amount: '10' }); // будущая — считается
    r = (await viewer.agent.get('/api/calendar/unplanned?currency=RUB')).body;
    expect(r.items.map((i: any) => i.contractId)).not.toContain(d.id);
    expect(r.totals.every((t: any) => t.currency === 'RUB')).toBe(true); // фильтр по валюте
  });

  it('операции с планом записаны в журнал аудита', async () => {
    const actions = new Set((await prisma.auditLog.findMany({ where: { entity: 'PlanEntry' }, select: { action: true } })).map((a) => a.action));
    for (const a of ['plan.create', 'plan.update', 'plan.move', 'plan.split', 'plan.delete']) expect(actions.has(a)).toBe(true);
  });
});

describe('M5: план из импорта и ручные правки', () => {
  async function xlsx(sup: string, no: string, k: number, l: number): Promise<Buffer> {
    const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Реестр договоров');
    ws.getCell('K3').value = 'Июнь'; ws.getCell('L3').value = 'Июнь'; ws.getCell('K4').value = 'W1'; ws.getCell('L4').value = 'W2';
    ['', '№', 'Проект', 'Номер контракта', 'Наименование контрагента', 'Наименования товара', 'Сумма контракта', 'Оплачено', 'Остаток суммы (ДОЛГ)', 'Валюта'].forEach((h, i) => h && (ws.getCell(5, i + 1).value = h));
    ws.getCell('B6').value = 1; ws.getCell('C6').value = 'P'; ws.getCell('D6').value = no; ws.getCell('E6').value = sup; ws.getCell('F6').value = 'x'; ws.getCell('G6').value = 5000; ws.getCell('H6').value = 0; ws.getCell('I6').value = 5000; ws.getCell('J6').value = 'USD';
    ws.getCell('K6').value = k; ws.getCell('L6').value = l;
    return Buffer.from(await wb.xlsx.writeBuffer());
  }
  const run = async (buf: Buffer) => {
    const up = await post(mgr, '/api/imports').attach('file', buf, `p-${randomUUID().slice(0, 5)}.xlsx`);
    await post(mgr, `/api/imports/${up.body.id}/analyze`).send({ sheetName: 'Реестр договоров' });
    const r = await post(fin, `/api/imports/${up.body.id}/commit`).send({ confirm: true, planYear: 2025 });
    expect(r.status).toBe(201); return r.body;
  };

  it('отредактированный плановый платёж не перезаписывается повторным импортом; дублей нет', async () => {
    const sfx = randomUUID().slice(0, 6), sup = `CAL-IMP-${sfx}`, no = `CI-${sfx}`;
    await run(await xlsx(sup, no, 300, 200));
    const c = await prisma.contract.findFirstOrThrow({ where: { number: no } });
    let plans = await prisma.planEntry.findMany({ where: { contractId: c.id }, orderBy: { week: 'asc' } });
    expect(plans.map((p) => [p.month, p.week, p.amount.toFixed(2), p.source])).toEqual([[6, 1, '300.00', 'IMPORT'], [6, 2, '200.00', 'IMPORT']]);
    expect((await patch(mgr, `/api/calendar/plans/${plans[0].id}`).send({ amount: '350' })).status).toBe(200); // → MANUAL
    await run(await xlsx(sup, no, 300, 250)); // в таблице W2 изменилась, W1 нет
    plans = await prisma.planEntry.findMany({ where: { contractId: c.id }, orderBy: { week: 'asc' } });
    expect(plans.map((p) => [p.week, p.amount.toFixed(2), p.source])).toEqual([[1, '350.00', 'MANUAL'], [2, '250.00', 'IMPORT']]);
  });

  it('импортированный план попадает в календарь и не влияет на долг', async () => {
    const sfx = randomUUID().slice(0, 6), no = `CI2-${sfx}`;
    await run(await xlsx(`CAL-IMP2-${sfx}`, no, 1000, 0));
    const c = await prisma.contract.findFirstOrThrow({ where: { number: no } });
    const m = (await viewer.agent.get(`/api/calendar/month?year=2025&month=6&contractId=${c.id}`)).body;
    expect(m.rows[0].cells.find((x: any) => x.week === 1)).toMatchObject({ planned: '1000.00', source: 'IMPORT', actual: '0.00', remaining: '1000.00' });
    expect(await card(c.id)).toMatchObject({ debt: '5000.00' });
  });
});
