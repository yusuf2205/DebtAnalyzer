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
async function user(admin: S, email: string, role: string) {
  await post(admin, '/api/users').send({ email, name: email.split('@')[0], role, password: PW });
  const a = await login(email, PW); await post(a, '/api/auth/change-password').send({ current: PW, next: PW + '2' });
  return login(email, PW + '2');
}
let admin: S, mgr: S, fin: S, viewer: S;

const today = new Date().toISOString().slice(0, 10);
const nextYear = new Date().getUTCFullYear() + 1;
const bin = (res: any, cb: any) => { const b: Buffer[] = []; res.on('data', (d: Buffer) => b.push(d)); res.on('end', () => cb(null, Buffer.concat(b))); };

async function supplier(name = `AN-SUP-${randomUUID().slice(0, 8)}`) { return (await post(mgr, '/api/suppliers').send({ name })).body.id as string; }
async function contract(supplierId: string, o: { amount: string; currency: string; paid?: string; project?: string; executor?: string; number?: string }) {
  const r = await post(mgr, '/api/contracts').send({ supplierId, number: o.number ?? `AC-${randomUUID().slice(0, 6)}`, amount: o.amount, currency: o.currency, openingPaid: o.paid ?? '0', project: o.project, executor: o.executor });
  expect(r.status).toBe(201); return r.body.id as string;
}
async function approvedPayment(contractId: string, date: string, amount: string, over = false) {
  const p = await post(mgr, '/api/payments').send({ contractId, paymentDate: date, amount, submit: true, confirmDuplicate: true, idempotencyKey: randomUUID() });
  expect(p.status).toBe(201);
  expect((await post(fin, `/api/payments/${p.body.id}/approve`).send({ confirmOverpayment: over })).status).toBe(201);
}
const plan = (contractId: string, year: number, month: number, week: number, amount: string) => post(mgr, '/api/calendar/plans').send({ contractId, year, month, week, amount });
const rate = (currency: string, uzs: string, date: string) => prisma.fxRate.create({ data: { currency: currency as 'USD', uzsPerUnit: uzs, effectiveDate: new Date(date), source: 'TEST', status: 'CONFIRMED', confirmedAt: new Date() } });
const dash = (q: string) => viewer.agent.get(`/api/dashboard?${q}`).then((r) => { expect(r.status).toBe(200); return r.body; });
const report = (id: string, q = '') => viewer.agent.get(`/api/reports/${id}?${q}`).then((r) => { expect(r.status, JSON.stringify(r.body)).toBe(200); return r.body; });
const exp = (id: string, q: string) => viewer.agent.get(`/api/reports/${id}/export?${q}`).buffer(true).parse(bin);

let S: string, S2: string, S3: string, S4: string, S5: string;
let cA: string, cB: string, cC: string;

beforeAll(async () => {
  app = await createApp({ logger: false }); await app.init(); prisma = new PrismaClient();
  let r = await login('root@example.test', 'InitialPassw0rd!');
  if (r.status === 200) await post(r, '/api/auth/change-password').send({ current: 'InitialPassw0rd!', next: PW });
  admin = await login('root@example.test', PW);
  mgr = await user(admin, 'amgr@example.test', 'MANAGER'); fin = await user(admin, 'afin@example.test', 'FINANCE'); viewer = await user(admin, 'aview@example.test', 'VIEWER');

  // Курсы: сегодняшние (для дашборда) и исторические 2019 года (для проверки «курс на дату»).
  await rate('USD', '12085', today); await rate('EUR', '13470', today);
  await rate('USD', '12000', '2019-01-01'); await rate('USD', '24000', '2019-06-01');

  S = await supplier();
  cA = await contract(S, { amount: '10000', currency: 'USD', paid: '2000', project: 'PRJ-A', executor: 'Иванов', number: 'A "оригинал"; доп.' });
  cB = await contract(S, { amount: '12085000', currency: 'UZS', project: 'PRJ-B', executor: 'Иванов.' });
  cC = await contract(S, { amount: '1000', currency: 'EUR', paid: '900', project: 'PRJ-A', executor: 'Петров' });
  await approvedPayment(cC, '2025-05-05', '200', true); // переплата 100 EUR
  await plan(cA, 2025, 3, 1, '3000');      // прошедшая неделя, не выполнена
  await plan(cA, nextYear, 1, 1, '2500');  // будущая неделя

  S2 = await supplier(); // полностью оплаченный договор с «историческим» планом
  const cD = await contract(S2, { amount: '500', currency: 'USD', paid: '500' });
  await plan(cD, 2025, 3, 1, '400'); await plan(cD, nextYear, 1, 1, '300');

  S3 = await supplier(); await contract(S3, { amount: '5000', currency: 'RUB' }); // валюта без курса

  S4 = await supplier(); await contract(S4, { amount: '12000000', currency: 'UZS' }); // для проверки исторических курсов

  S5 = await supplier(); // платежи 2019 года
  const cG = await contract(S5, { amount: '100000000', currency: 'UZS' });
  await approvedPayment(cG, '2019-02-10', '12000000'); await approvedPayment(cG, '2019-07-10', '24000000');
});
afterAll(async () => { await prisma.$disconnect(); await app.close(); });

