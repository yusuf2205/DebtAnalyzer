import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaClient } from '@prisma/client';
import ExcelJS from 'exceljs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { GoogleSyncService } from '../src/google/google-sync.service';

const PUB = 'PUBLICSHEETID1234567890';
const PRIV = 'PRIVATESHEETID123456789';
const url = (id: string) => `https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`;
const PW = 'StrongPassw0rd!x';

// ---- Имитация Google ----
const mock = { publicXlsx: Buffer.alloc(0), privateRows: [] as any[][], apiStatus: 200, tokenCalls: [] as string[], apiAuth: [] as string[] };
let server: Server;

const s = (v: string) => ({ effectiveValue: { stringValue: v } });
const n = (v: number) => ({ effectiveValue: { numberValue: v } });
const hdr = ['', 'Проект', 'Номер контракта', 'Наименование контрагента', 'Наименования товара', 'Сумма контракта', 'Оплачено', 'Остаток суммы (ДОЛГ)', 'Валюта'];
function apiJson(rows: any[][]) {
  const header = [{}, s('№'), ...hdr.slice(1).map(s)];
  return { properties: { title: 'Реестр (private)' }, sheets: [{ properties: { sheetId: 1, title: 'Реестр договоров' }, data: [{ startRow: 0, startColumn: 0, rowData: [{ values: [] }, { values: [] }, { values: [] }, { values: [] }, { values: header }, ...rows.map((r) => ({ values: r })) ] }] }] };
}
const apiRow = (sup: string, no: string, amount: number, paid: number, cur: string) => [{}, n(1), s('P'), s(no), s(sup), s('Кабель'), n(amount), n(paid), amount - paid ? n(amount - paid) : {}, s(cur)];

async function xlsx(rows: [string, string, number, number, string][], tweak?: (wb: ExcelJS.Workbook) => void): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Реестр договоров');
  ['', '№', 'Проект', 'Номер контракта', 'Наименование контрагента', 'Наименования товара', 'Сумма контракта', 'Оплачено', 'Остаток суммы (ДОЛГ)', 'Валюта'].forEach((h, i) => h && (ws.getCell(5, i + 1).value = h));
  rows.forEach(([sup, no, amount, paid, cur], i) => {
    const r = 6 + i;
    ws.getCell(r, 2).value = i + 1; ws.getCell(r, 3).value = 'P'; ws.getCell(r, 4).value = no; ws.getCell(r, 5).value = sup; ws.getCell(r, 6).value = 'Кабель';
    ws.getCell(r, 7).value = amount; ws.getCell(r, 8).value = paid; if (amount - paid) ws.getCell(r, 9).value = amount - paid; ws.getCell(r, 10).value = cur;
  });
  tweak?.(wb);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

let app: NestExpressApplication, prisma: PrismaClient;
type S = { agent: ReturnType<typeof request.agent>; csrf: string };
async function login(email: string, password: string): Promise<S & { status: number }> {
  const agent = request.agent(app.getHttpServer());
  const r = await agent.post('/api/auth/login').send({ email, password });
  return { agent, csrf: r.body?.user?.csrfToken, status: r.status };
}
const post = (x: S, u: string) => x.agent.post(u).set('x-csrf-token', x.csrf);
const patch = (x: S, u: string) => x.agent.patch(u).set('x-csrf-token', x.csrf);
async function user(admin: S, email: string, role: string) {
  await post(admin, '/api/users').send({ email, name: email, role, password: PW });
  const a = await login(email, PW); await post(a, '/api/auth/change-password').send({ current: PW, next: PW + '2' });
  return login(email, PW + '2');
}

