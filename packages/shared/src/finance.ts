import { D, dec, money, sum, type Dec, type DecInput } from './money';

export type PaymentStatus = 'DRAFT' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
export type PaymentKind = 'PAYMENT' | 'REFUND' | 'REVERSAL';

export interface PaymentLike {
  amount: DecInput;
  status: PaymentStatus;
  kind?: PaymentKind;
  /** true — платёж уже учтён в импортированном «Оплачено» (подтверждено сверкой). Защита от двойного учёта. */
  reflectedInOpening?: boolean;
}

export interface DebtInput {
  contractAmount: DecInput;
  openingPaid: DecInput;
  payments?: PaymentLike[];
}

export interface DebtResult {
  contractAmount: Dec;
  openingPaid: Dec;
  newApprovedPaid: Dec;
  totalPaid: Dec;
  debt: Dec; // >= 0
  overpaid: Dec; // >= 0
  state: 'UNPAID' | 'PARTIAL' | 'PAID' | 'OVERPAID';
}

/**
 * Вклад платежа в «оплачено». Учитываются только APPROVED. PAYMENT добавляет, REFUND/REVERSAL вычитают.
 * Плановые платежи в эту функцию не передаются вообще — они не могут уменьшить долг.
 */
export function paymentEffect(p: PaymentLike): Dec {
  if (p.status !== 'APPROVED') return new D(0);
  if (p.reflectedInOpening) return new D(0);
  const a = dec(p.amount);
  if (a.lt(0)) throw new Error('Сумма платежа должна быть неотрицательной; знак задаётся типом операции');
  return (p.kind ?? 'PAYMENT') === 'PAYMENT' ? a : a.neg();
}

/** Debt = ContractAmount − OpeningPaid − NewApprovedPaymentsNotAlreadyReflectedInOpeningBalance */
export function computeDebt(input: DebtInput): DebtResult {
  const contractAmount = dec(input.contractAmount);
  const openingPaid = dec(input.openingPaid);
  const newApprovedPaid = sum((input.payments ?? []).map(paymentEffect));
  const totalPaid = openingPaid.plus(newApprovedPaid);
  const raw = contractAmount.minus(totalPaid);
  const debt = raw.gt(0) ? money(raw) : new D(0);
  const overpaid = raw.lt(0) ? money(raw.neg()) : new D(0);
  let state: DebtResult['state'];
  if (overpaid.gt(0)) state = 'OVERPAID';
  else if (debt.isZero()) state = 'PAID';
  else if (totalPaid.gt(0)) state = 'PARTIAL';
  else state = 'UNPAID';
  return { contractAmount, openingPaid, newApprovedPaid, totalPaid, debt, overpaid, state };
}
