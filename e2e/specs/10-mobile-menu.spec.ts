import { expect, test } from '@playwright/test';
import { loginAs } from '../helpers';

test.describe('Выдвижное меню на телефоне', () => {
  test('кнопка открывает меню; переход, Esc и тап по фону закрывают; на компьютере постоянная панель', async ({ browser }) => {
    const u = await loginAs(browser, 'manager');
    const page = u.page;
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/dashboard');
    const burger = page.getByRole('button', { name: 'Открыть меню' });
    await expect(burger).toBeVisible();
    await expect(page.getByRole('complementary')).toBeHidden(); // постоянной панели нет
    await expect(page.getByRole('dialog', { name: 'Меню' })).toHaveCount(0);

    await burger.click();
    const menu = page.getByRole('dialog', { name: 'Меню' });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('button', { name: 'Выйти' })).toBeVisible();      // кнопки аккаунта доступны без прокрутки вбок
    await expect(menu.getByRole('link', { name: 'Сменить пароль' })).toBeVisible();
    await expect(menu.getByRole('link', { name: 'Пользователи' })).toHaveCount(0); // права учитываются так же, как на компьютере

    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);

    await burger.click();
    await menu.getByRole('link', { name: 'Договоры' }).click();
    await expect(page).toHaveURL(/\/contracts/);
    await expect(menu).toHaveCount(0); // закрылось само

    await burger.click();
    await page.mouse.click(380, 400); // тап по затемнению справа от панели
    await expect(menu).toHaveCount(0);

    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(burger).toBeHidden();
    await expect(page.getByRole('complementary').getByRole('link', { name: 'Договоры' })).toBeVisible();
    await u.ctx.close();
  });
});
