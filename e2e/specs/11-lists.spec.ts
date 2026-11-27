import { expect, test } from '@playwright/test';
import { loginAs } from '../helpers';

test.describe('Списки: итоги и размер страницы', () => {
  test('итоги по валюте скрываются и запоминаются; размер страницы 50–500 выбирается и запоминается', async ({ browser }) => {
    const u = await loginAs(browser, 'admin');
    const page = u.page;
    await page.goto('/contracts');
    await expect(page.getByRole('columnheader', { name: 'Итого по валюте' })).toBeVisible();
    await page.getByRole('button', { name: /Скрыть итоги по валюте/ }).click();
    await expect(page.getByRole('columnheader', { name: 'Итого по валюте' })).toHaveCount(0);
    await page.goto('/suppliers'); // выбор общий для списков и переживает перезагрузку
    await expect(page.getByRole('button', { name: /Показать итоги по валюте/ })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Итого по валюте' })).toHaveCount(0);
    await page.getByRole('button', { name: /Показать итоги по валюте/ }).click();
    await expect(page.getByRole('columnheader', { name: 'Итого по валюте' })).toBeVisible();

    await page.goto('/contracts');
    const size = page.getByLabel('Сколько договоров показывать на странице').first();
    await expect(size).toBeVisible();
    expect(await size.locator('option').allTextContents()).toEqual(['50', '100', '150', '200', '300', '400', '500']);
    await size.selectOption('500');
    await expect(page.getByText(/1–\d+ из \d+ договоров/).first()).toBeVisible();
    await page.reload();
    await expect(page.getByLabel('Сколько договоров показывать на странице').first()).toHaveValue('500'); // запомнилось
    expect((await (await page.request.get('/api/contracts?pageSize=500')).json()).pageSize).toBe(500);
    await page.getByLabel('Сколько договоров показывать на странице').first().selectOption('50');
    await u.ctx.close();
  });
});
