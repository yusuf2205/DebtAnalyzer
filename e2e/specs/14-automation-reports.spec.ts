import { expect, test } from '@playwright/test';
import { api, loginAs } from '../helpers';

test.describe('Автоматизация, отчёты, тип договора, документы, PWA', () => {
  test('PWA: манифест, служебный скрипт, иконки и запасная страница доступны', async ({ browser }) => {
    const u = await loginAs(browser, 'viewer');
    const page = u.page;
    const m = await page.request.get('/manifest.webmanifest');
    expect(m.status(), await m.text()).toBe(200);
    expect(await m.json()).toMatchObject({ short_name: 'Procurement', display: 'standalone', start_url: '/dashboard' });
    expect((await page.request.get('/sw.js')).status()).toBe(200);
    const icon = await page.request.get('/icons/icon-192.png');
    expect(icon.status()).toBe(200); expect(icon.headers()['content-type']).toContain('image/png');
    expect((await page.request.get('/offline.html')).status()).toBe(200);
    await page.goto('/dashboard');
    await expect(page.locator('link[rel=manifest]')).toHaveAttribute('crossorigin', 'use-credentials');
    await u.ctx.close();
  });

  test('уведомления: страница только для администратора; сохранение и предпросмотр сводки', async ({ browser }) => {
    const m = await loginAs(browser, 'manager');
    await m.page.goto('/notifications');
    await expect(m.page.getByText(/Недостаточно прав/)).toBeVisible(); // нет права settings.manage
    await expect(m.page.getByRole('complementary').getByRole('link', { name: 'Уведомления' })).toHaveCount(0);
    await m.ctx.close();

    const a = await loginAs(browser, 'admin');
    await a.page.goto('/notifications');
    await expect(a.page.getByRole('heading', { name: 'Уведомления', exact: true })).toBeVisible();
    await expect(a.page.getByText(/Telegram: (не )?подключён/)).toBeVisible();
    await a.page.getByLabel(/Почта: адреса/).fill('boss@example.test');
    await a.page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await expect(a.page.getByRole('status')).toContainText('Настройки сохранены');
    await a.page.getByRole('button', { name: 'Предпросмотр сводки' }).click();
    await expect(a.page.getByText(/Procurement Finance — сводка на/)).toBeVisible();
    await a.page.getByLabel(/Почта: адреса/).fill('');
    await a.page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await a.ctx.close();
  });

  test('«Система»: копия вне NAS, квартальная проверка, правило «документ для подтверждения»', async ({ browser }) => {
    const a = await loginAs(browser, 'admin');
    await a.page.goto('/system');
    await expect(a.page.getByRole('heading', { name: 'Состояние системы' })).toBeVisible();
    await expect(a.page.getByRole('cell', { name: 'Восстановление на другом компьютере' })).toBeVisible();
    await expect(a.page.getByText('Правила платежей')).toBeVisible();
    const box = a.page.getByRole('checkbox', { name: /нужен приложенный документ/ });
    await expect(box).not.toBeChecked();
    await a.ctx.close();
  });

  test('тип договора: предложения принимаются массово, фильтр «Зарубежные», аудит; затем сброс', async ({ browser }) => {
    const u = await loginAs(browser, 'manager');
    const page = u.page;
    await page.goto('/contracts');
    await expect(page.getByRole('columnheader', { name: 'Тип' })).toBeVisible();
    await expect(page.getByRole('row', { name: /E2E-002/ })).toContainText('местный?'); // UZS и MCHJ → предложение «местный»
    await expect(page.getByRole('row', { name: /E2E-003/ })).toContainText('зарубежный?');
    await page.getByRole('checkbox', { name: 'Выбрать все договоры на странице' }).check();
    page.once('dialog', (d) => d.accept());
    await page.getByRole('button', { name: 'Принять предложения' }).click();
    await expect(page.getByRole('status')).toContainText('Изменено: 3');
    await expect(page.getByRole('row', { name: /E2E-002/ })).toContainText('Местный');
    await page.getByLabel('Тип договора').selectOption('FOREIGN');
    await expect(page.getByRole('row', { name: /E2E-003/ })).toBeVisible();
    await expect(page.getByRole('row', { name: /E2E-002/ })).toHaveCount(0);
    await page.getByLabel('Тип договора').selectOption('');
    await expect(page.getByRole('row', { name: /E2E-002/ })).toBeVisible(); // список снова полный
    await page.getByRole('checkbox', { name: 'Выбрать все договоры на странице' }).check();
    await page.getByRole('button', { name: 'Сбросить', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Изменено: 3');
    await u.ctx.close();
  });

  test('документ к платежу: прикрепление в карточке, счётчик в списке', async ({ browser }) => {
    const f = await loginAs(browser, 'finance');
    const page = f.page;
    await page.goto('/payments');
    await page.getByRole('row', { name: /E2E-001/ }).first().getByRole('link').first().click();
    await page.getByRole('dialog', { name: 'Краткая карточка платежа' }).getByRole('link', { name: 'Открыть полностью' }).click();
    await expect(page.getByRole('heading', { name: /Документы \(0\)/ })).toBeVisible();
    await page.locator('input[type=file]').setInputFiles({ name: 'платёжка.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% e2e\n%%EOF') });
    await expect(page.getByRole('link', { name: 'платёжка.pdf' })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Документы \(1\)/ })).toBeVisible();
    await page.goto('/payments');
    await expect(page.getByRole('row', { name: /E2E-001/ }).first().locator('.badge.b-info').first()).toBeVisible();
    await f.ctx.close();
  });

  test('отчёты и Dashboard: акт сверки со страницы контрагента; прогноз и разрезы в «Подробном анализе»', async ({ browser }) => {
    const u = await loginAs(browser, 'manager');
    const page = u.page;
    await page.goto('/suppliers');
    await page.getByRole('link', { name: 'E2E-ALPHA LLC' }).click();
    await page.getByRole('dialog', { name: 'Краткая карточка контрагента' }).getByRole('link', { name: 'Акт сверки' }).click();
    await expect(page).toHaveURL(/\/reports\?report=supplier-statement/);
    await expect(page.getByText('Оплачено по таблице').first()).toBeVisible();
    await expect(page.getByText(/Подпись организации/)).toBeVisible();
    await expect(page.getByRole('row', { name: /E2E-001/ })).toBeVisible();
    await u.ctx.close();

    const a = await loginAs(browser, 'admin');
    await a.page.goto('/dashboard');
    await a.page.getByText('Подробный анализ').click();
    await expect(a.page.getByRole('heading', { name: 'Прогноз платежей на 8 недель' })).toBeVisible();
    await expect(a.page.getByRole('heading', { name: 'Месяц к месяцу' })).toBeVisible();
    await expect(a.page.getByRole('heading', { name: 'Долг по проектам' })).toBeVisible();
    await expect(a.page.getByRole('heading', { name: 'Долг по исполнителям' })).toBeVisible();
    const d = await (await api(a.page)).get('/dashboard');
    expect(d.forecast.weeks).toHaveLength(8);
    await a.ctx.close();
  });

  test('курсы: кнопка загрузки с ЦБ и подсказка «подтвердить все» для администратора', async ({ browser }) => {
    const a = await loginAs(browser, 'admin');
    await a.page.goto('/fx');
    await expect(a.page.getByRole('button', { name: 'Подтянуть курсы ЦБ' })).toBeVisible();
    await a.ctx.close();
  });
});
