import { expect, test } from '@playwright/test';
import { api, loginAs } from '../helpers';

const now = new Date();
const Y = now.getFullYear(), M = now.getMonth() + 1;

test.describe('Календарь платежей', () => {
  test('менеджер планирует платёж, переносит на другую неделю; план не меняет долг', async ({ browser }) => {
    const mgr = await loginAs(browser, 'manager');
    const a = await api(mgr.page);
    const c = (await a.get('/contracts?q=E2E-002')).items[0];
    expect(c.debt).toBe('12085000.00');

    await mgr.page.goto('/calendar');
    await mgr.page.getByRole('button', { name: 'Добавить план' }).click();
    const dialog = mgr.page.getByRole('dialog', { name: 'Новый плановый платёж' });
    await dialog.getByPlaceholder(/Договор: номер/).fill('E2E-002');
    await dialog.getByRole('button', { name: /E2E-002/ }).click();
    await dialog.getByLabel('Неделя').selectOption('2');
    await dialog.getByPlaceholder(/^Сумма/).fill('1000000');
    await dialog.getByRole('button', { name: 'Запланировать' }).click();
    await expect(dialog).toHaveCount(0);

    // в сетке месяца: строка договора, план в W2
    const row = mgr.page.getByRole('row', { name: /E2E-002/ });
    await expect(row).toContainText('1 000 000,00');
    let month = await a.get(`/calendar/month?year=${Y}&month=${M}&contractId=${c.id}`);
    expect(month.rows[0].cells.find((x: any) => x.week === 2)).toMatchObject({ planned: '1000000.00', source: 'MANUAL' });

    // перенос W2 → W3
    await row.getByRole('button', { name: 'W2: изменить план' }).click();
    const cell = mgr.page.getByRole('dialog');
    await cell.getByRole('button', { name: 'Перенести' }).first().click();
    await cell.getByLabel('Неделя').selectOption('3');
    await cell.getByRole('button', { name: 'Перенести' }).last().click();
    await expect(cell).toHaveCount(0);
    month = await a.get(`/calendar/month?year=${Y}&month=${M}&contractId=${c.id}`);
    expect(month.rows[0].cells.find((x: any) => x.week === 2).planned).toBeNull();
    expect(month.rows[0].cells.find((x: any) => x.week === 3).planned).toBe('1000000.00');

    // разделение W3 → W3 + W4 поровну
    await mgr.page.getByRole('row', { name: /E2E-002/ }).getByRole('button', { name: 'W3: изменить план' }).click();
    const sp = mgr.page.getByRole('dialog');
    await sp.getByRole('button', { name: 'Разделить', exact: true }).first().click();
    await expect(sp.getByText(/Сумма частей: 1\s000\s000,00 из 1\s000\s000,00/)).toBeVisible();
    await sp.getByRole('button', { name: 'Разделить', exact: true }).last().click();
    await expect(sp).toHaveCount(0);
    month = await a.get(`/calendar/month?year=${Y}&month=${M}&contractId=${c.id}`);
    const planned = month.rows[0].cells.map((x: any) => x.planned);
    expect(planned.filter(Boolean).map(Number).reduce((s: number, v: number) => s + v, 0)).toBe(1000000);

    // план — намерение: долг не изменился
    expect((await a.get(`/contracts/${c.id}`)).debt).toBe('12085000.00');
    await mgr.ctx.close();
  });

  test('наблюдатель видит календарь, но не может менять план', async ({ browser }) => {
    const v = await loginAs(browser, 'viewer');
    await v.page.goto('/calendar');
    await expect(v.page.getByRole('heading', { name: 'Календарь платежей' })).toBeVisible();
    await expect(v.page.getByRole('button', { name: 'Добавить план' })).toHaveCount(0);
    const a = await api(v.page);
    expect((await a.post('/calendar/plans', { contractId: crypto.randomUUID(), year: Y, month: M, week: 1, amount: '1' })).status()).toBe(403);
    await v.ctx.close();
  });
});
