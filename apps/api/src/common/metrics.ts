import { computeDebt, CURRENCIES, dec, money, sum, type Dec } from '@pf/shared';
import type { PrismaService } from '../prisma/prisma.service';

export interface MetricInput {
  currency: string;
  amount: { toString(): string };
  openingPaid: { toString(): string };
  planned?: Dec | string | null;
  /** Чистая сумма подтверждённых платежей приложения, ещё не учтённых в начальном остатке (+платежи, −возвраты/сторно). */
  newPaid?: { toString(): string } | null;
}

export interface CurrencyTotals {
  currency: string; contracts: number; amount: string; paid: string; debt: string; overpaid: string; planned: string;
}

export function contractDebt(c: MetricInput) {
  // Debt = Сумма − НачальнаяОплата − НовыеПодтверждённыеПлатежи (ещё не отражённые в начальном остатке).
  const net = dec(c.newPaid?.toString() ?? '0');
  return computeDebt({
    contractAmount: c.amount.toString(), openingPaid: c.openingPaid.toString(),
    payments: net.isZero() ? [] : [{ amount: net.abs(), status: 'APPROVED', kind: net.gt(0) ? 'PAYMENT' : 'REFUND' }],
  });
}

/** Итоги строго по валютам — разные валюты никогда не суммируются. Переплаты показываются отдельно и не гасят долг других договоров. */
export function summarize(items: MetricInput[]): CurrencyTotals[] {
  const out: CurrencyTotals[] = [];
  for (const cur of CURRENCIES) {
    const rows = items.filter((i) => i.currency === cur);
    if (!rows.length) continue;
    const d = rows.map(contractDebt);
    out.push({
      currency: cur, contracts: rows.length,
      amount: money(sum(d.map((x) => x.contractAmount))).toFixed(2),
      paid: money(sum(d.map((x) => x.totalPaid))).toFixed(2),
      debt: money(sum(d.map((x) => x.debt))).toFixed(2),
      overpaid: money(sum(d.map((x) => x.overpaid))).toFixed(2),
      planned: money(sum(rows.map((r) => dec(r.planned?.toString() ?? '0')))).toFixed(2),
    });
  }
  return out;
}

/** Чистое влияние подтверждённых платежей по договорам. Единственный источник «новой оплаты» для всех расчётов долга. */
export async function netPaidMap(prisma: Pick<PrismaService, 'payment'>, contractIds?: string[]): Promise<Map<string, Dec>> {
  const rows = await prisma.payment.groupBy({
    by: ['contractId'], _sum: { signedAmount: true },
    where: { status: 'APPROVED', reflectedInOpening: false, ...(contractIds ? { contractId: { in: contractIds } } : {}) },
  });
  return new Map(rows.map((r) => [r.contractId, dec(r._sum.signedAmount?.toString() ?? '0')]));
}
