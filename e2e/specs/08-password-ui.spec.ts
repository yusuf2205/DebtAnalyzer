import { expect, test } from '@playwright/test';
import { api, loginAs } from '../helpers';

test.describe('Смена пароля из интерфейса', () => {
  test('ссылка «Сменить пароль» в меню; пароль от 4 символов принимается, 3 символа — нет; вход с новым паролем', async ({ browser }) => {
    const admin = await loginAs(browser, 'admin');
    const a = await api(admin.page);
    const email = `e2e-pw-${Date.now()}@example.test`;
    expect((await a.post('/users', { email, name: 'Pw User', role: 'VIEWER', password: 'x' + 'y'.repeat(3) })).status()).toBe(201); // временный пароль из 4 символов тоже допустим

    const ctx = await browser.newContext({ baseURL: 'http://localhost:3100', locale: 'ru-RU' });
    const page = await ctx.newPage();
    await page.goto('/login');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Пароль').fill('xyyy');
    await page.getByRole('button', { name: 'Войти' }).click();
    await expect(page).toHaveURL(/\/change-password/); // обязательная смена при первом входе

    await page.getByPlaceholder('Текущий пароль', { exact: true }).fill('xyyy');
    await page.getByPlaceholder('Новый пароль', { exact: true }).fill('abc');
    await page.getByPlaceholder('Повторите новый пароль').fill('abc');
    await page.getByRole('button', { name: 'Сменить пароль' }).click();
    await expect(page).toHaveURL(/\/change-password/); // 3 символа: отклонено (браузерной проверкой или сервером)

    await page.getByPlaceholder('Новый пароль', { exact: true }).fill('abcd');
    await page.getByPlaceholder('Повторите новый пароль').fill('abcd');
    await page.getByRole('button', { name: 'Сменить пароль' }).click();
    await expect(page).toHaveURL(/\/dashboard/);

    // добровольная смена через ссылку в меню
    await page.getByRole('complementary').getByRole('link', { name: 'Сменить пароль' }).click();
    await expect(page).toHaveURL(/\/change-password/);
    await page.getByPlaceholder('Текущий пароль', { exact: true }).fill('abcd');
    await page.getByPlaceholder('Новый пароль', { exact: true }).fill('1234');
    await page.getByPlaceholder('Повторите новый пароль').fill('1234');
    await page.getByRole('button', { name: 'Сменить пароль' }).click();
    await expect(page).toHaveURL(/\/dashboard/);

    // вход с новым паролем
    await page.getByRole('button', { name: 'Выйти' }).click();
    await expect(page).toHaveURL(/\/login/);
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Пароль').fill('1234');
    await page.getByRole('button', { name: 'Войти' }).click();
    await expect(page).toHaveURL(/\/dashboard/);

    // сервер отклоняет 3 символа независимо от браузерной проверки
    const me = await (await page.request.get('/api/auth/me')).json();
    const r = await page.request.post('/api/auth/change-password', { data: { current: '1234', next: 'abc' }, headers: { 'x-csrf-token': me.user.csrfToken } });
    expect(r.status()).toBe(400);
    await ctx.close(); await admin.ctx.close();
  });
});
