import type { RateUsed } from '@pf/shared';

export type ColType = 'text' | 'int' | 'money' | 'date' | 'rate' | 'percent';
export interface Column { key: string; header: string; type: ColType; width: number }
export type Cellv = string | number | null;
export type Row = Record<string, Cellv>;

export interface ReportResult {
  id: string;
  title: string;
  description: string;
  asOf: string;
  generatedAt: string;
  /** Человекочитаемые условия отбора — попадают в шапку Excel/PDF. */
  filters: string[];
  columns: Column[];
  rows: Row[];
  totals: Row[];
  rates: { used: RateUsed[]; missing: string[] };
  warnings: string[];
}

export interface ReportInfo { id: string; title: string; description: string }

export const CATALOG: ReportInfo[] = [
  { id: 'total-debt', title: 'Общая задолженность', description: 'Договоры, оплаты и долг по валютам, эквивалент в USD' },
  { id: 'debt-by-supplier', title: 'Долги по поставщикам', description: 'Долг по каждому поставщику в разрезе валют' },
  { id: 'debt-by-contract', title: 'Долги по договорам', description: 'Остаток задолженности по каждому договору' },
  { id: 'payments', title: 'Фактические оплаты', description: 'Подтверждённые платежи за период (оплаты, возвраты, сторно)' },
  { id: 'plan', title: 'План платежей', description: 'Плановые платежи по неделям за период' },
  { id: 'plan-vs-fact', title: 'План против факта', description: 'План, факт, остаток плана и сверх плана по договорам и месяцам' },
  { id: 'overdue', title: 'Просроченные платежи', description: 'Невыполненный план прошедших недель (не больше долга)' },
  { id: 'overpayments', title: 'Переплаты', description: 'Договоры, оплаченные сверх суммы' },
  { id: 'debt-by-project', title: 'Долги по проектам', description: 'Долг в разрезе проектов и валют' },
  { id: 'debt-by-executor', title: 'Долги по исполнителям', description: 'Долг в разрезе ответственных сотрудников и валют' },
  { id: 'supplier-statement', title: 'Акт сверки с контрагентом', description: 'Договоры одного контрагента: сумма, оплата по таблице, платежи приложения, остаток — для сверки и подписи (выберите контрагента)' },
  { id: 'currency-analytics', title: 'Валютная аналитика', description: 'Структура портфеля по валютам, использованные курсы, доля в долге' },
];
