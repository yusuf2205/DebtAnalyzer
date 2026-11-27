import { expect, test } from '@playwright/test';
import { loginAs } from '../helpers';

test.describe('Ежедневная работа: панели, массовые действия, поиск, представления', () => {
  test('панели справа для контрагента и платежа открываются кликом без перехода', async ({ browser }) => {
    const u = await loginAs(browser, 'manager');
    const page = u.page;
    await page.goto('/suppliers');
    await page.getByRole('link', { name: 'E2E-ALPHA LLC' }).click();
    const sp = page.getByRole('dialog', { name: 'Краткая карточка контрагента' });
    await expect(sp).toBeVisible();
    await expect(page).toHaveURL(/\/suppliers$/);
    await expect(sp.getByRole('heading', { name: 'E2E-ALPHA LLC' })).toBeVisible();
    await expect(sp.getByText('Итоги по валютам')).toBeVisible();
    await expect(sp.getByRole('link', { name: 'Открыть полностью' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sp).toHaveCount(0);

    await page.goto('/payments');
    await page.getByRole('row', { name: /E2E-001/ }).first().getByRole('link').first().click();
    const pp = page.getByRole('dialog', { name: 'Краткая карточка платежа' });
    await expect(pp).toBeVisible();
    await expect(page).toHaveURL(/\/payments$/);
    await expect(pp.getByText('Контрагент:')).toBeVisible();
    await u.ctx.close();
  });

  test('массовые действия: архив, восстановление, исполнитель; наблюдатель их не видит', async ({ browser }) => {
    const u = await loginAs(browser, 'manager');
    const page = u.page;
    await page.goto('/contracts');
    const row3 = page.getByRole('row', { name: /E2E-003/ });
    await expect(row3).toBeVisible();
    await row3.getByRole('checkbox', { name: /Выбрать договор/ }).check();
    await expect(page.getByText('Выбрано: 1')).toBeVisible();
    page.once('dialog', (d) => d.accept());
    await page.getByRole('button', { name: 'В архив', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Изменено: 1');
    await expect(page.getByRole('row', { name: /E2E-003/ })).toHaveCount(0); // ушёл из активных

    await page.locator('select').filter({ hasText: 'Активные' }).selectOption('ARCHIVED');
    const arch = page.getByRole('row', { name: /E2E-003/ });
    await expect(arch).toBeVisible();
    await arch.getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Восстановить', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Изменено: 1');
    await page.locator('select').filter({ hasText: 'Архив' }).selectOption('ACTIVE');

    const row2 = page.getByRole('row', { name: /E2E-002/ });
    await row2.getByRole('checkbox').check();
    await page.getByLabel('Исполнитель для выбранных').fill('Тест-исполнитель');
    page.once('dialog', (d) => d.accept());
    await page.getByRole('button', { name: 'Назначить' }).click();
    await expect(page.getByRole('status')).toContainText('Изменено: 1');
    await expect(page.getByRole('row', { name: /E2E-002/ })).toContainText('Тест-исполнитель');
    await u.ctx.close();

    const v = await loginAs(browser, 'viewer');
    await v.page.goto('/contracts');
    await expect(v.page.getByRole('row', { name: /E2E-002/ })).toBeVisible();
    await expect(v.page.getByRole('checkbox')).toHaveCount(0); // у наблюдателя нет прав на изменение
    await v.ctx.close();
  });

  test('быстрый поиск: Ctrl+K, договор и контрагент, Enter открывает, Esc закрывает; слэш тоже открывает', async ({ browser }) => {
    const u = await loginAs(browser, 'manager');
    const page = u.page;
    await page.goto('/dashboard');
    await page.keyboard.press('Control+k');
    const dlg = page.getByRole('dialog', { name: 'Быстрый поиск' });
    await expect(dlg).toBeVisible();
    await dlg.getByRole('combobox').fill('E2E-002');
    await expect(dlg.getByRole('option', { name: /E2E-002/ })).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/contracts\/[0-9a-f-]{36}$/);
    await expect(dlg).toHaveCount(0);

    await page.keyboard.press('/');
    await expect(dlg).toBeVisible();
    await dlg.getByRole('combobox').fill('ALPHA');
    await expect(dlg.getByRole('option', { name: /договоров: \d/ })).toBeVisible(); // контрагент (у договора в подзаголовке тоже его имя)
    await page.keyboard.press('Escape');
    await expect(dlg).toHaveCount(0);
    await u.ctx.close();
  });

  test('столбцы скрываются и запоминаются; представление сохраняет фильтры', async ({ browser }) => {
    const u = await loginAs(browser, 'manager');
    const page = u.page;
    await page.goto('/contracts');
    await expect(page.getByRole('columnheader', { name: 'Проект' })).toBeVisible();
    await page.getByRole('button', { name: /Столбцы/ }).click();
    await page.getByRole('checkbox', { name: 'Проект' }).uncheck();
    await expect(page.getByRole('columnheader', { name: 'Проект' })).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole('row', { name: /E2E-002/ })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Проект' })).toHaveCount(0); // запомнилось
    await page.getByRole('button', { name: /Столбцы/ }).click();
    await page.getByRole('button', { name: 'Показать все столбцы' }).click();
    await expect(page.getByRole('columnheader', { name: 'Проект' })).toBeVisible();

    await page.locator('select').filter({ hasText: 'Все валюты' }).selectOption('UZS');
    await expect(page.getByRole('row', { name: /E2E-003/ })).toHaveCount(0);
    await page.getByRole('button', { name: /Представления/ }).click();
    await page.getByLabel('Имя нового представления').fill('Только UZS');
    await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await page.keyboard.press('Escape');
    await page.locator('select').filter({ hasText: 'Все валюты' }).selectOption('');
    await expect(page.getByRole('row', { name: /E2E-003/ })).toBeVisible();
    await page.getByRole('button', { name: /Представления/ }).click();
    await page.getByRole('button', { name: 'Только UZS', exact: true }).click();
    await expect(page.getByRole('row', { name: /E2E-003/ })).toHaveCount(0);
    await expect(page.getByRole('row', { name: /E2E-002/ })).toBeVisible();
    await page.getByRole('button', { name: /Представления/ }).click();
    await page.getByRole('button', { name: 'Удалить представление Только UZS' }).click();
    await u.ctx.close();
  });

  test('планшет: боковая панель сворачивается до иконок, ссылки остаются доступными', async ({ browser }) => {
    const u = await loginAs(browser, 'manager');
    const page = u.page;
    await page.setViewportSize({ width: 900, height: 800 });
    await page.goto('/dashboard');
    const nav = page.getByRole('complementary');
    await expect(nav.getByRole('link', { name: 'Договоры' })).toBeVisible(); // имя — из подсказки
    await expect(nav.locator('.nl-label').first()).toBeHidden();
    expect((await nav.boundingBox())!.width).toBeLessThan(100);
    await page.setViewportSize({ width: 1280, height: 800 });
    expect((await nav.boundingBox())!.width).toBeGreaterThan(200);
    await u.ctx.close();
  });
});
