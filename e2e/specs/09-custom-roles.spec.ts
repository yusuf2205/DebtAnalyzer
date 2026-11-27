import { expect, test } from '@playwright/test';
import { api, loginAs } from '../helpers';

test.describe('Настраиваемые роли', () => {
  test('SUPER_ADMIN создаёт роль галочками, назначает пользователю; права действуют в меню и на сервере; правки — сразу', async ({ browser }) => {
    const roleName = `Бухгалтер E2E ${Date.now() % 100000}`;
    const admin = await loginAs(browser, 'admin');
    const a = await api(admin.page);

    // 1. Создание роли через интерфейс. Выбор «Подтверждение платежей» сам включает «Просмотр платежей» (зависимость).
    await admin.page.goto('/roles');
    await expect(admin.page.getByRole('heading', { name: 'Роли и права', exact: true })).toBeVisible();
    await admin.page.getByLabel('Название').fill(roleName);
    await admin.page.getByLabel('Подтверждение и отклонение платежей').check();
    await expect(admin.page.getByLabel('Просмотр платежей')).toBeChecked();
    await admin.page.getByLabel('Просмотр Dashboard').check();
    await admin.page.getByRole('button', { name: 'Создать роль' }).click();
    await expect(admin.page.getByRole('status')).toContainText('Роль создана');
    const list = await a.get('/roles');
    const role = list.custom.find((r: any) => r.name === roleName);
    expect(role.permissions).toEqual(['dashboard.view', 'payments.view', 'payments.approve']);

    // снятие «Просмотр платежей» убирает и зависимое «Подтверждение»
    await admin.page.getByLabel('Просмотр платежей').uncheck();
    await expect(admin.page.getByLabel('Подтверждение и отклонение платежей')).not.toBeChecked();
    await admin.page.getByLabel('Просмотр платежей').check();

    // 2. Назначение пользователю через интерфейс
    const email = `e2e-role-${Date.now()}@example.test`;
    await admin.page.goto('/users');
    await admin.page.getByPlaceholder('Имя').fill('Роль Тест');
    await admin.page.getByPlaceholder('Email').fill(email);
    await admin.page.getByRole('combobox').last().selectOption({ label: roleName });
    await admin.page.getByPlaceholder(/Временный пароль/).fill('temp');
    await admin.page.getByRole('button', { name: 'Создать' }).click();
    await expect(admin.page.getByRole('row', { name: new RegExp(email) })).toContainText('своя роль');

    // 3. Вход под пользователем: в меню только разрешённое, остальное закрыто сервером
    const ctx = await browser.newContext({ baseURL: 'http://localhost:3100', locale: 'ru-RU' });
    const page = await ctx.newPage();
    await page.goto('/login');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Пароль').fill('temp');
    await page.getByRole('button', { name: 'Войти' }).click();
    await expect(page).toHaveURL(/\/change-password/);
    await page.getByPlaceholder('Текущий пароль', { exact: true }).fill('temp');
    await page.getByPlaceholder('Новый пароль', { exact: true }).fill('pass1');
    await page.getByPlaceholder('Повторите новый пароль').fill('pass1');
    await page.getByRole('button', { name: 'Сменить пароль' }).click();
    await expect(page).toHaveURL(/\/dashboard/);

    const nav = page.getByRole('complementary');
    await expect(nav.getByRole('link', { name: 'Платежи' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Dashboard' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Договоры' })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Пользователи' })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Роли и права' })).toHaveCount(0);
    await expect(nav).toContainText(roleName);
    const mine = await api(page);
    expect(await mine.status('/contracts')).toBe(403);
    expect(await mine.status('/payments')).toBe(200);
    expect((await mine.post('/roles', { name: 'Взлом', permissions: ['dashboard.view'] })).status()).toBe(403);
    await page.goto('/roles');
    await expect(page.locator('p[role=alert]')).toContainText('Недостаточно прав');

    // 4. Админ добавляет право «Просмотр договоров» — у пользователя действует сразу, без повторного входа
    await admin.page.goto('/roles');
    await admin.page.getByRole('button', { name: new RegExp(roleName) }).click();
    await admin.page.getByLabel('Просмотр договоров').check();
    await admin.page.getByRole('button', { name: 'Сохранить изменения' }).click();
    await expect(admin.page.getByRole('status')).toContainText('Сохранено');
    expect(await mine.status('/contracts')).toBe(200);
    await page.goto('/dashboard');
    await expect(page.getByRole('complementary').getByRole('link', { name: 'Договоры' })).toBeVisible();

    // 5. Роль с пользователями удалить нельзя
    admin.page.once('dialog', (d) => d.accept());
    await admin.page.getByRole('button', { name: 'Удалить роль' }).click();
    await expect(admin.page.locator('p[role=alert]')).toContainText('назначена пользователям');

    await ctx.close(); await admin.ctx.close();
  });

  test('«Роли и права» не видны другим встроенным ролям', async ({ browser }) => {
    for (const who of ['manager', 'finance', 'viewer'] as const) {
      const u = await loginAs(browser, who);
      await expect(u.page.getByRole('complementary').getByRole('link', { name: 'Роли и права' })).toHaveCount(0);
      const a = await api(u.page);
      expect((await a.post('/roles', { name: 'Взлом', permissions: ['dashboard.view'] })).status()).toBe(403);
      await u.ctx.close();
    }
  });
});
