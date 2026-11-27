/**
 * «Цветок» Dashboard: наглядное состояние платёжной дисциплины.
 * Правило простое и проверяемое: считаются только ПОДТВЕРЖДЁННЫЕ платежи приложения (оплаты, не возвраты и не сторно).
 * Каждый день считается «разрыв» — сколько дней прошло с последнего платежа (а до первого платежа — с запуска системы).
 *   разрыв ≤ 10   — цветок здоров и растёт на 1 день;
 *   11–17         — хочет пить: рост стоит;
 *   18–24         — увядает: теряет по 1 дню роста;
 *   ≥ 25          — погиб. Новый подтверждённый платёж сажает новый росток.
 * Рост восстанавливается пересчётом по истории платежей, поэтому он не зависит от того, заходил ли кто-то в систему.
 */
export const PLANT_RULES = { healthyUntil: 10, thirstyUntil: 17, wiltingUntil: 24 } as const;
export type PlantMood = 'healthy' | 'thirsty' | 'wilting' | 'dead';
export type PlantStage = 1 | 2 | 3 | 4 | 5;

export interface PlantInput {
  /** Сегодня, yyyy-mm-dd. */
  today: string;
  /** Начало наблюдения (запуск системы), yyyy-mm-dd. */
  start: string;
  /** Даты подтверждённых платежей (yyyy-mm-dd); повторы допустимы. */
  paymentDates: string[];
  /** Есть ли сейчас долг. Нет долга — платить нечего, цветок здоров. */
  hasDebt: boolean;
}
export interface PlantState {
  stage: PlantStage;
  mood: PlantMood;
  /** Накопленный рост, дней. */
  growthDays: number;
  /** Дней с последнего платежа (или с запуска системы). */
  daysSincePayment: number;
  lastPaymentDate: string | null;
  /** Через сколько дней без платежа цветок станет следующим по тяжести (null — уже погиб или здоров без долга). */
  daysToNextMood: number | null;
  message: string;
}

const DAY = 86_400_000;
const dayNo = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / DAY);
const STAGE_FROM: [number, PlantStage][] = [[35, 5], [18, 4], [7, 3], [2, 2]];
const stageOf = (growth: number): PlantStage => STAGE_FROM.find(([g]) => growth >= g)?.[1] ?? 1;
const MAX_DAYS = 400;

export function plantState(input: PlantInput): PlantState {
  const today = dayNo(input.today);
  const start = Math.min(today, Math.max(dayNo(input.start), today - MAX_DAYS));
  const pays = [...new Set(input.paymentDates.map(dayNo))].filter((d) => d <= today).sort((a, b) => a - b);

  let growth = 0, p = 0, last: number | null = null;
  for (let d = start; d <= today; d++) {
    while (p < pays.length && pays[p]! <= d) { last = pays[p]!; p++; }
    const gap = d - (last !== null && last >= start ? last : start);
    if (gap <= PLANT_RULES.healthyUntil) growth += 1;
    else if (gap <= PLANT_RULES.thirstyUntil) { /* рост стоит */ }
    else if (gap <= PLANT_RULES.wiltingUntil) growth = Math.max(0, growth - 1);
    else growth = 0;
  }
  const lastEff = last !== null && last >= start ? last : null;
  const gap = today - (lastEff ?? start);
  const lastIso = lastEff !== null ? new Date(lastEff * DAY).toISOString().slice(0, 10) : null;

  let mood: PlantMood = gap <= PLANT_RULES.healthyUntil ? 'healthy' : gap <= PLANT_RULES.thirstyUntil ? 'thirsty' : gap <= PLANT_RULES.wiltingUntil ? 'wilting' : 'dead';
  if (!input.hasDebt) mood = 'healthy';
  const stage = mood === 'dead' ? 1 : stageOf(growth);
  const next = mood === 'healthy' ? (input.hasDebt ? PLANT_RULES.healthyUntil + 1 - gap : null) : mood === 'thirsty' ? PLANT_RULES.thirstyUntil + 1 - gap : mood === 'wilting' ? PLANT_RULES.wiltingUntil + 1 - gap : null;

  const since = lastIso ? `последний платёж ${gap} дн. назад` : `платежей пока не было, ${gap} дн. с запуска`;
  const message =
    !input.hasDebt ? 'Долгов нет — цветок спокоен.'
    : mood === 'healthy' ? `Платежи идут регулярно (${since}). Цветок растёт: ${growth} дн.`
    : mood === 'thirsty' ? `Цветок хочет пить: ${since}. Подтвердите платёж, иначе он начнёт вянуть.`
    : mood === 'wilting' ? `Цветок вянет: ${since}. Без платежа он погибнет через ${next} дн.`
    : `Цветок погиб: ${since}. Новый подтверждённый платёж посадит росток.`;
  return { stage, mood, growthDays: mood === 'dead' ? 0 : growth, daysSincePayment: gap, lastPaymentDate: lastIso, daysToNextMood: next, message };
}