let admin: S, fin: S, mgr: S, viewer: S;
let sourceId: string, batch1: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const u = new URL(req.url!, 'http://x');
    if (u.pathname === `/spreadsheets/d/${PUB}/export`) { res.writeHead(200, { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }); return void res.end(mock.publicXlsx); }
    if (u.pathname === `/spreadsheets/d/${PRIV}/export`) { res.writeHead(200, { 'content-type': 'text/html' }); return void res.end('<html>Sign in</html>'); }
    if (u.pathname === '/token' && req.method === 'POST') {
      let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => {
        const p = new URLSearchParams(body); mock.tokenCalls.push(p.get('grant_type')!);
        const idt = 'x.' + Buffer.from(JSON.stringify({ email: 'owner@gmail.test' })).toString('base64url') + '.y';
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(p.get('grant_type') === 'refresh_token' ? { access_token: 'AT-REFRESHED' } : { access_token: 'AT', refresh_token: 'RT-SECRET-123', id_token: idt, scope: 'openid email https://www.googleapis.com/auth/spreadsheets.readonly' }));
      }); return;
    }
    if (u.pathname === `/v4/spreadsheets/${PRIV}`) {
      mock.apiAuth.push(String(req.headers.authorization));
      if (mock.apiStatus !== 200) { res.writeHead(mock.apiStatus); return void res.end('{}'); }
      res.writeHead(200, { 'content-type': 'application/json' }); return void res.end(JSON.stringify(apiJson(mock.privateRows)));
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  Object.assign(process.env, {
    GOOGLE_DOCS_BASE: base, GOOGLE_API_BASE: base, GOOGLE_TOKEN_URL: `${base}/token`, GOOGLE_AUTH_URL: `${base}/auth`,
    GOOGLE_CLIENT_ID: 'client-id.apps.test', GOOGLE_CLIENT_SECRET: 'client-secret', GOOGLE_REDIRECT_URI: 'http://localhost:3000/api/google/oauth/callback',
    TOKEN_ENCRYPTION_KEY: 'unit-test-encryption-key-0123456789abcdef',
  });
  app = await createApp({ logger: false }); await app.init(); prisma = new PrismaClient();
  let r = await login('root@example.test', 'InitialPassw0rd!');
  if (r.status === 200) await post(r, '/api/auth/change-password').send({ current: 'InitialPassw0rd!', next: PW });
  admin = await login('root@example.test', PW);
  fin = await user(admin, 'gfin@example.test', 'FINANCE'); mgr = await user(admin, 'gmgr@example.test', 'MANAGER'); viewer = await user(admin, 'gview@example.test', 'VIEWER');
  mock.publicXlsx = await xlsx([['GS-ALPHA LLC', 'Д-1 от 01.02.2026', 1000, 400, 'USD'], ['GS-BETA LLC', 'Д-2 от 02.02.2026', 5000, 0, 'UZS']]);
});
afterAll(async () => { await prisma.$disconnect(); await app.close(); await new Promise((r) => server.close(r)); });

const gsContracts = () => prisma.contract.count({ where: { supplier: { name: { startsWith: 'GS-' } } } });

describe('Google Sheets: ссылка и доступ', () => {
  it('принимает только ссылки docs.google.com (защита от SSRF)', async () => {
    for (const bad of ['http://localhost:4000/x', 'https://evil.example/spreadsheets/d/PUBLICSHEETID1234567890', 'https://docs.google.com.evil.example/spreadsheets/d/PUBLICSHEETID1234567890', 'просто текст', 'https://docs.google.com/document/d/PUBLICSHEETID1234567890']) {
      expect((await post(admin, '/api/google/sources/inspect').send({ url: bad })).status, bad).toBe(422);
    }
  });

  it('права: настройка — только администраторы; просмотр и синхронизация — по ролям', async () => {
    expect((await post(mgr, '/api/google/sources/inspect').send({ url: url(PUB) })).status).toBe(403);
    expect((await post(fin, '/api/google/oauth/disconnect')).status).toBe(403);
    expect((await viewer.agent.get('/api/google/sources')).status).toBe(200);
  });

  it('публичная таблица: проверка доступа, листы и предложенный лист — без ключей Google', async () => {
    const r = await post(admin, '/api/google/sources/inspect').send({ url: url(PUB) });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ spreadsheetId: PUB, mode: 'PUBLIC', suggestedSheet: 'Реестр договоров' });
    expect(r.body.sheets[0]).toMatchObject({ name: 'Реестр договоров', layoutDetected: true });
  });

  it('закрытая таблица без подключённого аккаунта: понятная ошибка', async () => {
    const r = await post(admin, '/api/google/sources/inspect').send({ url: url(PRIV) });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('GOOGLE_ACCESS_REQUIRED');
    expect(r.body.message).toMatch(/закрыта/);
  });
});

