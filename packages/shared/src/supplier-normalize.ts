const LEGAL = ['mchj', 'ooo', 'ооо', 'llc', 'ltd', 'co', 'limited', 'sirketi', 'jsc', 'ao', 'ип', 'ip', 'xk', 'qk', 'ok'];
const QUOTES = /[«»"“”„'`´]/g;
const TAX_ID = /(?:инн|stir|inn)\s*[:№]?\s*(\d{9,14})/gi;

/** Отображаемое имя: только чистка пробелов/переносов. Кавычки и регистр сохраняются — это исходное написание. */
export function cleanDisplayName(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/** Извлекает ИНН/STIR, если он указан в названии («ИНН 309007648»). */
export function extractTaxId(raw: string): string | null {
  const m = new RegExp(TAX_ID.source, 'i').exec(raw);
  return m ? m[1] : null;
}

/** Точный ключ: два написания отличаются лишь регистром/кавычками/пробелами/ИНН. Используется для группировки в отчёте. */
export function supplierExactKey(raw: string): string {
  return raw.replace(TAX_ID, ' ').toLowerCase().replace(QUOTES, '').replace(/\s+/g, ' ').trim();
}

/**
 * Нечёткий ключ — только для ПРЕДЛОЖЕНИЯ дубликатов пользователю. Никогда не используется для
 * автоматического объединения: разные юрлица могут давать одинаковый ключ.
 */
export function supplierMatchKey(raw: string): string {
  let s = raw.replace(TAX_ID, ' ').toLowerCase().replace(QUOTES, ' ');
  s = s.replace(/[.,;:()\[\]\-_/\\]/g, ' ');
  return s.split(/\s+/).filter(Boolean).filter((t) => !LEGAL.includes(t)).join('');
}
