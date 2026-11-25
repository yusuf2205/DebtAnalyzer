import type { ParsedRow } from './types';

export interface RowChange {
  identityKey: string;
  before: ParsedRow;
  after: ParsedRow;
  fields: { field: 'amount' | 'openingPaid' | 'currency' | 'project' | 'executor' | 'plan'; from: string | null; to: string | null }[];
  /** Изменение «Оплачено» — всегда требует сверки с платежами приложения, автоматически не применяется. */
  requiresReconciliation: boolean;
}

export interface BatchDiff { added: ParsedRow[]; removed: ParsedRow[]; changed: RowChange[]; unchanged: number; }

const planKey = (r: ParsedRow) => JSON.stringify(r.plan.map((p) => [p.month, p.week, p.amount]));

/** Сравнение двух импортов одного источника по ключу идентичности строки (поставщик|договор|товар#n). */
export function diffBatches(prev: ParsedRow[], next: ParsedRow[]): BatchDiff {
  const importable = (r: ParsedRow) => r.status === 'OK' || r.status === 'WARNING';
  const a = new Map(prev.filter(importable).map((r) => [r.identityKey, r]));
  const b = new Map(next.filter(importable).map((r) => [r.identityKey, r]));
  const added: ParsedRow[] = [], removed: ParsedRow[] = [], changed: RowChange[] = [];
  let unchanged = 0;
  for (const [k, after] of b) {
    const before = a.get(k);
    if (!before) { added.push(after); continue; }
    const fields: RowChange['fields'] = [];
    const cmp = (field: RowChange['fields'][number]['field'], x: string | null, y: string | null) => { if (x !== y) fields.push({ field, from: x, to: y }); };
    cmp('amount', before.amount, after.amount);
    cmp('openingPaid', before.openingPaid, after.openingPaid);
    cmp('currency', before.currency, after.currency);
    cmp('project', before.project, after.project);
    cmp('executor', before.executor, after.executor);
    cmp('plan', planKey(before), planKey(after));
    if (fields.length) changed.push({ identityKey: k, before, after, fields, requiresReconciliation: fields.some((f) => f.field === 'openingPaid' || f.field === 'amount' || f.field === 'currency') });
    else unchanged++;
  }
  for (const [k, before] of a) if (!b.has(k)) removed.push(before);
  return { added, removed, changed, unchanged };
}