describe('Google Sheets: подключение источника и синхронизация (публичная таблица)', () => {
  it('создание источника сразу выполняет первую синхронизацию и даёт предпросмотр, но НЕ пишет договоры', async () => {
    const r = await post(admin, '/api/google/sources').send({ url: url(PUB), sheetName: 'Реестр договоров', planYear: 2026, autoSync: true, intervalMinutes: 60 });
    expect(r.status).toBe(201);
    sourceId = r.body.source.id; batch1 = r.body.sync.batchId;
    expect(r.body.sync.status).toBe('CHANGES');
    expect(r.body.source).toMatchObject({ mode: 'PUBLIC', lastStatus: 'CHANGES', autoSync: true });
    expect(r.body.source.nextSyncAt).toBeTruthy();
    expect(r.body.sync.changes).toMatchObject({ added: 2, importable: 2 });
    expect(await gsContracts()).toBe(0);
    const b = (await fin.agent.get(`/api/imports/${batch1}`)).body;
    expect(b).toMatchObject({ status: 'ANALYZED', planYear: 2026, sheetName: 'Реестр договоров' });
    expect(b.extras.sync.added).toBe(2);
  });

  it('подтверждение (как у обычного импорта) создаёт договоры; «Оплачено» — начальный остаток', async () => {
    expect((await post(fin, `/api/imports/${batch1}/commit`).send({ confirm: true })).status).toBe(201);
    expect(await gsContracts()).toBe(2);
    const c = await prisma.contract.findFirstOrThrow({ where: { number: { contains: 'Д-1' }, supplier: { name: { startsWith: 'GS-' } } } });
    expect(c.openingPaid.toFixed(2)).toBe('400.00');
  });

  it('повторная синхронизация того же файла — «без изменений», новых черновиков нет', async () => {
    const r = await post(fin, `/api/google/sources/${sourceId}/sync`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'UNCHANGED', batchId: null });
    expect(await prisma.importBatch.count({ where: { sourceId } })).toBe(1);
  });

  it('файл изменился, а данные нет (метаданные/форматирование) — тоже «без изменений», черновик не остаётся', async () => {
    mock.publicXlsx = await xlsx([['GS-ALPHA LLC', 'Д-1 от 01.02.2026', 1000, 400, 'USD'], ['GS-BETA LLC', 'Д-2 от 02.02.2026', 5000, 0, 'UZS']], (wb) => { wb.addWorksheet('Пустой лист').state = 'hidden'; });
    const r = await post(fin, `/api/google/sources/${sourceId}/sync`);
    expect(r.body.status).toBe('UNCHANGED');
    expect(await prisma.importBatch.count({ where: { sourceId } })).toBe(1);
  });

  it('изменения в таблице: «Оплачено» ↑, новая строка — показаны до применения; существующие договоры не перезаписываются', async () => {
    mock.publicXlsx = await xlsx([
      ['GS-ALPHA LLC', 'Д-1 от 01.02.2026', 1000, 900, 'USD'], ['GS-BETA LLC', 'Д-2 от 02.02.2026', 5000, 0, 'UZS'], ['GS-GAMMA LLC', 'Д-3 от 03.02.2026', 77, 0, 'EUR'],
    ]);
    const r = await post(fin, `/api/google/sources/${sourceId}/sync`);
    expect(r.body.status).toBe('CHANGES');
    expect(r.body.changes).toMatchObject({ added: 1, changed: 1, paidChanged: 1, removed: 0, unchanged: 1 });
    expect(r.body.changes.samples[0].fields).toEqual([{ field: 'openingPaid', from: '400.00', to: '900.00' }]);
    expect(await gsContracts()).toBe(2); // ничего не применено без подтверждения
    const c = await prisma.contract.findFirstOrThrow({ where: { number: { contains: 'Д-1' }, supplier: { name: { startsWith: 'GS-' } } } });
    expect(c.openingPaid.toFixed(2)).toBe('400.00');
    // подтверждение: новый договор создаётся, изменение «Оплачено» уходит в сверку
    const commit = await post(fin, `/api/imports/${r.body.batchId}/commit`).send({ confirm: true });
    expect(commit.body).toMatchObject({ contractsCreated: 1, contractsChangedInSource: 1, reconciliationTasks: 1 });
    expect((await prisma.contract.findUniqueOrThrow({ where: { id: c.id } })).openingPaid.toFixed(2)).toBe('400.00');
  });

  it('новый черновик заменяет прежний неподтверждённый', async () => {
    mock.publicXlsx = await xlsx([['GS-ALPHA LLC', 'Д-1 от 01.02.2026', 1000, 900, 'USD'], ['GS-BETA LLC', 'Д-2 от 02.02.2026', 5000, 0, 'UZS'], ['GS-GAMMA LLC', 'Д-3 от 03.02.2026', 77, 0, 'EUR'], ['GS-DELTA LLC', 'Д-4', 10, 0, 'USD']]);
    const a = await post(fin, `/api/google/sources/${sourceId}/sync`);
    mock.publicXlsx = await xlsx([['GS-ALPHA LLC', 'Д-1 от 01.02.2026', 1000, 900, 'USD'], ['GS-BETA LLC', 'Д-2 от 02.02.2026', 5000, 0, 'UZS'], ['GS-GAMMA LLC', 'Д-3 от 03.02.2026', 77, 0, 'EUR'], ['GS-DELTA LLC', 'Д-4', 10, 0, 'USD'], ['GS-EPS LLC', 'Д-5', 11, 0, 'USD']]);
    const b = await post(fin, `/api/google/sources/${sourceId}/sync`);
    expect(await prisma.importBatch.findUnique({ where: { id: a.body.batchId } })).toBeNull();
    expect((await prisma.importBatch.findUniqueOrThrow({ where: { id: b.body.batchId } })).status).toBe('ANALYZED');
    expect(b.body.changes.added).toBe(2);
  });

  it('ошибка источника фиксируется (статус, текст), сервис не падает и восстанавливается', async () => {
    const pub = mock.publicXlsx; mock.publicXlsx = Buffer.from('<html>Sign in to Google</html>');
    const r = await post(fin, `/api/google/sources/${sourceId}/sync`);
    expect(r.status).toBe(422);
    const src = (await viewer.agent.get('/api/google/sources')).body.find((x: any) => x.id === sourceId);
    expect(src).toMatchObject({ lastStatus: 'ERROR', syncing: false });
    expect(src.lastError).toMatch(/доступ|таблиц/i);
    mock.publicXlsx = pub;
    expect((await post(fin, `/api/google/sources/${sourceId}/sync`)).status).toBe(200);
  });

  it('автосинхронизация: просроченные источники обрабатывает runDue; параллельный запуск блокируется', async () => {
    await prisma.googleSource.update({ where: { id: sourceId }, data: { nextSyncAt: new Date(Date.now() - 1000), lastSha: null } });
    const res = await app.get(GoogleSyncService).runDue();
    expect(res).toMatchObject({ ran: 1, failed: 0 });
    const after = await prisma.googleSource.findUniqueOrThrow({ where: { id: sourceId } });
    expect(after.nextSyncAt!.getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);
    await prisma.googleSource.update({ where: { id: sourceId }, data: { syncStartedAt: new Date() } });
    expect((await post(fin, `/api/google/sources/${sourceId}/sync`)).status).toBe(409);
    await prisma.googleSource.update({ where: { id: sourceId }, data: { syncStartedAt: null } });
  });

  it('права на синхронизацию и настройку источника', async () => {
    expect((await post(viewer, `/api/google/sources/${sourceId}/sync`)).status).toBe(403);
    expect((await patch(fin, `/api/google/sources/${sourceId}`).send({ autoSync: false })).status).toBe(403);
    expect((await patch(admin, `/api/google/sources/${sourceId}`).send({ intervalMinutes: 5 })).status).toBe(400);
    const off = await patch(admin, `/api/google/sources/${sourceId}`).send({ autoSync: false });
    expect(off.body).toMatchObject({ autoSync: false, nextSyncAt: null });
  });
});

