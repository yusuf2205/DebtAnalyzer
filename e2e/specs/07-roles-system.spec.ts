import { expect, test } from '@playwright/test';
import { api, loginAs } from '../helpers';

test.describe('Роли и права (интерфейс и сервер)', () => {
  test('наблюдатель: нет кнопок изменения и админских разделов; прямые запросы отклоняются сервером', async ({ browser }) => {
    const v = await loginAs(browser, 'viewer');
    const nav = v.page.getByRole('complementary');
    await expect(nav.getByRole('link', { name: 'Отчёты' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Пользователи' })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Система' })).toHaveCount(0);

    await v.page.goto('/payments');
    await expect(v.page.getByRole('heading', { name: 'Платежи' })).toBeVisible();
    await expect(v.page.getByRole('link', { name: 'Новый платёж' })).toHaveCount(0);

    const a = await api(v.page);
    for (const [url, body] of [['/payments', {}], ['/suppliers', { name: 'Хакер' }], ['/contracts', {}], ['/users', {}], ['/imports', {}]] as const) {
      expect((await a.post(url, body)).status(), url).toBe(403);
    }
    expect(await a.status('/system/status')).toBe(403);
    expect(await a.status('/audit')).toBe(403);
    await v.page.goto('/system');
    await expect(v.page.locator('p[role=alert]')).toContainText('Недостаточно прав');
    await v.ctx.close();
  });

  test('наблюдатель может смотреть и выгружать отчёты', async ({ browser }) => {
    const v = await loginAs(browser, 'viewer');
    await v.page.goto('/reports');
    await expect(v.page.getByRole('link', { name: 'Excel' })).toBeVisible();
    await v.ctx.close();
  });

  test('менеджер ведёт справочники, но не подтверждает платежи и не управляет пользователями', async ({ browser }) => {
    const m = await loginAs(browser, 'manager');
    const a = await api(m.page);
    const sup = await a.post('/suppliers', { name: 'E2E-MANAGER-CREATED LLC' });
    expect(sup.status()).toBe(201);
    expect((await a.post('/users', { email: 'x@example.test', name: 'x', role: 'VIEWER', password: 'Whatever12345' })).status()).toBe(403);
    expect((await a.post(`/payments/${crypto.randomUUID()}/approve`, {})).status()).toBe(403);
    await m.ctx.close();
  });

  test('администратор видит состояние системы; сквозной журнал аудита содержит все ключевые действия сценария', async ({ browser }) => {
    const admin = await loginAs(browser, 'admin');
    await admin.page.goto('/system');
    await expect(admin.page.getByRole('heading', { name: 'Состояние системы' })).toBeVisible();
    await expect(admin.page.getByRole('row', { name: /База данных/ })).toContainText('OK');
    await expect(admin.page.getByRole('row', { name: /Резервные копии/ })).toBeVisible();
    await expect(admin.page.getByRole('row', { name: /Фоновый воркер/ })).toBeVisible(); // в E2E-стеке воркер не запущен — предупреждение ожидаемо

    const a = await api(admin.page);
    const log = await a.get('/audit?take=200');
    const actions = new Set(log.items.map((x: any) => x.action));
    for (const act of ['auth.login', 'auth.password_changed', 'user.create', 'import.upload', 'import.analyze', 'import.override', 'import.commit', 'payment.create', 'payment.approve', 'payment.reverse', 'reconciliation.confirm', 'plan.create', 'plan.move', 'plan.split', 'fx.create', 'export.report']) {
      expect(actions.has(act), `нет записи аудита: ${act}`).toBe(true);
    }
    await admin.ctx.close();
  });
});