describe('M6: дашборд', () => {
  it('KPI по валютам, эквиваленты в USD по подтверждённым курсам, итог без смешивания валют', async () => {
    const d = await dash(`supplierId=${S}`);
    expect(d.kpi).toMatchObject({ contracts: 3, suppliers: 1 });
    const by = (c: string) => d.kpi.byCurrency.find((x: any) => x.currency === c);
    expect(by('USD')).toMatchObject({ contracts: 1, amount: '10000.00', paid: '2000.00', debt: '8000.00', overpaid: '0.00', planned: '5500.00', rate: '1' });
    expect(by('UZS')).toMatchObject({ amount: '12085000.00', debt: '12085000.00', usd: { debt: '1000.00' } });
    expect(by('EUR')).toMatchObject({ amount: '1000.00', paid: '1100.00', debt: '0.00', overpaid: '100.00', usd: { overpaid: '111.46' } });
    expect(Number(by('EUR').rate)).toBeCloseTo(13470 / 12085, 6);
    expect(by('EUR').rateDate).toBe(today);
    expect(d.kpi.totalUsd).toMatchObject({ debt: '9000.00', overpaid: '111.46' });
    expect(d.rates).toMatchObject({ missing: [], usdComplete: true });
  });

  it('нет подтверждённого курса — эквивалент не выдумывается, итог неполный, причина названа', async () => {
    const d = await dash(`supplierId=${S3}`);
    const rub = d.kpi.byCurrency[0];
    expect(rub).toMatchObject({ currency: 'RUB', debt: '5000.00', usd: null, rate: null });
    expect(d.kpi.totalUsd.debt).toBeNull();
    expect(d.rates).toMatchObject({ missing: ['RUB'], usdComplete: false });
    expect(d.rates.note).toMatch(/RUB/);
  });

  it('просроченные и предстоящие: план не больше долга; у оплаченного договора их нет', async () => {
    const d = await dash(`supplierId=${S}&horizon=365`);
    expect(d.overdue.byCurrency).toEqual([{ currency: 'USD', contracts: 1, amount: '3000.00' }]);
    expect(d.overdue.totalUsd).toBe('3000.00');
    expect(d.overdue.items[0]).toMatchObject({ amount: '3000.00', debt: '8000.00' });
    expect(d.upcoming.byCurrency).toEqual([{ currency: 'USD', amount: '2500.00' }]);
    expect(d.upcoming.items[0]).toMatchObject({ year: nextYear, month: 1, week: 1, amount: '2500.00' });
    const settled = await dash(`supplierId=${S2}&horizon=365`);
    expect(settled.overdue.byCurrency).toEqual([]);
    expect(settled.upcoming.byCurrency).toEqual([]);
    expect(settled.kpi.byCurrency[0]).toMatchObject({ debt: '0.00', planned: '700.00' }); // план есть, долга нет
  });

  it('горизонт предстоящих платежей ограничивает выборку', async () => {
    const d = await dash(`supplierId=${S}&horizon=1`);
    expect(d.upcoming.byCurrency).toEqual([]);
  });

  it('переплаты отдельным блоком', async () => {
    const d = await dash(`supplierId=${S}`);
    expect(d.overpaid.byCurrency).toEqual([{ currency: 'EUR', contracts: 1, amount: '100.00' }]);
    expect(d.overpaid.totalUsd).toBe('111.46');
    expect(d.overpaid.items[0].number).toBeTruthy();
  });

  it('данные для графиков: поставщики, помесячный план/факт по периоду, динамика из снимков', async () => {
    const d = await dash(`supplierId=${S}&from=${nextYear}-01-01&to=${nextYear}-03-31`);
    expect(d.charts.suppliers).toHaveLength(1);
    expect(d.charts.suppliers[0]).toMatchObject({ id: S, usd: { debt: '9000.00' } });
    expect(d.charts.suppliers[0].byCurrency.USD).toEqual({ amount: '10000.00', paid: '2000.00', debt: '8000.00' });
    expect(d.charts.months).toHaveLength(3);
    expect(d.charts.months[0]).toMatchObject({ year: nextYear, month: 1, byCurrency: { USD: { planned: '2500.00', actual: '0.00' } }, usd: { planned: '2500.00' } });
    expect(d.period).toEqual({ from: `${nextYear}-01-01`, to: `${nextYear}-03-31` });
    expect(d.charts.dynamics.length).toBeGreaterThanOrEqual(1);
    expect(d.charts.dynamics.at(-1).date).toBe(today);
  });

  it('снимки: один на дату и валюту, неизменяемы; эквивалент фиксируется по курсам на дату снимка', async () => {
    await dash(`supplierId=${S}`); await dash(`supplierId=${S}`);
    const snaps = await prisma.debtSnapshot.findMany({ where: { date: new Date(today) } });
    const curs = snaps.map((s) => s.currency);
    expect(new Set(curs).size).toBe(curs.length);
    const usd = snaps.find((s) => s.currency === 'USD')!;
    expect(usd.rate ?? usd.rateUsed).toBeTruthy();
    const before = usd.debtUsd?.toString();
    await rate('USD', '99999', today); // новый курс на ту же дату не меняет уже сделанный снимок
    await prisma.debtSnapshot.findMany({});
    expect((await prisma.debtSnapshot.findFirstOrThrow({ where: { date: new Date(today), currency: 'USD' } })).debtUsd?.toString()).toBe(before);
    await prisma.fxRate.deleteMany({ where: { uzsPerUnit: '99999' } });
  });

  it('фильтры пересчитывают показатели: валюта, проект, исполнитель, статус', async () => {
    expect((await dash(`supplierId=${S}&currency=UZS`)).kpi).toMatchObject({ contracts: 1, byCurrency: [expect.objectContaining({ currency: 'UZS' })] });
    const prj = await dash(`supplierId=${S}&project=PRJ-A`);
    expect(prj.kpi.contracts).toBe(2);
    expect(prj.kpi.byCurrency.map((x: any) => x.currency).sort()).toEqual(['EUR', 'USD']);
    expect((await dash(`supplierId=${S}&executor=петров`)).kpi.contracts).toBe(1); // без учёта регистра
    expect((await dash(`supplierId=${S}&status=ARCHIVED`)).kpi.contracts).toBe(0);
    expect((await viewer.agent.get('/api/dashboard?currency=XXX')).status).toBe(400);
    expect((await viewer.agent.get('/api/dashboard?horizon=0')).status).toBe(400);
  });

  it('доступ только после входа', async () => {
    expect((await request(app.getHttpServer()).get('/api/dashboard')).status).toBe(401);
    expect((await request(app.getHttpServer()).get('/api/reports')).status).toBe(401);
  });

  it('полный портфель считается без ошибок', async () => {
    const d = await dash('');
    expect(d.kpi.contracts).toBeGreaterThan(3);
    expect(d.notes.length).toBeGreaterThan(2);
  });
});