describe('Google Sheets: закрытая таблица через OAuth', () => {
  it('статус: OAuth настроен, аккаунт не подключён; start отдаёт адрес Google с нужными правами и state', async () => {
    expect((await admin.agent.get('/api/google/status')).body).toMatchObject({ oauthConfigured: true, connection: null });
    const r = await admin.agent.get('/api/google/oauth/start');
    const u = new URL(r.body.url);
    expect(u.searchParams.get('client_id')).toBe('client-id.apps.test');
    expect(u.searchParams.get('scope')).toContain('spreadsheets.readonly');
    expect(u.searchParams.get('scope')).not.toMatch(/drive/);
    expect(u.searchParams.get('access_type')).toBe('offline');
    expect(String(r.headers['set-cookie'])).toMatch(/pf_oauth_state=.*HttpOnly/i);
    (globalThis as any).__state = u.searchParams.get('state');
  });

  it('callback с чужим state отклоняется; с верным — токен сохраняется ЗАШИФРОВАННЫМ', async () => {
    const bad = await admin.agent.get('/api/google/oauth/callback?code=abc&state=forged');
    expect(bad.status).toBe(302); expect(bad.headers.location).toMatch(/error=/);
    expect(await prisma.googleCredential.count()).toBe(0);
    const start = await admin.agent.get('/api/google/oauth/start');
    const state = new URL(start.body.url).searchParams.get('state')!;
    const ok = await admin.agent.get(`/api/google/oauth/callback?code=abc&state=${state}`);
    expect(ok.headers.location).toBe('/google?connected=1');
    const cred = await prisma.googleCredential.findFirstOrThrow();
    expect(cred.email).toBe('owner@gmail.test');
    expect(cred.refreshTokenEnc).not.toContain('RT-SECRET-123');
    expect(Buffer.from(cred.refreshTokenEnc, 'base64').toString('latin1')).not.toContain('RT-SECRET');
    expect((await admin.agent.get('/api/google/status')).body.connection.email).toBe('owner@gmail.test');
  });

  it('закрытая таблица читается через Sheets API; тот же движок проверок; токены не попадают в ответы', async () => {
    mock.privateRows = [apiRow('GS-PRIV LLC', 'П-1 от 05.03.2026', 3000, 1000, 'USD'), apiRow('GS-PRIV2 LLC', 'П-2', 50, 0, '')];
    const insp = await post(admin, '/api/google/sources/inspect').send({ url: url(PRIV) });
    expect(insp.body).toMatchObject({ mode: 'OAUTH', title: 'Реестр (private)', suggestedSheet: 'Реестр договоров' });
    const r = await post(admin, '/api/google/sources').send({ url: url(PRIV), sheetName: 'Реестр договоров', planYear: 2026, autoSync: false, intervalMinutes: 60 });
    expect(r.status).toBe(201);
    expect(r.body.source.mode).toBe('OAUTH');
    expect(r.body.sync.status).toBe('CHANGES');
    expect(mock.tokenCalls).toContain('refresh_token');
    expect(mock.apiAuth.at(-1)).toBe('Bearer AT-REFRESHED');
    const b = (await fin.agent.get(`/api/imports/${r.body.sync.batchId}`)).body;
    expect(b.summary).toMatchObject({ dataRows: 2, importable: 1, blocked: 1 }); // вторая строка без валюты заблокирована, как и при импорте XLSX
    const rows = (await fin.agent.get(`/api/imports/${r.body.sync.batchId}/rows?status=BLOCKED`)).body.items;
    expect(rows[0].issues.map((i: any) => i.code)).toContain('MISSING_CURRENCY');
    const everything = JSON.stringify([(await viewer.agent.get('/api/google/sources')).body, b, (await admin.agent.get('/api/google/status')).body]);
    expect(everything).not.toMatch(/RT-SECRET|AT-REFRESHED|refreshToken/);
  });

  it('нет доступа у аккаунта (403 от Google) — ошибка источника, не падение', async () => {
    const src = (await viewer.agent.get('/api/google/sources')).body.find((x: any) => x.mode === 'OAUTH');
    mock.apiStatus = 403;
    const r = await post(fin, `/api/google/sources/${src.id}/sync`);
    mock.apiStatus = 200;
    expect(r.status).toBe(422);
    expect(r.body.message).toMatch(/нет доступа/);
  });

  it('отключить аккаунт нельзя, пока есть источники; после удаления источника — можно', async () => {
    expect((await post(admin, '/api/google/oauth/disconnect')).status).toBe(409);
    const list = (await viewer.agent.get('/api/google/sources')).body;
    for (const s of list.filter((x: any) => x.mode === 'OAUTH')) expect((await admin.agent.delete(`/api/google/sources/${s.id}`).set('x-csrf-token', admin.csrf)).status).toBe(200);
    expect((await post(admin, '/api/google/oauth/disconnect')).status).toBe(200);
    expect(await prisma.googleCredential.count()).toBe(0);
  });

  it('действия с Google записаны в аудит', async () => {
    const actions = (await prisma.auditLog.findMany({ where: { entity: { in: ['GoogleSource', 'GoogleCredential'] } }, select: { action: true } })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['google.source_create', 'google.sync', 'google.sync_failed', 'google.connect', 'google.disconnect', 'google.source_delete']));
  });
});
