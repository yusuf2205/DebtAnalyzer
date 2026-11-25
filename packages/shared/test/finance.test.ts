import { describe, expect, it } from 'vitest';
import { can, computeDebt, dec, money, parseCurrency, supplierExactKey, supplierMatchKey, toUsd } from '../src';

describe('Finance Engine: задолженность', () => {
  it('без платежей: долг = сумма − начальная оплата', () => {
    const r = computeDebt({ contractAmount: '1000', openingPaid: '300' });
    expect(r.debt.toString()).toBe('700');
    expect(r.state).toBe('PARTIAL');
  });
  it('неоплаченный договор', () => {
    expect(computeDebt({ contractAmount: 500, openingPaid: 0 }).state).toBe('UNPAID');
  });
  it('частичная оплата новым подтверждённым платежом', () => {
    const r = computeDebt({ contractAmount: 1000, openingPaid: 300, payments: [{ amount: 200, status: 'APPROVED' }] });
    expect(r.debt.toString()).toBe('500');
  });
  it('полная оплата', () => {
    const r = computeDebt({ contractAmount: 1000, openingPaid: 300, payments: [{ amount: 700, status: 'APPROVED' }] });
    expect(r.debt.toString()).toBe('0');
    expect(r.state).toBe('PAID');
  });
  it('переплата показывается как переплата, а не отрицательный долг', () => {
    const r = computeDebt({ contractAmount: 1000, openingPaid: 900, payments: [{ amount: 250, status: 'APPROVED' }] });
    expect(r.debt.toString()).toBe('0');
    expect(r.overpaid.toString()).toBe('150');
    expect(r.state).toBe('OVERPAID');
  });
  it('возврат увеличивает долг', () => {
    const r = computeDebt({ contractAmount: 1000, openingPaid: 0, payments: [{ amount: 1000, status: 'APPROVED' }, { amount: 100, status: 'APPROVED', kind: 'REFUND' }] });
    expect(r.debt.toString()).toBe('100');
  });
  it('сторно отменяет платёж', () => {
    const r = computeDebt({ contractAmount: 1000, openingPaid: 0, payments: [{ amount: 400, status: 'APPROVED' }, { amount: 400, status: 'APPROVED', kind: 'REVERSAL' }] });
    expect(r.debt.toString()).toBe('1000');
  });
  it('только подтверждённые платежи участвуют в расчёте', () => {
    const r = computeDebt({
      contractAmount: 1000, openingPaid: 0,
      payments: (['DRAFT', 'PENDING', 'REJECTED', 'CANCELLED'] as const).map((status) => ({ amount: 999, status })),
    });
    expect(r.debt.toString()).toBe('1000');
  });
  it('двойной учёт: платёж, уже отражённый в начальном остатке, не вычитается повторно', () => {
    const r = computeDebt({ contractAmount: 1000, openingPaid: 600, payments: [{ amount: 600, status: 'APPROVED', reflectedInOpening: true }] });
    expect(r.debt.toString()).toBe('400');
    expect(r.newApprovedPaid.toString()).toBe('0');
  });
  it('отрицательная сумма платежа запрещена', () => {
    expect(() => computeDebt({ contractAmount: 10, openingPaid: 0, payments: [{ amount: -1, status: 'APPROVED' }] })).toThrow();
  });
  it('нет двоичного шума: 0.1 + 0.2 = 0.3', () => {
    const r = computeDebt({ contractAmount: '0.3', openingPaid: 0, payments: [{ amount: 0.1, status: 'APPROVED' }, { amount: 0.2, status: 'APPROVED' }] });
    expect(r.debt.toString()).toBe('0');
  });
  it('округление HALF_UP до 2 знаков', () => {
    expect(money('1.005').toString()).toBe('1.01');
    expect(money('2.675').toString()).toBe('2.68');
    expect(money('-1.005').toString()).toBe('-1.01');
  });
});

describe('Валюты', () => {
  const rates = { USD: 12085, EUR: 13470, RUB: 139 };
  it('USD -> USD без изменений', () => {
    expect(toUsd('100.50', 'USD', rates).usd.toString()).toBe('100.5');
  });
  it('UZS -> USD по курсу', () => {
    expect(toUsd(12085000, 'UZS', rates).usd.toString()).toBe('1000');
  });
  it('EUR -> USD через UZS без промежуточного округления', () => {
    expect(toUsd(100, 'EUR', rates).usd.toString()).toBe('111.46');
  });
  it('разные курсы дают разные результаты, историческая сумма от курса зависит только от переданных курсов', () => {
    const old = toUsd(1_000_000, 'UZS', { USD: 11850 }).usd.toString();
    const cur = toUsd(1_000_000, 'UZS', { USD: 12085 }).usd.toString();
    expect(old).toBe('84.39');
    expect(cur).toBe('82.75');
  });
  it('без курса конвертация невозможна — нельзя молча суммировать валюты', () => {
    expect(() => toUsd(1, 'EUR', { USD: 12085 })).toThrow(/курса/);
    expect(() => toUsd(1, 'UZS', {})).toThrow(/USD/);
  });
  it('алиасы валют', () => {
    expect(parseCurrency('EURO')).toMatchObject({ code: 'EUR', aliasUsed: true });
    expect(parseCurrency(' usd ')).toMatchObject({ code: 'USD', aliasUsed: false });
    expect(parseCurrency('')).toMatchObject({ code: null, empty: true });
    expect(parseCurrency('GBP')).toMatchObject({ code: null, unknown: true });
  });
});

describe('Поставщики: нормализация только для предложений', () => {
  it('точный ключ игнорирует кавычки, регистр, пробелы и ИНН', () => {
    expect(supplierExactKey('"Mini Mall" MCHJ')).toBe(supplierExactKey(' "MINI MALL"  Mchj\n'));
    expect(supplierExactKey('ООО «EMAN»\n ИНН 201348969')).toBe(supplierExactKey('ООО «EMAN»'));
  });
  it('нечёткий ключ игнорирует форму собственности — для ПРЕДЛОЖЕНИЯ', () => {
    expect(supplierMatchKey('"ALPHA ELECTRONICS" MCHJ')).toBe(supplierMatchKey('ООО Alpha Electronics'));
  });
  it('разные компании не склеиваются', () => {
    expect(supplierMatchKey('ALPHA ELECTRONICS')).not.toBe(supplierMatchKey('BETA ELECTRONICS'));
  });
});

describe('RBAC', () => {
  it('VIEWER не может подтверждать платежи', () => {
    expect(can('VIEWER', 'payments.approve')).toBe(false);
    expect(can('VIEWER', 'reports.view')).toBe(true);
  });
  it('подтверждает только FINANCE и SUPER_ADMIN (разделение обязанностей)', () => {
    expect(can('FINANCE', 'payments.approve')).toBe(true);
    expect(can('SUPER_ADMIN', 'payments.approve')).toBe(true);
    expect(can('ADMIN', 'payments.approve')).toBe(false);
    expect(can('MANAGER', 'payments.approve')).toBe(false);
  });
  it('MANAGER не управляет пользователями', () => {
    expect(can('MANAGER', 'users.manage')).toBe(false);
    expect(can('ADMIN', 'users.manage')).toBe(true);
  });
  it('dec работает со строками/числами/Decimal', () => {
    expect(dec('1.10').plus(dec(2.2)).toString()).toBe('3.3');
  });
});
