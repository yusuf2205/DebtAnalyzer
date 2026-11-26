import { expect, test } from '@playwright/test';
import { api, loginAs, registryXlsx } from '../helpers';

test.describe('Сверка с источником без двойного учёта', () => {
  test('в таблице «Оплачено» выросло: платёж приложения сопоставляется, долг не меняется', async ({ browser }) => {
    // таблица теперь показывает оплату 3500 (2000 историческая + 1500, которые приложение уже учло платежом)
    const file = await registryXlsx([
      { supplier: 'E2E-ALPHA LLC', number: 'E2E-001 от 01.02.2026', amount: 10000, paid: 3500, currency: 'USD' },
      { supplier: 'E2E-BETA MCHJ', number: 'E2E-002', amount: 12085000, paid: 0, currency: 'UZS' },
      { supplier: 'E2E-GAMMA LLC', number: 'E2E-003', amount: 500, paid: 0, currency: 'USD' },
    ]);
    const mgr = await loginAs(browser, 'manager');
    await mgr.page.goto('/imports');
    await mgr.page.locator('input[type=file]').setInputFiles({ name: 'registry-e2e-v2.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: file });
    await mgr.page.getByRole('button', { name: 'Проверить данные' }).click();
    await expect(mgr.page.getByText('Остаток по ним')).toHaveCount(0);
    const importUrl = mgr.page.url();

    const fin = await loginAs(browser, 'finance');
    const fa = await api(fin.page);
    await fin.page.goto(importUrl);
    await fin.page.getByLabel('Я проверил предпросмотр и проблемы').check();
    await fin.page.getByRole('button', { name: 'Сохранить в систему' }).click();
    await expect(fin.page.getByRole('heading', { name: /Импорт сохранён/ })).toBeVisible();
    await expect(fin.page.getByText('Существующие договоры не перезаписаны')).toBeVisible();

    const id = (await fa.get('/contracts?q=E2E-001')).items[0].id;
    // договор НЕ перезаписан: «Оплачено» из таблицы ждёт решения
    expect(await fa.get(`/contracts/${id}`)).toMatchObject({ openingPaid: '2000.00', debt: '6500.00' });

    await fin.page.goto('/reconciliation');
    const card = fin.page.locator('section', { hasText: 'E2E-001' });
    await expect(card.getByText('В источнике оплачено больше на')).toContainText('1 500,00');
    await expect(card.getByRole('checkbox', { checked: true })).toHaveCount(1); // платёж 1500 найден и отмечен автоматически
    await expect(card.getByText('Найдено точное совпадение')).toBeVisible();
    await expect(card.getByText(/неопознанный остаток/)).toContainText('0,00');
    await card.getByRole('button', { name: 'Подтвердить и применить' }).click();
    await expect(fin.page.getByText('Открытых расхождений нет.')).toBeVisible();

    // итог: начальный остаток = значению источника, платёж помечен «учтён», долг тот же — двойного учёта нет
    expect(await fa.get(`/contracts/${id}`)).toMatchObject({ openingPaid: '3500.00', newPaid: '0.00', debt: '6500.00', paid: '3500.00' });
    const pays = (await fa.get(`/payments?contractId=${id}&status=APPROVED&kind=PAYMENT`)).items;
    expect(pays.some((p: any) => p.amount === '1500.00' && p.reflectedInOpening)).toBe(true);

    // решение видно в «Решённых» и записано в журнале
    await fin.page.getByRole('button', { name: 'Решённые' }).click();
    await expect(fin.page.getByText(/Применено/).first()).toBeVisible();
    const audit = await fa.get('/audit?take=200').catch(() => null);
    expect(audit === null || audit.items.some((x: any) => x.action === 'reconciliation.confirm')).toBe(true);
    await mgr.ctx.close(); await fin.ctx.close();
  });

  test('менеджер видит сверку, но принимать решения не может', async ({ browser }) => {
    const mgr = await loginAs(browser, 'manager');
    await mgr.page.goto('/reconciliation');
    await expect(mgr.page.getByRole('heading', { name: 'Сверка' })).toBeVisible();
    await expect(mgr.page.getByRole('button', { name: 'Подтвердить и применить' })).toHaveCount(0);
    const a = await api(mgr.page);
    const tasks = await a.get('/reconciliation?pageSize=5');
    const any = tasks.items[0];
    expect((await a.post(`/reconciliation/${any.id}/confirm`, {})).status()).toBe(403);
    await mgr.ctx.close();
  });
});
