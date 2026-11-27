/**
 * Предложение «местный / зарубежный» для договора. Это ТОЛЬКО подсказка: значение в договоре фиксирует пользователь.
 * Признаки, от самого надёжного к менее надёжному:
 *   1) ИНН поставщика (9 цифр, узбекский) или узбекская форма собственности в названии (MCHJ, YaTT/ЯТТ, XK/ХК, AJ) → местный;
 *   2) валюта UZS → местный;
 *   3) иначе валюта не UZS и нет местных признаков → зарубежный;
 *   4) не хватает данных → предложения нет.
 */
export type Origin = 'LOCAL' | 'FOREIGN';
export const ORIGIN_LABEL: Record<Origin, string> = { LOCAL: 'Местный', FOREIGN: 'Зарубежный' };

const LOCAL_FORMS = /(^|[^a-zа-яё0-9])(mchj|yatt|ятт|xk|хк|aj|ај)([^a-zа-яё0-9]|$)/i; // узбекские формы; «ООО», «ИП», «АО» есть и у российских фирм — не признак
const INN = /(^|\D)\d{9}(\D|$)/;

export function suggestOrigin(input: { currency: string; supplierName?: string | null; supplierTaxId?: string | null }): Origin | null {
  const name = input.supplierName ?? '';
  const taxId = (input.supplierTaxId ?? '').replace(/\D/g, '');
  if (taxId.length === 9 || INN.test(name) || LOCAL_FORMS.test(name)) return 'LOCAL';
  if (input.currency === 'UZS') return 'LOCAL';
  if (input.currency && input.currency !== 'UZS' && name.trim()) return 'FOREIGN';
  return null;
}

/** Действующее значение: подтверждённое, а при его отсутствии — предложение (с признаком, что оно предложено). */
export function effectiveOrigin(c: { origin?: Origin | null; currency: string; supplierName?: string | null; supplierTaxId?: string | null }): { value: Origin | null; confirmed: boolean; suggested: Origin | null } {
  const suggested = suggestOrigin(c);
  return c.origin ? { value: c.origin, confirmed: true, suggested } : { value: suggested, confirmed: false, suggested };
}
