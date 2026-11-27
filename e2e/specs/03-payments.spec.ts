import { expect, test } from '@playwright/test';
import { api, loginAs } from '../helpers';

async function contractId(page: import('@playwright/test').Page, q: string) {
  return (await (await api(page)).get(`/contracts?q=${q}`)).items[0].id as string;
}

test.describe('Платежи: создание → подтверждение другим сотрудником → сторно', () => {
  test('платёж не влияет на долг, пока его не подтвердит финансист; создатель подтвердить не может', async ({ browser }) => {
    const mgr = await loginAs(browser, 'manager');
    const id = await contractId(mgr.page, 'E2E-001');
    const ma = await api(mgr.page);
    expect((await ma.get(`/contracts/${id}`)).debt).toBe('8000.00');

    await mgr.page.goto(`/payments/new?contractId=${id}`);
    await expect(mgr.page.getByText('E2E-001').first()).toBeVisible();
    await mgr.page.getByLabel(/^Сумма/).fill('700');
    await mgr.page.getByLabel(/Банковский документ/).fill('ПП-E2E-1');
    await mgr.page.getByLabel(/Номер транзакции/).fill('TX-E2E-1');
    await mgr.page.getByRole('button', { name: 'Отправить на подтверждение' }).click();
    await expect(mgr.page).toHaveURL(/\/payments\/[0-9a-f-]{36}/);
    await expect(mgr.page.getByText('Ожидает подтверждения').first()).toBeVisible();
    await expect(mgr.page.getByRole('button', { name: 'Подтвердить', exact: true })).toHaveCount(0); // у менеджера нет права
    expect((await ma.get(`/contracts/${id}`)).debt).toBe('8000.00'); // долг не изменился

    // тот же номер транзакции повторно не принимается
    await mgr.page.goto(`/payments/new?contractId=${id}`);
    await mgr.page.getByLabel(/^Сумма/).fill('50');
    await mgr.page.getByLabel(/Номер транзакции/).fill('TX-E2E-1');
    await mgr.page.getByRole('button', { name: 'Отправить на подтверждение' }).click();
    await expect(mgr.page.locator('p[role=alert]')).toContainText('уже зарегистрирован');

    // финансист подтверждает — долг уменьшается
    const fin = await loginAs(browser, 'finance');
    await fin.page.goto('/payments?status=PENDING');
    await fin.page.getByRole('row', { name: /E2E-001/ }).getByRole('link').first().click();
    await fin.page.getByRole('dialog', { name: 'Краткая карточка платежа' }).getByRole('link', { name: 'Открыть полностью' }).click();
    await fin.page.getByRole('button', { name: 'Подтвердить', exact: true }).click();
    await expect(fin.page.getByText('Подтверждён').first()).toBeVisible();
    const after = await (await api(fin.page)).get(`/contracts/${id}`);
    expect(after).toMatchObject({ debt: '7300.00', paid: '2700.00', newPaid: '700.00' });
    await mgr.ctx.close(); await fin.ctx.close();
  });

  test('финансист сторнирует платёж: оригинал остаётся в истории, долг возвращается', async ({ browser }) => {
    const fin = await loginAs(browser, 'finance');
    const fa = await api(fin.page);
    const id = await contractId(fin.page, 'E2E-001');
    const pay = (await fa.get(`/payments?contractId=${id}`)).items[0];
    await fin.page.goto(`/payments/${pay.id}`);
    fin.page.once('dialog', (d) => d.accept('ошибочный платёж (E2E)'));
    await fin.page.getByRole('button', { name: 'Сторнировать' }).click();
    await expect(fin.page.getByText('сторнирован', { exact: false }).first()).toBeVisible();
    expect(await fa.get(`/contracts/${id}`)).toMatchObject({ debt: '8000.00', newPaid: '0.00' });
    const list = await fa.get(`/payments?contractId=${id}`);
    expect(list.items.map((p: any) => p.kind).sort()).toEqual(['PAYMENT', 'REVERSAL']);
    // повторное сторно невозможно (кнопки больше нет)
    await fin.page.goto(`/payments/${pay.id}`);
    await expect(fin.page.getByRole('button', { name: 'Сторнировать' })).toHaveCount(0);
    await fin.ctx.close();
  });

  test('второй платёж 1500 подтверждён — он понадобится для сверки', async ({ browser }) => {
    const mgr = await loginAs(browser, 'manager');
    const id = await contractId(mgr.page, 'E2E-001');
    const ma = await api(mgr.page);
    const created = await ma.post('/payments', { contractId: id, paymentDate: new Date().toISOString().slice(0, 10), amount: '1500', submit: true, idempotencyKey: crypto.randomUUID(), transactionNo: 'TX-E2E-2' });
    expect(created.status()).toBe(201);
    const fin = await loginAs(browser, 'finance');
    const fa = await api(fin.page);
    const approved = await fa.post(`/payments/${(await created.json()).id}/approve`, {});
    expect(approved.status()).toBe(201);
    expect(await fa.get(`/contracts/${id}`)).toMatchObject({ debt: '6500.00', paid: '3500.00' });
    await mgr.ctx.close(); await fin.ctx.close();
  });
});
