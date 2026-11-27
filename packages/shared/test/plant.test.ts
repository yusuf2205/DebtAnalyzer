import { describe, expect, it } from 'vitest';
import { plantState } from '../src';

const add = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const START = '2026-01-01';

describe('Цветок: платёжная дисциплина', () => {
  it('в день запуска — росток, здоров', () => {
    const s = plantState({ today: START, start: START, paymentDates: [], hasDebt: true });
    expect(s).toMatchObject({ stage: 1, mood: 'healthy', daysSincePayment: 0, lastPaymentDate: null });
  });

  it('при регулярных платежах растёт каждый день и доходит до цветения', () => {
    const pays = Array.from({ length: 60 }, (_, i) => add(START, i * 7)); // каждую неделю
    const young = plantState({ today: add(START, 5), start: START, paymentDates: pays, hasDebt: true });
    const mid = plantState({ today: add(START, 20), start: START, paymentDates: pays, hasDebt: true });
    const old = plantState({ today: add(START, 60), start: START, paymentDates: pays, hasDebt: true });
    expect(young.growthDays).toBe(6); expect(mid.growthDays).toBe(21);
    expect(young.stage).toBeLessThan(mid.stage); expect(mid.stage).toBeLessThan(old.stage);
    expect(old).toMatchObject({ stage: 5, mood: 'healthy' });
  });

  it('без платежей: 10 дней здоров, потом хочет пить, вянет и погибает на 25-й день', () => {
    const at = (n: number) => plantState({ today: add(START, n), start: START, paymentDates: [], hasDebt: true });
    expect(at(10).mood).toBe('healthy'); expect(at(11).mood).toBe('thirsty'); expect(at(17).mood).toBe('thirsty');
    expect(at(18).mood).toBe('wilting'); expect(at(24).mood).toBe('wilting');
    expect(at(25)).toMatchObject({ mood: 'dead', growthDays: 0, stage: 1, daysToNextMood: null });
    expect(at(11).growthDays).toBe(11); // рост до этого дня сохранён и стоит
    expect(at(14).growthDays).toBe(11);
    expect(at(20).growthDays).toBe(8); // вянет: −1 за каждый из дней 18, 19, 20
  });

  it('платёж оживляет: после гибели новый платёж сажает росток заново', () => {
    const s = plantState({ today: add(START, 40), start: START, paymentDates: [add(START, 40)], hasDebt: true });
    expect(s.mood).toBe('healthy');
    expect(s.growthDays).toBe(1); // рост начат с нуля
    expect(s.stage).toBe(1);
  });

  it('нет долга — цветок спокоен независимо от платежей', () => {
    expect(plantState({ today: add(START, 100), start: START, paymentDates: [], hasDebt: false })).toMatchObject({ mood: 'healthy', daysToNextMood: null });
  });

  it('повторные и будущие даты платежей не ломают расчёт', () => {
    const s = plantState({ today: add(START, 3), start: START, paymentDates: [START, START, add(START, 50)], hasDebt: true });
    expect(s.lastPaymentDate).toBe(START);
    expect(s.growthDays).toBe(4);
  });

  it('сообщение объясняет причину и срок', () => {
    expect(plantState({ today: add(START, 20), start: START, paymentDates: [], hasDebt: true }).message).toMatch(/погибнет через 5 дн\./);
  });
});
