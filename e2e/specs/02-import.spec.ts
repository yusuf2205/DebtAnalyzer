import { expect, test } from '@playwright/test';
import { api, loginAs, registryXlsx } from '../helpers';

test.describe('Импорт реестра (мастер)', () => {
  test('менеджер загружает файл, видит проблемы, выбирает валюту; сохраняет только финансист', async ({ browser }) => {
    const file = await registryXlsx([
      { supplier: 'E2E-ALPHA LLC', number: 'E2E-001 от 01.02.2026', amount: 10000, paid: 2000, currency: 'USD' },
      { supplier: 'E2E-BETA MCHJ', number: 'E2E-002', amount: 12085000, paid: 0, currency: 'UZS' },
      { supplier: 'E2E-GAMMA LLC', number: 'E2E-003', amount: 500, paid: 0, currency: null }, // нет валюты -> блокируется
    ]);
    const mgr = await loginAs(browser, 'manager');
    const page = mgr.page;
    await page.goto('/imports');
    await page.locator('input[type=file]').setInputFiles({ name: 'registry-e2e.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: file });
    await expect(page).toHaveURL(/\/imports\/[0-9a-f-]{36}/);

    // выбор листа: подходящий предложен автоматически
    await expect(page.getByRole('heading', { name: 'Выберите лист' })).toBeVisible();
    await expect(page.getByRole('radio', { name: /Реестр договоров/ })).toBeChecked();
    await page.getByRole('button', { name: 'Проверить данные' }).click();

    // сводка: строка без валюты заблокирована и названа прямо
    await expect(page.getByText('Строки без валюты: 1')).toBeVisible();
    await expect(page.getByText('Заблокировано').first()).toBeVisible();

    // исправление в предпросмотре: ручной выбор валюты
    await page.getByRole('button', { name: 'Строки', exact: true }).click();
    await page.locator('table select', { hasText: 'выбрать' }).selectOption('USD');
    await page.getByRole('button', { name: 'Сводка' }).click();
    await expect(page.getByText('Строки без валюты')).toHaveCount(0);

    // менеджер сохранить не может — кнопка недоступна, причина названа
    await expect(page.getByRole('button', { name: 'Сохранить в систему' })).toBeDisabled();
    await expect(page.getByText(/Сохранение доступно ролям FINANCE/)).toBeVisible();

    // финансист открывает тот же импорт и подтверждает
    const importUrl = page.url();
    const fin = await loginAs(browser, 'finance');
    await fin.page.goto(importUrl);
    await expect(fin.page.getByRole('heading', { name: 'Подтверждение и сохранение' })).toBeVisible();
    await expect(fin.page.getByRole('button', { name: 'Сохранить в систему' })).toBeDisabled(); // без явного подтверждения нельзя
    await fin.page.getByLabel('Я проверил предпросмотр и проблемы').check();
    await fin.page.getByRole('button', { name: 'Сохранить в систему' }).click();
    await expect(fin.page.getByRole('heading', { name: /Импорт сохранён/ })).toBeVisible();
    await expect(fin.page.getByText('Создано договоров').locator('..').getByText('3', { exact: true })).toBeVisible();

    // данные в системе: «Оплачено» из файла — начальный остаток, долг = сумма − оплачено
    const a = await api(fin.page);
    const c = await a.get('/contracts?q=E2E-001');
    expect(c.items).toHaveLength(1);
    expect(c.items[0]).toMatchObject({ amount: '10000.00', openingPaid: '2000.00', debt: '8000.00', currency: 'USD' });
    expect((await a.get('/contracts?q=E2E-')).total).toBe(3);
    expect((await a.get('/payments?q=E2E')).total).toBe(0); // выдуманных платежей нет
    await mgr.ctx.close(); await fin.ctx.close();
  });

  test('повторное сохранение того же импорта невозможно', async ({ browser }) => {
    const fin = await loginAs(browser, 'finance');
    const a = await api(fin.page);
    const batch = (await a.get('/imports'))[0];
    const again = await a.post(`/imports/${batch.id}/commit`, { confirm: true, planYear: 2026 });
    expect(again.status()).toBe(409);
    await fin.ctx.close();
  });

  test('созданные договоры и контрагенты видны в интерфейсе', async ({ browser }) => {
    const mgr = await loginAs(browser, 'manager');
    await mgr.page.goto('/contracts');
    await mgr.page.getByPlaceholder(/Поиск: номер/).fill('E2E-00');
    await expect(mgr.page.getByRole('link', { name: /E2E-001/ })).toBeVisible();
    await expect(mgr.page.getByRole('link', { name: /E2E-002/ })).toBeVisible();
    await mgr.page.goto('/suppliers');
    await mgr.page.getByPlaceholder(/Поиск: название/).fill('E2E-ALPHA');
    await expect(mgr.page.getByRole('link', { name: 'E2E-ALPHA LLC' })).toBeVisible();
    await mgr.ctx.close();
  });
});
