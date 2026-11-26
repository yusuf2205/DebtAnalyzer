import { expect, test } from '@playwright/test';
import { USERS, api, loginAs } from '../helpers';

test.describe('Вход и сессии', () => {
  test('неверный пароль — понятная ошибка, остаёмся на странице входа', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(USERS.manager.email);
    await page.getByLabel('Пароль').fill('неверный-пароль-123');
    await page.getByRole('button', { name: 'Войти' }).click();
    await expect(page.locator('p[role=alert]')).toHaveText('Неверный email или пароль');
    await expect(page).toHaveURL(/\/login/);
  });

  test('без входа защищённые страницы ведут на /login', async ({ page }) => {
    for (const path of ['/dashboard', '/payments', '/reports', '/system']) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login/);
    }
  });

  test('успешный вход открывает Dashboard, выход закрывает доступ', async ({ browser }) => {
    const { ctx, page } = await loginAs(browser, 'manager');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await expect(page.getByText(/e2e-mgr|MANAGER/).first()).toBeVisible();
    await page.getByRole('button', { name: 'Выйти' }).click();
    await expect(page).toHaveURL(/\/login/);
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login/);
    await ctx.close();
  });

  test('новый пользователь обязан сменить временный пароль до работы с данными', async ({ browser }) => {
    const { ctx: actx, page: apage } = await loginAs(browser, 'admin');
    const a = await api(apage);
    const created = await a.post('/users', { email: 'e2e-temp@example.test', name: 'Временный', role: 'VIEWER', password: 'TempPassw0rd!12' });
    expect(created.status()).toBe(201);

    const ctx = await browser.newContext({ baseURL: 'http://localhost:3100' });
    const page = await ctx.newPage();
    await page.goto('/login');
    await page.getByLabel('Email').fill('e2e-temp@example.test');
    await page.getByLabel('Пароль').fill('TempPassw0rd!12');
    await page.getByRole('button', { name: 'Войти' }).click();
    await expect(page).toHaveURL(/\/change-password/);
    // пока пароль не сменён, данные недоступны даже прямым запросом
    expect((await page.request.get('/api/contracts')).status()).toBe(403);
    await page.getByPlaceholder('Текущий пароль').fill('TempPassw0rd!12');
    await page.getByPlaceholder('Новый пароль', { exact: true }).fill('BrandNewPassw0rd!34');
    await page.getByPlaceholder('Повторите новый пароль').fill('BrandNewPassw0rd!34');
    await page.getByRole('button', { name: 'Сменить пароль' }).click();
    await expect(page).toHaveURL(/\/dashboard/);
    expect((await page.request.get('/api/contracts')).status()).toBe(200);
    await ctx.close(); await actx.close();
  });
});