describe('M6: отчёты', () => {
  it('каталог: 11 отчётов', async () => {
    const c = (await viewer.agent.get('/api/reports')).body;
    expect(c.map((x: any) => x.id).sort()).toEqual(['currency-analytics', 'debt-by-contract', 'debt-by-executor', 'debt-by-project', 'debt-by-supplier', 'overdue', 'overpayments', 'payments', 'plan', 'plan-vs-fact', 'total-debt'].sort());
    expect((await viewer.agent.get('/api/reports/nope')).status).toBe(400);
  });

  it('общая задолженность: по валютам + итог в USD-эквиваленте', async () => {
    const r = await report('total-debt', `supplierId=${S}`);
    expect(r.rows.map((x: any) => [x.currency, x.debt])).toEqual([['USD', '8000.00'], ['UZS', '12085000.00'], ['EUR', '0.00']]);
    expect(r.rows[1]).toMatchObject({ usd: '1000.00', rateDate: today });
    expect(r.totals.map((t: any) => t.label)).toEqual(['ИТОГО USD', 'ИТОГО UZS', 'ИТОГО EUR', 'ИТОГО в USD-эквиваленте']);
    expect(r.totals.at(-1).usd).toBe('9000.00');
    expect(r.rates.used.map((u: any) => u.currency).sort()).toEqual(expect.arrayContaining(['EUR', 'USD']));
  });

  it('долги по поставщикам: по умолчанию только строки с долгом; onlyDebt=false — все', async () => {
    const r = await report('debt-by-supplier', `supplierId=${S}`);
    expect(r.rows.map((x: any) => x.currency)).toEqual(['USD', 'UZS']);
    expect(r.warnings.join(' ')).toMatch(/только строки с долгом/);
    expect((await report('debt-by-supplier', `supplierId=${S}&onlyDebt=false`)).rows).toHaveLength(3);
  });

  it('долги по договорам: сумма, оплачено, долг, эквивалент, курс и его дата', async () => {
    const r = await report('debt-by-contract', `supplierId=${S}`);
    expect(r.rows).toHaveLength(2);
    const a = r.rows.find((x: any) => x.currency === 'USD');
    expect(a).toMatchObject({ amount: '10000.00', paid: '2000.00', debt: '8000.00', usd: '8000.00', rate: '1' });
    const b = r.rows.find((x: any) => x.currency === 'UZS');
    expect(b).toMatchObject({ usd: '1000.00', rateDate: today });
    expect(Number(b.rate)).toBeCloseTo(1 / 12085, 8);
  });

  it('курс на дату: исторический отчёт не меняется при появлении более позднего курса', async () => {
    const at = async (d: string) => (await report('debt-by-contract', `supplierId=${S4}&asOf=${d}`)).rows[0];
    expect(await at('2019-03-01')).toMatchObject({ usd: '1000.00', rateDate: '2019-01-01' }); // 12 000 000 / 12 000
    expect((await at('2019-07-01')).usd).toBe('500.00');                                        // курс 24 000 с 2019-06-01
    await rate('USD', '30000', '2019-09-01');                                                   // новый курс «задним» числом не трогает прошлое
    expect((await at('2019-03-01')).usd).toBe('1000.00');
    expect((await at('2019-07-01')).usd).toBe('500.00');
    expect((await at('2019-10-01')).usd).toBe('400.00');
    const before = (await report('debt-by-contract', `supplierId=${S4}&asOf=2018-01-01`));      // до первого курса — пересчёта нет
    expect(before.rows[0].usd).toBeNull();
    expect(before.warnings[0]).toMatch(/Нет подтверждённого курса/);
    expect(before.totals.at(-1)?.label).not.toBe('ИТОГО в USD-эквиваленте');
  });

  it('фактические оплаты: курс на дату каждого платежа; итоги по валюте и в USD', async () => {
    const r = await report('payments', `supplierId=${S5}&from=2019-01-01&to=2019-12-31`);
    expect(r.rows.map((x: any) => [x.date, x.signed, x.usd, x.rateDate])).toEqual([['2019-02-10', '12000000.00', '1000.00', '2019-01-01'], ['2019-07-10', '24000000.00', '1000.00', '2019-06-01']]);
    expect(r.totals[0]).toMatchObject({ supplier: 'ИТОГО UZS', signed: '36000000.00' });
    expect(r.totals.at(-1).usd).toBe('2000.00');
    expect((await report('payments', `supplierId=${S5}&from=2019-03-01&to=2019-12-31`)).rows).toHaveLength(1);
    expect((await report('payments', `supplierId=${S5}&from=2018-01-01&to=2018-12-31`)).rows).toHaveLength(0);
  });

  it('план платежей за период', async () => {
    const r = await report('plan', `supplierId=${S}&from=${nextYear}-01-01&to=${nextYear}-12-31`);
    expect(r.rows).toEqual([expect.objectContaining({ period: `${nextYear}-01`, week: 'W1', currency: 'USD', amount: '2500.00', usd: '2500.00', source: 'вручную' })]);
    expect(r.warnings.join(' ')).toMatch(/не уменьшает долг/);
  });

  it('план против факта: остаток плана и просрочка', async () => {
    const r = await report('plan-vs-fact', `supplierId=${S}&from=2025-03-01&to=2025-03-31`);
    expect(r.rows).toEqual([expect.objectContaining({ period: '2025-03', currency: 'USD', planned: '3000.00', actual: '0.00', remaining: '3000.00', over: '0.00', overdue: '3000.00' })]);
    expect(r.totals.at(-1)).toMatchObject({ planned: '3000.00', overdue: '3000.00' });
  });

  it('просроченные платежи: не больше долга; у оплаченного договора нет', async () => {
    const r = await report('overdue', `supplierId=${S}`);
    expect(r.rows).toEqual([expect.objectContaining({ currency: 'USD', debt: '8000.00', overdue: '3000.00', since: '2025-03 W1', usd: '3000.00' })]);
    expect((await report('overdue', `supplierId=${S2}`)).rows).toEqual([]);
  });

  it('переплаты', async () => {
    const r = await report('overpayments', `supplierId=${S}`);
    expect(r.rows).toEqual([expect.objectContaining({ currency: 'EUR', amount: '1000.00', paid: '1100.00', overpaid: '100.00', usd: '111.46' })]);
  });

  it('долги по проектам и исполнителям (написания исполнителей не склеиваются молча)', async () => {
    const p = await report('debt-by-project', `supplierId=${S}`);
    expect(p.rows.map((x: any) => [x.name, x.currency, x.debt])).toEqual([['PRJ-A', 'USD', '8000.00'], ['PRJ-B', 'UZS', '12085000.00']]);
    const e = await report('debt-by-executor', `supplierId=${S}`);
    expect(e.rows.map((x: any) => x.name)).toEqual(['Иванов', 'Иванов.']);
    expect(e.warnings.join(' ')).toMatch(/Миракмал/);
  });

  it('валютная аналитика: доля в долге по USD-эквиваленту', async () => {
    const r = await report('currency-analytics', `supplierId=${S}`);
    expect(r.rows.map((x: any) => [x.currency, x.usdDebt, x.share])).toEqual([['USD', '8000.00', 88.9], ['UZS', '1000.00', 11.1], ['EUR', '0.00', 0]]);
    expect(r.totals[0]).toMatchObject({ usdDebt: '9000.00' });
  });

  it('валидация параметров', async () => {
    expect((await viewer.agent.get('/api/reports/total-debt?asOf=вчера')).status).toBe(400);
    expect((await viewer.agent.get('/api/reports/total-debt?currency=GBP')).status).toBe(400);
    expect((await viewer.agent.get('/api/reports/total-debt/export?format=docx')).status).toBe(400);
  });
});

