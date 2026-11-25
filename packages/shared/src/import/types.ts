import type { CurrencyCode } from '../currency';

export type CellKind = 'empty' | 'number' | 'string' | 'date' | 'boolean' | 'error';

export interface Cell {
  kind: CellKind;
  value: number | string | boolean | Date | null;
  /** Текст формулы (если ячейка — формула). Для shared-формул ведомых ячеек — ссылка на мастер. */
  formula?: string;
  /** Текст ошибки Excel (#REF!, #N/A ...), если значение или результат формулы — ошибка. */
  error?: string;
  /** Формула без сохранённого результата — значение недоступно. */
  noCachedValue?: boolean;
}

/** Единая модель листа для XLSX, CSV и (позже) Google Sheets. Номера строк/столбцов — с 1. */
export interface SheetData {
  name: string;
  hidden: boolean;
  rowCount: number;
  colCount: number;
  merges: string[];
  cell(row: number, col: number): Cell;
}

export interface SheetInfo {
  name: string;
  hidden: boolean;
  rowCount: number;
  colCount: number;
  nonEmptyCells: number;
  /** Лист без данных (например, скрытый пустой «Лист4») — не считается финансовым источником. */
  empty: boolean;
}

export type FieldKey =
  | 'project' | 'contractNo' | 'supplier' | 'goods' | 'amount' | 'paid' | 'debt'
  | 'currency' | 'notes' | 'executor';

export interface WeekColumn { col: number; month: number; week: 1 | 2 | 3 | 4; }

export interface LayoutMapping {
  headerRow: number;
  fields: Partial<Record<FieldKey, number>>;
  weekColumns: WeekColumn[];
  /** Обязательные поля, которые не удалось распознать. */
  missing: FieldKey[];
}

export type IssueSeverity = 'error' | 'warning' | 'info';

export type IssueCode =
  | 'EXCEL_ERROR_CELL' | 'FORMULA_NO_CACHE' | 'MISSING_SUPPLIER' | 'MISSING_AMOUNT' | 'NON_NUMERIC_AMOUNT'
  | 'NUMERIC_TEXT' | 'MISSING_CURRENCY' | 'UNKNOWN_CURRENCY' | 'CURRENCY_ALIAS' | 'MISSING_CONTRACT_NO'
  | 'AMOUNT_PRECISION' | 'PAID_EMPTY_AS_ZERO' | 'PAID_FORMULA' | 'PAID_NON_NUMERIC' | 'OVERPAID' | 'DEBT_MISMATCH'
  | 'NEGATIVE_AMOUNT' | 'DUPLICATE_ROW' | 'WEEK_TEXT_NOTE' | 'WEEK_NON_NUMERIC'
  | 'CONTRACT_DATE_AMBIGUOUS' | 'CURRENCY_MANUAL';

export interface Issue {
  code: IssueCode;
  severity: IssueSeverity;
  row: number;
  /** Адрес ячейки, например "H59". */
  cell?: string;
  message: string;
  /** Исходное значение, как оно лежит в файле. */
  original?: string;
}

/**
 * OK — импортируется без замечаний; WARNING — импортируется, есть замечания;
 * BLOCKED — не импортируется, пока пользователь не исправит данные (например, не выберет валюту);
 * DUPLICATE — точный дубль, по умолчанию не импортируется.
 */
export type RowStatus = 'OK' | 'WARNING' | 'BLOCKED' | 'DUPLICATE' | 'EXCLUDED';

export interface PlanCell { month: number; week: 1 | 2 | 3 | 4; amount: string; cell: string; formula?: string; }

export interface ParsedRow {
  rowNumber: number;
  status: RowStatus;
  project: string | null;
  contractNoRaw: string | null;
  contractNoNorm: string | null;
  /** Дата договора — только если однозначно определена из номера. */
  contractDate: string | null;
  contractDateCandidates: string[];
  supplierRaw: string | null;
  supplierDisplay: string | null;
  supplierExactKey: string | null;
  supplierMatchKey: string | null;
  supplierTaxId: string | null;
  goods: string | null;
  currencyRaw: string | null;
  currency: CurrencyCode | null;
  /** Суммы — строки Decimal (2 знака). null — не удалось определить. */
  amount: string | null;
  amountRaw: string | null;
  openingPaid: string | null;
  openingPaidRaw: string | null;
  openingPaidFormula: string | null;
  debtSource: string | null;
  plan: PlanCell[];
  planNotes: string[];
  notes: string | null;
  executor: string | null;
  issues: Issue[];
  /** Все непустые ячейки строки как есть (адрес -> значение/формула) — для audit и повторной проверки. */
  raw: Record<string, { v: string | number | boolean | null; f?: string }>;
  /** sha256 нормализованных финансовых полей — для обнаружения изменений при повторной синхронизации. */
  fingerprint: string;
  /** Ключ идентичности строки между импортами. */
  identityKey: string;
  duplicateOfRow?: number;
}

export interface RateCandidate {
  sheet: string;
  currency: CurrencyCode;
  uzsPerUnit: string;
  /** Дата из заголовка блока курсов, ISO yyyy-mm-dd, если определена. */
  date: string | null;
  cell: string;
  label: string;
}

export interface RateConflict { currency: CurrencyCode; candidates: RateCandidate[]; }

export interface ControlTotal { currency: string; sourceValue: string; sheet: string; cell: string; }

/** Сравнение нашего пересчёта остатка (сумма − оплачено, со знаком) с итогом, который показывает сам источник. */
export interface ControlCheck { currency: string; source: string; computed: string; diff: string; match: boolean; }

export interface SupplierGroup { exactKey: string; spellings: { raw: string; count: number }[]; }
export interface SupplierSuggestion { matchKey: string; groups: string[]; spellings: string[]; }

export interface AnalysisSummary {
  totalRowsScanned: number;
  dataRows: number;
  importable: number;
  warnings: number;
  blocked: number;
  duplicates: number;
  skippedTemplate: number;
  skippedService: number;
  templateRange: [number, number] | null;
  serviceRange: [number, number] | null;
  issueCounts: Partial<Record<IssueCode, number>>;
  totalsByCurrency: Record<string, { amount: string; paid: string; debt: string; rows: number }>;
  distinctSupplierSpellings: number;
  distinctSupplierExact: number;
  /** Строки с суммами в недельных колонках при нулевом остатке: скорее история платежей, чем план — решает пользователь. */
  planOnSettledRows: number;
}

export interface AnalysisResult {
  sheet: string;
  mapping: LayoutMapping;
  rows: ParsedRow[];
  issues: Issue[];
  summary: AnalysisSummary;
  rates: RateCandidate[];
  rateConflicts: RateConflict[];
  controlTotals: ControlTotal[];
  controlChecks: ControlCheck[];
  /** Остаток по строкам без валюты: в итогах источника (SUMIFS по валюте) эти суммы не учитываются вообще. */
  debtWithoutCurrency: { rows: number; amount: string; paid: string; debt: string };
  supplierGroups: SupplierGroup[];
  supplierSuggestions: SupplierSuggestion[];
}

export interface RowOverride {
  currency?: CurrencyCode;
  /** true — исключить строку из импорта. false — включить даже точный дубль. */
  include?: boolean;
}
export type Overrides = Record<number, RowOverride>;
