import ExcelJS from 'exceljs';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { api, loginAs } from '../helpers';

test.describe('Dashboard, курсы и отчёты', () => {
  test('без подтверждённых курсов итог в USD помечен неполным; после подтверждения курса — пересчитан', async ({ browser }) => {
    const admin = await loginAs(browser, 'admin');
    const a = await api(admin.page);
    await admin.page.goto('/dashboard');
    await expect(admin.page.getByText('Итоги в UZS неполные')).toBeVisible();
    let d = await a.get('/dashboard');
    expect(d.rates.usdComplete).toBe(false);
    expect(d.kpi.totalUsd.debt).toBe('7000.00'); // только USD-договоры (6500 + 500): UZS без курса не включён — поэтому итог помечен неполным
    expect(d.rates.missing).toEqual(['UZS']);
    expect(d.kpi.byCurrency.find((c: any) => c.currency === 'UZS').usd).toBeNull();

    // администратор подтверждает курс через интерфейс
    await admin.page.goto('/fx');
    await admin.page.getByLabel('UZS за 1 ед.').fill('12085');
    await admin.page.getByLabel(/Источник/).fill('ЦБ РУз (E2E)');
    await admin.page.getByRole('button', { name: 'Добавить курс' }).click();
    await expect(admin.page.getByRole('row', { name: /USD.*12\s?085/ })).toContainText('Подтверждён');

    await admin.page.goto('/dashboard');
    await expect(admin.page.getByText('Итоги в UZS неполные')).toHaveCount(0);
    d = await a.get('/dashboard');
    expect(d.rates).toMatchObject({ usdComplete: true, missing: [] });
    // USD: E2E-001 (6500) + E2E-003 (500); UZS: 12 085 000 / 12 085 = 1000  →  8000
    expect(d.kpi.totalUsd.debt).toBe('8000.00');
    expect(d.kpi.byCurrency.find((c: any) => c.currency === 'UZS').usd.debt).toBe('1000.00');
    expect(d.kpi.totalUzs.debt).toBe('96680000.00'); // 7000 USD × 12 085 + 12 085 000 UZS
    await expect(admin.page.getByText(/96\s680\s000/).first()).toBeVisible(); // главная плитка — в UZS
    await expect(admin.page.locator('svg.recharts-surface').first()).toBeVisible(); // главные графики отрисованы
    await expect(admin.page.getByRole('heading', { name: 'Динамика задолженности' })).toBeHidden(); // второстепенное свёрнуто
    await admin.page.getByText('Подробный анализ').click();
    await expect(admin.page.getByRole('heading', { name: 'Динамика задолженности' })).toBeVisible();
    await admin.ctx.close();
  });

  test('отчёт «Долги по поставщикам»: предпросмотр, Excel, CSV и PDF', async ({ browser }) => {
    const fin = await loginAs(browser, 'finance');
    await fin.page.goto('/reports');
    await fin.page.getByRole('button', { name: 'Долги по поставщикам' }).click();
    const row = fin.page.getByRole('row', { name: /E2E-ALPHA LLC/ });
    await expect(row).toContainText('6 500,00');
    await expect(fin.page.getByRole('row', { name: /ИТОГО в USD-эквиваленте/ })).toBeVisible();

    // Excel
    const [xlsx] = await Promise.all([fin.page.waitForEvent('download'), fin.page.getByRole('link', { name: 'Excel' }).click()]);
    expect(xlsx.suggestedFilename()).toMatch(/^Долги по поставщикам_\d{4}-\d{2}-\d{2}\.xlsx$/);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(await xlsx.path());
    const ws = wb.worksheets[0];
    expect(String(ws.getCell('A1').value)).toBe('Долги по поставщикам');
    let found: ExcelJS.Row | null = null; let header = 0;
    ws.eachRow((r, n) => { if (r.getCell(1).value === 'Контрагент') header = n; if (r.getCell(1).value === 'E2E-ALPHA LLC') found = r; });
    expect(header).toBeGreaterThan(0);
    const cols = (ws.getRow(header).values as any[]);
    const debtCell = found!.getCell(cols.indexOf('Долг'));
    expect(debtCell.value).toBe(6500); // число, а не текст
    expect(debtCell.numFmt).toBe('#,##0.00');
    expect(ws.autoFilter).toBeTruthy();

    // CSV
    const [csv] = await Promise.all([fin.page.waitForEvent('download'), fin.page.getByRole('link', { name: 'CSV' }).click()]);
    const text = readFileSync(await csv.path(), 'utf8');
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text).toContain('E2E-ALPHA LLC;USD;1;10000.00;3500.00;6500.00');

    // PDF
    const [pdf] = await Promise.all([fin.page.waitForEvent('download'), fin.page.getByRole('link', { name: 'PDF' }).click()]);
    const pdfBytes = readFileSync(await pdf.path());
    expect(pdfBytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdfBytes.length).toBeGreaterThan(5000);
    await fin.ctx.close();
  });

  test('отчёт «Фактические оплаты» показывает платёж, сторно и итог с курсом на дату', async ({ browser }) => {
    const fin = await loginAs(browser, 'finance');
    await fin.page.goto('/reports');
    await fin.page.getByRole('button', { name: 'Фактические оплаты' }).click();
    await expect(fin.page.getByRole('row', { name: /Сторно/ })).toBeVisible();
    await expect(fin.page.getByRole('row', { name: /Оплата.*1\s500,00/ })).toBeVisible();
    const a = await api(fin.page);
    const r = await a.get('/reports/payments?currency=USD');
    expect(r.totals.find((t: any) => t.supplier === 'ИТОГО USD').signed).toBe('1500.00'); // 700 − 700 (сторно) + 1500
    await fin.ctx.close();
  });
});
