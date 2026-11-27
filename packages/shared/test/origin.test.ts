import { describe, expect, it } from 'vitest';
import { effectiveOrigin, suggestOrigin } from '../src';

describe('Предложение «местный / зарубежный»', () => {
  it('ИНН или местная форма собственности — местный, даже если договор в USD', () => {
    expect(suggestOrigin({ currency: 'USD', supplierName: '"OFFICE TEXNO HOUSE" MCHJ ИНН: 313280792' })).toBe('LOCAL');
    expect(suggestOrigin({ currency: 'USD', supplierName: 'ООО «META AVTOTRANSDIAGNOSTIK» ИНН 300737015' })).toBe('LOCAL');
    expect(suggestOrigin({ currency: 'EUR', supplierName: 'YaTT " BOBOMIRZAYEV QALQON XOLBOZOROVICH"' })).toBe('LOCAL');
    expect(suggestOrigin({ currency: 'USD', supplierName: 'Some Supplier', supplierTaxId: '302208315' })).toBe('LOCAL');
    expect(suggestOrigin({ currency: 'RUB', supplierName: 'ХК "YARIYEV RAVSHANJON"' })).toBe('LOCAL');
  });
  it('валюта UZS — местный; иностранная валюта без местных признаков — зарубежный', () => {
    expect(suggestOrigin({ currency: 'UZS', supplierName: 'Ivanov Ivan' })).toBe('LOCAL');
    expect(suggestOrigin({ currency: 'USD', supplierName: 'ZHENZHOU ALLRAISE COMPANY LTD' })).toBe('FOREIGN');
    expect(suggestOrigin({ currency: 'EUR', supplierName: 'VERA GROUP T.A.S.' })).toBe('FOREIGN');
    expect(suggestOrigin({ currency: 'RUB', supplierName: 'Микропроцессорные Технологии' })).toBe('FOREIGN');
    expect(suggestOrigin({ currency: 'RUB', supplierName: 'ООО Ромашка ИНН 7701234567' })).toBe('FOREIGN'); // российская форма и 10-значный ИНН — не признак местного
  });
  it('нет данных — нет предложения; слово внутри названия не считается формой (OOO в слове)', () => {
    expect(suggestOrigin({ currency: 'USD', supplierName: '' })).toBeNull();
    expect(suggestOrigin({ currency: 'USD', supplierName: 'BROOOKLYN GLOBAL LTD' })).toBe('FOREIGN');
  });
  it('подтверждённое значение сильнее предложения', () => {
    expect(effectiveOrigin({ origin: 'FOREIGN', currency: 'UZS', supplierName: 'X MCHJ' })).toEqual({ value: 'FOREIGN', confirmed: true, suggested: 'LOCAL' });
    expect(effectiveOrigin({ currency: 'UZS', supplierName: 'X MCHJ' })).toEqual({ value: 'LOCAL', confirmed: false, suggested: 'LOCAL' });
  });
});
