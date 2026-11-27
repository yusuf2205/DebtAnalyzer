'use client';
import type { PlantMood, PlantStage, PlantState } from '@pf/shared';

export const STAGE_NAME: Record<PlantStage, string> = { 1: 'Росток', 2: 'Побег', 3: 'Кустик', 4: 'Бутон', 5: 'Цветёт' };
export const MOOD_NAME: Record<PlantMood, string> = { healthy: 'Здоров', thirsty: 'Хочет пить', wilting: 'Вянет', dead: 'Погиб' };
export const PLANT_RULE_TEXT = 'Цветок растёт, пока подтверждённые платежи идут не реже раза в 10 дней. Без платежей 11–17 дней — хочет пить, 18–24 — вянет, 25 и больше — погибает. Новый подтверждённый платёж сажает росток заново.';

const HEIGHT: Record<PlantStage, number> = { 1: 26, 2: 46, 3: 64, 4: 80, 5: 90 };
const LEAF = 'M0 0 C8 -9 24 -9 32 0 C24 9 8 9 0 0z';
const COLOR: Record<PlantMood, [string, string]> = {
  healthy: ['var(--accent)', 'var(--accent)'], thirsty: ['#8fa24f', '#a3a65a'], wilting: ['#b09a45', '#a58a4a'], dead: ['#8a6a4a', '#8a6a4a'],
};
const DROOP: Record<PlantMood, number> = { healthy: 0, thirsty: 28, wilting: 62, dead: 0 };

/** Цветок: стадия роста (1–5) и настроение. Рисуется целиком из SVG — без картинок. */
export function Plant({ plant, className }: { plant: PlantState; className?: string }) {
  const { stage, mood } = plant;
  const [stemColor, leafColor] = COLOR[mood];
  const h = HEIGHT[stage];
  const baseY = 108, topY = baseY - h;
  const droop = DROOP[mood];
  const bend = mood === 'wilting' ? 16 : mood === 'thirsty' ? 5 : mood === 'dead' ? 30 : 0; // стебель клонится вбок
  const topX = 95 + bend;
  const stem = mood === 'dead'
    ? `M95 ${baseY} C95 ${baseY - 22} ${95 + 14} ${baseY - 30} ${95 + 30} ${baseY - 28}`
    : `M95 ${baseY} C95 ${baseY - h * 0.5} ${95 + bend * 0.2} ${topY + h * 0.2} ${topX} ${topY}`;
  const pairs = mood === 'dead' ? 0 : stage;
  const leaves = Array.from({ length: pairs }, (_, k) => {
    const t = pairs === 1 ? 0.7 : 0.35 + (k / (pairs - 1)) * 0.5; // доля высоты стебля
    const y = baseY - h * t, x = 95 + bend * t * t;
    const size = 0.75 + (1 - k / Math.max(1, pairs)) * 0.3;
    return { y, x, size, k };
  });
  return (
    <svg className={className} width="190" height="130" viewBox="0 0 190 130" fill="none" role="img"
      aria-label={`Цветок: ${STAGE_NAME[stage]}, ${MOOD_NAME[mood].toLowerCase()}`}>
      <g style={{ transformOrigin: '95px 108px', animation: 'plant-grow .9s ease-out both' }}>
        <path d={stem} stroke={stemColor} strokeWidth={mood === 'dead' ? 3.5 : 3} strokeLinecap="round" />
        {leaves.map(({ y, x, size, k }) => (
          <g key={k}>
            <g transform={`translate(${x} ${y}) rotate(${-28 + droop}) scale(${size})`}><path d={LEAF} fill={leafColor} opacity={0.62 + (k % 2) * 0.28} /></g>
            <g transform={`translate(${x} ${y}) scale(-1 1) rotate(${-28 + droop}) scale(${size})`}><path d={LEAF} fill={leafColor} opacity={0.9 - (k % 2) * 0.28} /></g>
          </g>))}
        {stage === 1 && mood !== 'dead' && <path d={`M${topX} ${topY} C${topX - 9} ${topY - 8} ${topX - 9} ${topY - 20} ${topX} ${topY - 26} C${topX + 9} ${topY - 20} ${topX + 9} ${topY - 8} ${topX} ${topY}z`} fill={leafColor} />}
        {stage === 4 && mood !== 'dead' && <ellipse cx={topX} cy={topY - 8} rx="7" ry="11" fill="#e8908a" />}
        {stage === 5 && (mood === 'healthy' || mood === 'thirsty') && (
          <g transform={`translate(${topX} ${topY - 6})`}>
            {[0, 72, 144, 216, 288].map((a) => <ellipse key={a} cx="0" cy="-11" rx="6.5" ry="11" fill="#e8908a" transform={`rotate(${a + (mood === 'thirsty' ? 8 : 0)})`} />)}
            <circle r="6" fill="#f0b94a" />
          </g>)}
        {stage === 5 && mood === 'wilting' && <ellipse cx={topX} cy={topY} rx="7" ry="10" fill="#b58b7a" transform={`rotate(70 ${topX} ${topY})`} />}
        {mood === 'dead' && <path d="M122 80c6-3 14-1 18 5-8 4-16 2-18-5z" fill="#8a6a4a" opacity=".7" transform="translate(-8 24) rotate(18 130 84)" />}
      </g>
      <path d="M62 108h66l-6 20a4 4 0 0 1-4 3H72a4 4 0 0 1-4-3z" fill="var(--t-peach)" stroke="var(--border)" />
      <rect x="58" y="104" width="74" height="8" rx="4" fill="var(--t-peach)" stroke="var(--border)" />
    </svg>
  );
}
