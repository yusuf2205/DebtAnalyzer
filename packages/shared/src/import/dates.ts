const RU_MONTHS: Record<string, number> = {
  января: 1, февраля: 2, марта: 3, апреля: 4, мая: 5, июня: 6, июля: 7, августа: 8,
  сентября: 9, октября: 10, ноября: 11, декабря: 12,
  январь: 1, февраль: 2, март: 3, апрель: 4, май: 5, июнь: 6, июль: 7, август: 8,
  сентябрь: 9, октябрь: 10, ноябрь: 11, декабрь: 12,
};

function valid(d: number, m: number, y: number): string | null {
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Находит все даты в строке номера договора («от 15.11.2025г.», «24,11,2026», «25 Ноября 2026»).
 * Дата договора считается определённой только если найдена ровно одна уникальная дата.
 * Иначе возвращаются кандидаты — выбор за пользователем (мы не угадываем).
 */
export function findDates(text: string): string[] {
  const out = new Set<string>();
  const numeric = /(\d{1,2})\s*[.,/]\s*(\d{1,2})\s*[.,/\s]\s*(\d{4})/g;
  for (let m; (m = numeric.exec(text)); ) {
    const iso = valid(Number(m[1]), Number(m[2]), Number(m[3]));
    if (iso) out.add(iso);
  }
  const words = /(\d{1,2})\s+([А-Яа-яЁё]+)\s+(\d{4})/g;
  for (let m; (m = words.exec(text)); ) {
    const mo = RU_MONTHS[m[2].toLowerCase()];
    if (!mo) continue;
    const iso = valid(Number(m[1]), mo, Number(m[3]));
    if (iso) out.add(iso);
  }
  return [...out];
}

export function parseDdMmYyyy(text: string): string | null {
  const m = /(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(text);
  return m ? valid(Number(m[1]), Number(m[2]), Number(m[3])) : null;
}