describe('M6: экспорт отчётов', () => {
  it('Excel: шапка, форматы чисел, автофильтр, закреплённый заголовок, итоги жирным, суммы — числами', async () => {
    const r = await exp('debt-by-contract', `supplierId=${S}&format=xlsx`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/spreadsheetml/);
    expect(String(r.headers['content-disposition'])).toMatch(/attachment/);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(r.body);
    const ws = wb.worksheets[0];
    expect(String(ws.getCell('A1').value)).toBe('Долги по договорам');
    let h = 0; ws.eachRow((row, n) => { if (!h && row.getCell(1).value === 'Контрагент') h = n; });
    expect(h).toBeGreaterThan(1);
    expect(ws.getRow(h).getCell(1).font?.bold).toBe(true);
    expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: h });
    expect(ws.autoFilter).toBeTruthy();
    const debtCol = ws.getRow(h).values as any[]; const ci = debtCol.indexOf('Долг');
    const first = ws.getRow(h + 1).getCell(ci);
    expect(typeof first.value).toBe('number'); expect(first.numFmt).toBe('#,##0.00');
    let totalRow = 0; ws.eachRow((row, n) => { if (String(row.getCell(1).value).startsWith('ИТОГО в USD')) totalRow = n; });
    expect(totalRow).toBeGreaterThan(h);
    expect(ws.getRow(totalRow).getCell(1).font?.bold).toBe(true);
    expect(await prisma.auditLog.count({ where: { action: 'export.report', entityId: 'debt-by-contract' } })).toBeGreaterThan(0);
  });

  it('CSV: BOM, разделитель «;», экранирование кавычек и разделителей, итоги', async () => {
    const r = await exp('debt-by-contract', `supplierId=${S}&format=csv`);
    expect(r.status).toBe(200);
    const text = r.body.toString('utf8');
    expect(text.charCodeAt(0)).toBe(0xfeff);
    const lines = text.slice(1).trim().split('\r\n');
    expect(lines[0]).toBe('Контрагент;Договор;Проект;Исполнитель;Валюта;Сумма;Оплачено;Долг;Переплата;Долг в USD;Курс, USD за 1 ед.;Дата курса');
    expect(text).toContain('"A ""оригинал""; доп."');
    expect(lines.some((l) => l.startsWith('ИТОГО в USD-эквиваленте'))).toBe(true);
    expect(lines.find((l) => l.includes('8000.00'))).toMatch(/;10000\.00;2000\.00;8000\.00;/);
  });

  it('PDF: валидный документ с кириллическим шрифтом; длинный отчёт занимает несколько страниц', async () => {
    const S6 = await supplier();
    await prisma.contract.createMany({ data: Array.from({ length: 140 }, (_, i) => ({ supplierId: S6, number: `PDF-${i}`, amount: '100', currency: 'USD' as const, openingPaid: '0', identityKey: `pdf:${randomUUID()}` })) });
    const r = await exp('debt-by-contract', `supplierId=${S6}&format=pdf`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('application/pdf');
    const buf: Buffer = r.body;
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
    const raw = buf.toString('latin1');
    expect(raw).toMatch(/DejaVuSans/);
    expect((raw.match(/\/Type \/Page\b/g) ?? []).length).toBeGreaterThanOrEqual(3);
    const small = await exp('total-debt', `supplierId=${S}&format=pdf`);
    expect(small.body.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('экспорт пустого отчёта не падает во всех форматах', async () => {
    const empty = await supplier();
    for (const f of ['xlsx', 'csv', 'pdf']) expect((await exp('overdue', `supplierId=${empty}&format=${f}`)).status).toBe(200);
  });

  it('все 11 отчётов строятся и экспортируются', async () => {
    const ids = (await viewer.agent.get('/api/reports')).body.map((x: any) => x.id);
    for (const id of ids) {
      expect((await viewer.agent.get(`/api/reports/${id}?supplierId=${S}`)).status, id).toBe(200);
      expect((await exp(id, `supplierId=${S}&format=xlsx`)).status, id).toBe(200);
    }
  });
});
