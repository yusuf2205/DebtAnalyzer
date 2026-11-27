import { expect, test } from '@playwright/test';
import { loginAs } from '../helpers';

test.describe('Краткая панель договора', () => {
  test('клик по договору открывает панель справа без перехода; переключение, Esc и «Открыть полностью»', async ({ browser }) => {
    const u = await loginAs(browser, 'manager');
    const page = u.page;
    await page.goto('/contracts');
    const panel = page.getByRole('dialog', { name: 'Краткая карточка договора' });
    await expect(panel).toHaveCount(0);

    await page.getByRole('link', { name: /E2E-002/ }).click();
    await expect(panel).toBeVisible();
    await expect(page).toHaveURL(/\/contracts$/); // остались в списке
    await expect(panel.getByRole('heading', { name: /E2E-002/ })).toBeVisible();
    await expect(panel.getByText('E2E-BETA MCHJ')).toBeVisible();
    await expect(panel.getByText('Остаток долга')).toBeVisible();
    await expect(panel.getByText('План платежей')).toBeVisible();

    // клик по строке другого договора переключает панель
    await page.getByRole('row', { name: /E2E-003/ }).getByText('E2E проект').click();
    await expect(panel.getByRole('heading', { name: /E2E-003/ })).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);

    await page.getByRole('link', { name: /E2E-001/ }).click();
    await panel.getByRole('link', { name: 'Открыть полностью' }).click();
    await expect(page).toHaveURL(/\/contracts\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { name: /E2E-001/ })).toBeVisible();
    await u.ctx.close();
  });
});
