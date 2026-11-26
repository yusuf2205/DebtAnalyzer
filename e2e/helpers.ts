import { expect, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test';
import ExcelJS from 'exceljs';

export const API = 'http://localhost:4100/api';
export const PW = 'E2eUserPassw0rd!1';
export const USERS = {
  admin: { email: 'e2e-admin@example.test', password: 'E2eAdminPassw0rd!1', role: 'SUPER_ADMIN' },
  manager: { email: 'e2e-mgr@example.test', password: PW, role: 'MANAGER' },
  finance: { email: 'e2e-fin@example.test', password: PW, role: 'FINANCE' },
  viewer: { email: 'e2e-view@example.test', password: PW, role: 'VIEWER' },
} as const;
export type Who = keyof typeof USERS;

/** Вход через интерфейс в отдельном контексте браузера (у каждой роли — своя сессия). */
export async function loginAs(browser: Browser, who: Who): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ baseURL: 'http://localhost:3100', locale: 'ru-RU', acceptDownloads: true });
  const page = await ctx.newPage();
  await page.goto('/login');
  await page.getByLabel('Email').fill(USERS[who].email);
  await page.getByLabel('Пароль').fill(USERS[who].password);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).toHaveURL(/\/dashboard/);
  return { ctx, page };
}

/** Запросы к API с теми же cookie, что у страницы, и CSRF-токеном сессии (для проверок состояния независимо от вёрстки). */
export async function api(page: Page) {
  const me = await (await page.request.get('/api/auth/me')).json();
  const csrf = me.user.csrfToken as string;
  const r: APIRequestContext = page.request;
  return {
    get: async (u: string) => (await r.get(`/api${u}`)).json(),
    post: async (u: string, data: unknown = {}) => r.post(`/api${u}`, { data, headers: { 'x-csrf-token': csrf } }),
    status: async (u: string) => (await r.get(`/api${u}`)).status(),
  };
}

export type RegistryRow = { supplier: string; number: string; amount: number; paid: number; currency: string | null; plan?: [number, number] };

/** Реестр в формате реального файла: заголовок в строке 5, недели W1/W2 июня над ним. */
export async function registryXlsx(rows: RegistryRow[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Реестр договоров');
  ws.getCell('K3').value = 'Июнь'; ws.getCell('L3').value = 'Июнь'; ws.getCell('K4').value = 'W1'; ws.getCell('L4').value = 'W2';
  ['', '№', 'Проект', 'Номер контракта', 'Наименование контрагента', 'Наименования товара', 'Сумма контракта', 'Оплачено', 'Остаток суммы (ДОЛГ)', 'Валюта'].forEach((h, i) => h && (ws.getCell(5, i + 1).value = h));
  rows.forEach((r, i) => {
    const n = 6 + i;
    ws.getCell(n, 2).value = i + 1; ws.getCell(n, 3).value = 'E2E проект'; ws.getCell(n, 4).value = r.number; ws.getCell(n, 5).value = r.supplier; ws.getCell(n, 6).value = 'Кабель';
    ws.getCell(n, 7).value = r.amount; ws.getCell(n, 8).value = r.paid; if (r.amount - r.paid) ws.getCell(n, 9).value = r.amount - r.paid;
    if (r.currency) ws.getCell(n, 10).value = r.currency;
    if (r.plan) { ws.getCell(n, 11).value = r.plan[0]; ws.getCell(n, 12).value = r.plan[1]; }
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export const money = (v: string | number) => Number(v).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
