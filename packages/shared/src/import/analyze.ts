import { createHash } from 'node:crypto';
import { parseCurrency, type CurrencyCode } from '../currency';
import { D, dec, money, sum, type Dec } from '../money';
import { cleanDisplayName, extractTaxId, supplierExactKey, supplierMatchKey } from '../supplier-normalize';
import { findDates } from './dates';
import { detectLayout } from './layout';
import { findRateConflicts, scanControlTotals, scanRates } from './rates';
import { addr } from './reader';
import type {
  AnalysisResult, Cell, ControlCheck, Issue, IssueCode, IssueSeverity, LayoutMapping, Overrides,
  ParsedRow, PlanCell, SheetData, SupplierGroup, SupplierSuggestion,
} from './types';

const SERVICE_MARKER = /^(курс валют|итоговые суммы|общ\.?\s*сумма|итоговая задолженность|итого\b|всего\b)/i;
const NOTE_TEMPLATE_LABELS = /(дата готовности производства|дата прибытия на склад|условия поставки)\s*:?/gi;
const MAX_RAW_COLS = 60;

const norm = (s: string | null) => (s ?? '').toLowerCase().replace(/[^a-zа-яё0-9]/gi, '');

function text(c: Cell): string | null {
  if (c.kind === 'empty' || c.kind === 'error') return null;
  if (c.kind === 'date') return (c.value as Date).toISOString().slice(0, 10);
  const s = String(c.value).trim();
  return s === '' ? null : s;
}

/** «1 234,56» / «1234.56» -> Decimal; всё остальное — null (не угадываем). */
function parseNumberText(s: string): Dec | null {
  const t = s.replace(/[\s ]/g, '');
  if (/^-?\d+(\.\d+)?$/.test(t)) return dec(t);
  if (/^-?\d+,\d+$/.test(t)) return dec(t.replace(',', '.'));
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) return dec(t.replace(/,/g, ''));
  return null;
}

type NumRead =
  | { ok: true; value: Dec; viaText: boolean }
  | { ok: true; value: null; viaText: false } // пусто
  | { ok: false; reason: 'error' | 'nocache' | 'text'; detail: string };

function readNumber(c: Cell): NumRead {
  if (c.kind === 'number') return { ok: true, value: dec(c.value as number), viaText: false };
  if (c.kind === 'error') return { ok: false, reason: 'error', detail: c.error ?? '#ERR' };
  if (c.kind === 'empty') {
    if (c.formula && c.noCachedValue) return { ok: false, reason: 'nocache', detail: c.formula };
    return { ok: true, value: null, viaText: false };
  }
  if (c.kind === 'string') {
    const n = parseNumberText(String(c.value));
    return n ? { ok: true, value: n, viaText: true } : { ok: false, reason: 'text', detail: String(c.value) };
  }
  return { ok: false, reason: 'text', detail: String(c.value) };
}

function isContentCell(c: Cell) { return c.kind !== 'empty' || !!c.formula; }

export interface AnalyzeOptions {
  mapping?: LayoutMapping;
  overrides?: Overrides;
  /** Все листы книги — для поиска блоков курсов и контрольных итогов. */
  allSheets?: SheetData[];
}

export function analyzeSheet(sheet: SheetData, opts: AnalyzeOptions = {}): AnalysisResult {
  const mapping = opts.mapping ?? detectLayout(sheet);
  if (!mapping) throw new Error(`На листе «${sheet.name}» не найдена строка заголовков (Номер контракта / Сумма / Валюта).`);
  const overrides = opts.overrides ?? {};
  const F = mapping.fields;
  const col = (k: keyof typeof F) => F[k];
  const get = (r: number, k: keyof typeof F): Cell => (col(k) ? sheet.cell(r, col(k)!) : { kind: 'empty', value: null });

  // 1) Служебный блок (курсы/итоги) — всё от первого маркера и до конца листа.
  let serviceStart = 0;
  for (let r = mapping.headerRow + 1; r <= sheet.rowCount && !serviceStart; r++) {
    for (let c = 2; c <= 7; c++) {
      const cell = sheet.cell(r, c);
      if (cell.kind === 'string' && SERVICE_MARKER.test(String(cell.value).trim())) { serviceStart = r; break; }
    }
  }

  const rows: ParsedRow[] = [];
  const allIssues: Issue[] = [];
  let templateCount = 0, serviceCount = 0, scanned = 0;
  let tplMin = 0, tplMax = 0;

  for (let r = mapping.headerRow + 1; r <= sheet.rowCount; r++) {
    // Строка вообще без содержимого — пропускаем без учёта.
    let any = false;
    for (let c = 1; c <= Math.min(sheet.colCount, MAX_RAW_COLS) && !any; c++) any = isContentCell(sheet.cell(r, c));
    if (!any) continue;
    scanned++;

    if (serviceStart && r >= serviceStart) { serviceCount++; continue; }

    const supplierC = get(r, 'supplier'), contractC = get(r, 'contractNo'), amountC = get(r, 'amount');
    const goodsC = get(r, 'goods'), projectC = get(r, 'project'), paidC = get(r, 'paid'), currencyC = get(r, 'currency');
    const significant = [supplierC, contractC, amountC, goodsC, projectC, paidC, currencyC].some((c) => c.kind !== 'empty' && !(c.kind === 'error'));
    const significantErr = [supplierC, contractC, amountC, paidC].some((c) => c.kind === 'error');
    if (!significant && !significantErr) {
      // Шаблонная строка: нет ни поставщика, ни суммы, ни договора (например, заготовки с #REF! в колонке-индексе).
      templateCount++; if (!tplMin) tplMin = r; tplMax = r;
      continue;
    }

    const issues: Issue[] = [];
    const add = (code: IssueCode, severity: IssueSeverity, message: string, c?: number, original?: string) => {
      const i: Issue = { code, severity, row: r, message, cell: c ? addr(r, c) : undefined, original };
      issues.push(i);
    };

    // Сырые значения (без потерь).
    const raw: ParsedRow['raw'] = {};
    for (let c = 1; c <= Math.min(sheet.colCount, MAX_RAW_COLS); c++) {
      const cell = sheet.cell(r, c);
      if (!isContentCell(cell)) continue;
      const v = cell.kind === 'error' ? cell.error! : cell.kind === 'date' ? (cell.value as Date).toISOString() : (cell.value as any);
      raw[addr(r, c)] = { v: v ?? null, ...(cell.formula ? { f: cell.formula } : {}) };
    }

    // Поставщик
    const supplierRaw = text(supplierC);
    const supplierDisplay = supplierRaw ? cleanDisplayName(supplierRaw) : null;
    if (supplierC.kind === 'error') add('EXCEL_ERROR_CELL', 'error', `Ошибка Excel в ячейке поставщика: ${supplierC.error}`, col('supplier'), supplierC.error);
    else if (!supplierDisplay) add('MISSING_SUPPLIER', 'error', 'Не указан поставщик', col('supplier'));

    // Договор
    const contractNoRaw = text(contractC);
    if (contractC.kind === 'error') add('EXCEL_ERROR_CELL', 'error', `Ошибка Excel в номере договора: ${contractC.error}`, col('contractNo'), contractC.error);
    else if (!contractNoRaw) add('MISSING_CONTRACT_NO', 'warning', 'Не указан номер договора', col('contractNo'));
    const dates = contractNoRaw ? findDates(contractNoRaw) : [];
    const contractDate = dates.length === 1 ? dates[0] : null;
    if (dates.length > 1) add('CONTRACT_DATE_AMBIGUOUS', 'info', `В номере договора несколько дат (${dates.join(', ')}) — дата договора не определена автоматически`, col('contractNo'), contractNoRaw ?? undefined);

    // Сумма контракта
    let amount: Dec | null = null;
    const ar = readNumber(amountC);
    if (!ar.ok) {
      if (ar.reason === 'error') add('EXCEL_ERROR_CELL', 'error', `Ошибка Excel в сумме контракта: ${ar.detail}`, col('amount'), ar.detail);
      else if (ar.reason === 'nocache') add('FORMULA_NO_CACHE', 'error', 'Формула суммы без сохранённого результата', col('amount'), ar.detail);
      else add('NON_NUMERIC_AMOUNT', 'error', `Сумма контракта не является числом: «${ar.detail}»`, col('amount'), ar.detail);
    } else if (ar.value === null) add('MISSING_AMOUNT', 'error', 'Не указана сумма контракта', col('amount'));
    else {
      amount = ar.value;
      if (ar.viaText) add('NUMERIC_TEXT', 'warning', 'Сумма записана текстом и преобразована в число', col('amount'), String(amountC.value));
      if (amount.lt(0)) add('NEGATIVE_AMOUNT', 'error', 'Отрицательная сумма контракта', col('amount'), amount.toString());
      if (!money(amount).eq(amount)) add('AMOUNT_PRECISION', 'warning', `Сумма содержит более 2 знаков (${amount.toString()}); при сохранении округлена до ${money(amount).toFixed(2)}`, col('amount'), amount.toString());
    }

    // Оплачено (историческая оплата -> OpeningPaid)
    let paid: Dec | null = null;
    const pr = readNumber(paidC);
    if (!pr.ok) {
      if (pr.reason === 'error') add('EXCEL_ERROR_CELL', 'error', `Ошибка Excel в «Оплачено»: ${pr.detail}`, col('paid'), pr.detail);
      else if (pr.reason === 'nocache') add('FORMULA_NO_CACHE', 'error', 'Формула «Оплачено» без сохранённого результата', col('paid'), pr.detail);
      else add('PAID_NON_NUMERIC', 'error', `«Оплачено» не является числом: «${pr.detail}»`, col('paid'), pr.detail);
    } else if (pr.value === null) {
      paid = dec(0);
      if (amount) add('PAID_EMPTY_AS_ZERO', 'info', 'Поле «Оплачено» пусто — начальный оплаченный остаток принят равным 0', col('paid'));
    } else {
      paid = pr.value;
      if (pr.viaText) add('NUMERIC_TEXT', 'warning', '«Оплачено» записано текстом и преобразовано в число', col('paid'), String(paidC.value));
      if (paid.lt(0)) add('NEGATIVE_AMOUNT', 'error', '«Оплачено» отрицательно', col('paid'), paid.toString());
      if (paidC.formula) add('PAID_FORMULA', 'info', `«Оплачено» — формула (${paidC.formula}); использован сохранённый результат`, col('paid'), paidC.formula);
    }
    if (amount && paid && paid.gt(amount)) add('OVERPAID', 'warning', 'Оплачено больше суммы контракта (переплата)', col('paid'), paid.toString());

    // Остаток из источника — только для сверки
    const dc = get(r, 'debt');
    const debtSrc = dc.kind === 'number' ? dec(dc.value as number) : null;
    if (amount && paid && (col('debt'))) {
      const expected = amount.minus(paid);
      const srcVal = debtSrc ?? dec(0);
      if (expected.minus(srcVal).abs().gt('0.01')) {
        add('DEBT_MISMATCH', 'warning', `Остаток в источнике (${debtSrc ? debtSrc.toString() : 'пусто'}) не равен «Сумма − Оплачено» (${money(expected).toFixed(2)}); в расчёте используется «Сумма − Оплачено»`, col('debt'), debtSrc ? debtSrc.toString() : '');
      }
    }

    // Валюта
    const currencyRaw = text(currencyC);
    let currency: CurrencyCode | null = null;
    const pc = parseCurrency(currencyRaw);
    if (pc.code) {
      currency = pc.code;
      if (pc.aliasUsed) add('CURRENCY_ALIAS', 'warning', `Написание валюты «${currencyRaw}» приведено к ${pc.code}`, col('currency'), currencyRaw ?? undefined);
    } else if (pc.unknown) add('UNKNOWN_CURRENCY', 'error', `Неизвестная валюта «${currencyRaw}»`, col('currency'), currencyRaw ?? undefined);
    else if (amount) add('MISSING_CURRENCY', 'error', 'Не указана валюта у договора с суммой — выберите валюту вручную в предпросмотре', col('currency'));
    const ov = overrides[r];
    if (ov?.currency && !currency) {
      currency = ov.currency;
      for (let i = issues.length - 1; i >= 0; i--) if (issues[i].code === 'MISSING_CURRENCY' || issues[i].code === 'UNKNOWN_CURRENCY') issues.splice(i, 1);
      add('CURRENCY_MANUAL', 'info', `Валюта задана вручную: ${ov.currency}`, col('currency'), currencyRaw ?? '');
    }

    // План по неделям
    const plan: PlanCell[] = [];
    const planNotes: string[] = [];
    for (const wc of mapping.weekColumns) {
      const cell = sheet.cell(r, wc.col);
      if (!isContentCell(cell)) continue;
      if (cell.kind === 'number' && typeof cell.value === 'number') {
        if (cell.value !== 0) plan.push({ month: wc.month, week: wc.week, amount: dec(cell.value).toString(), cell: addr(r, wc.col), ...(cell.formula ? { formula: cell.formula } : {}) });
      } else if (cell.kind === 'string') {
        const t = String(cell.value).trim();
        if (t && !planNotes.includes(t)) planNotes.push(t);
      } else if (cell.kind === 'error') add('EXCEL_ERROR_CELL', 'warning', `Ошибка Excel в плане недели: ${cell.error} (ячейка исключена)`, wc.col, cell.error);
    }
    if (planNotes.length) add('WEEK_TEXT_NOTE', 'info', 'В недельных колонках текст вместо сумм — сохранён как примечание к плану', undefined, planNotes.join(' | '));
    // Примечание: шаблонная заготовка без заполненных полей — не примечание.
    let notes = text(get(r, 'notes'));
    if (notes && notes.replace(NOTE_TEMPLATE_LABELS, '').replace(/[\s:]/g, '') === '') notes = null;

    const goods = text(goodsC);
    const contractNoNorm = norm(contractNoRaw) || null;
    const exact = supplierDisplay ? supplierExactKey(supplierDisplay) : null;
    const baseKey = `${exact ?? ''}|${contractNoNorm ?? ''}|${norm(goods)}`;
    const amountStr = amount ? money(amount).toFixed(2) : null;
    const paidStr = paid ? money(paid).toFixed(2) : null;
    const executor = text(get(r, 'executor'));
    const project = text(projectC);

    rows.push({
      rowNumber: r, status: 'OK', project, contractNoRaw, contractNoNorm, contractDate, contractDateCandidates: dates,
      supplierRaw, supplierDisplay, supplierExactKey: exact,
      supplierMatchKey: supplierDisplay ? supplierMatchKey(supplierDisplay) : null,
      supplierTaxId: supplierDisplay ? extractTaxId(supplierDisplay) : null,
      goods, currencyRaw, currency, amount: amountStr, amountRaw: amountC.kind === 'empty' ? null : String(amountC.kind === 'error' ? amountC.error : amountC.value),
      openingPaid: paidStr, openingPaidRaw: paidC.kind === 'empty' ? null : String(paidC.kind === 'error' ? paidC.error : paidC.value), openingPaidFormula: paidC.formula ?? null,
      debtSource: debtSrc ? debtSrc.toString() : null, plan, planNotes, notes, executor, issues, raw,
      fingerprint: createHash('sha256').update(JSON.stringify([exact, contractNoNorm, norm(goods), amountStr, currency, paidStr, norm(project), norm(executor)])).digest('hex'),
      identityKey: baseKey,
    });
  }

  // 2) Дубликаты: одинаковая идентичность + сумма + валюта + оплачено -> точный дубль (по умолчанию не импортируется).
  const seen = new Map<string, number>();
  const seenBase = new Map<string, number>();
  for (const row of rows) {
    const full = `${row.identityKey}|${row.amount}|${row.currency}|${row.openingPaid}`;
    const prior = seen.get(full);
    if (prior !== undefined && row.supplierExactKey) {
      row.duplicateOfRow = prior;
      row.issues.push({ code: 'DUPLICATE_ROW', severity: 'warning', row: row.rowNumber, message: `Точный дубль строки ${prior} (тот же поставщик, договор, товар, сумма)` });
    } else {
      if (row.supplierExactKey) seen.set(full, row.rowNumber);
      const b = seenBase.get(row.identityKey);
      if (b !== undefined && row.supplierExactKey && row.contractNoNorm) {
        row.issues.push({ code: 'DUPLICATE_ROW', severity: 'info', row: row.rowNumber, message: `Тот же поставщик/договор/товар, что в строке ${b}, но другие суммы — возможна отдельная спецификация` });
      } else if (row.supplierExactKey) seenBase.set(row.identityKey, row.rowNumber);
    }
  }
  // Уникальность ключа идентичности между импортами: добавляем порядковый номер вхождения.
  const occ = new Map<string, number>();
  for (const row of rows) { const n = (occ.get(row.identityKey) ?? 0) + 1; occ.set(row.identityKey, n); if (n > 1) row.identityKey = `${row.identityKey}#${n}`; }

  // 3) Статусы + overrides
  for (const row of rows) {
    const hasErr = row.issues.some((i) => i.severity === 'error');
    const hasWarn = row.issues.some((i) => i.severity === 'warning' && i.code !== 'DUPLICATE_ROW');
    const exactDup = row.duplicateOfRow !== undefined;
    const ov = overrides[row.rowNumber];
    if (hasErr) row.status = 'BLOCKED';
    else if (ov?.include === false) row.status = 'EXCLUDED';
    else if (exactDup && ov?.include !== true) row.status = 'DUPLICATE';
    else row.status = hasWarn || (exactDup) ? 'WARNING' : 'OK';
    allIssues.push(...row.issues);
  }

  // 4) Итоги
  const importable = rows.filter((r) => r.status === 'OK' || r.status === 'WARNING');
  const totals: Record<string, { amount: Dec; paid: Dec; rows: number }> = {};
  for (const r of importable) {
    const k = r.currency as string;
    const t = (totals[k] ??= { amount: new D(0), paid: new D(0), rows: 0 });
    t.amount = t.amount.plus(r.amount!); t.paid = t.paid.plus(r.openingPaid!); t.rows++;
  }
  const totalsByCurrency = Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, {
    amount: money(v.amount).toFixed(2), paid: money(v.paid).toFixed(2), debt: money(v.amount.minus(v.paid)).toFixed(2), rows: v.rows,
  }]));

  // Остаток строк без валюты (в источнике они выпадают из SUMIFS по валюте)
  const noCur = rows.filter((r) => !r.currency && r.amount && r.openingPaid);
  const ncAmount = sum(noCur.map((r) => r.amount!)), ncPaid = sum(noCur.map((r) => r.openingPaid!));
  const debtWithoutCurrency = { rows: noCur.length, amount: money(ncAmount).toFixed(2), paid: money(ncPaid).toFixed(2), debt: money(ncAmount.minus(ncPaid)).toFixed(2) };

  // Контрольные итоги источника
  const sheets = opts.allSheets ?? [sheet];
  const rates = scanRates(sheets);
  const controlTotals = scanControlTotals(sheets);
  const seenCtl = new Set<string>();
  const controlChecks: ControlCheck[] = [];
  for (const ct of controlTotals) {
    if (seenCtl.has(ct.currency)) continue; seenCtl.add(ct.currency);
    // Сравниваем со ВСЕМИ строками данных, у которых источник использовал бы эту валюту (включая заблокированные), т.к. SUMIFS источника ничего не блокирует.
    const all = rows.filter((r) => r.currency === ct.currency && r.amount && r.openingPaid);
    const computed = sum(all.map((r) => dec(r.amount!).minus(r.openingPaid!)));
    const diff = computed.minus(ct.sourceValue);
    controlChecks.push({ currency: ct.currency, source: ct.sourceValue, computed: money(computed).toFixed(2), diff: money(diff).toFixed(2), match: diff.abs().lte(dec(ct.sourceValue).abs().times('1e-8').plus('0.01')) });
  }

  // Поставщики
  const spell = new Map<string, Map<string, number>>();
  for (const r of rows) if (r.supplierRaw && r.supplierExactKey) {
    const m = spell.get(r.supplierExactKey) ?? new Map<string, number>(); m.set(r.supplierRaw, (m.get(r.supplierRaw) ?? 0) + 1); spell.set(r.supplierExactKey, m);
  }
  const supplierGroups: SupplierGroup[] = [...spell.entries()].map(([exactKey, m]) => ({ exactKey, spellings: [...m.entries()].map(([raw, count]) => ({ raw, count })) }));
  const byMatch = new Map<string, SupplierGroup[]>();
  for (const g of supplierGroups) { const mk = supplierMatchKey(g.exactKey); if (mk) byMatch.set(mk, [...(byMatch.get(mk) ?? []), g]); }
  const supplierSuggestions: SupplierSuggestion[] = [...byMatch.entries()].filter(([, g]) => g.length > 1).map(([matchKey, g]) => ({ matchKey, groups: g.map((x) => x.exactKey), spellings: g.flatMap((x) => x.spellings.map((s) => s.raw)) }));

  const issueCounts: AnalysisResult['summary']['issueCounts'] = {};
  for (const i of allIssues) issueCounts[i.code] = (issueCounts[i.code] ?? 0) + 1;

  return {
    sheet: sheet.name, mapping, rows, issues: allIssues,
    summary: {
      totalRowsScanned: scanned, dataRows: rows.length, importable: importable.length,
      warnings: rows.filter((r) => r.status === 'WARNING').length, blocked: rows.filter((r) => r.status === 'BLOCKED').length,
      duplicates: rows.filter((r) => r.status === 'DUPLICATE').length,
      skippedTemplate: templateCount, skippedService: serviceCount,
      templateRange: templateCount ? [tplMin, tplMax] : null, serviceRange: serviceCount ? [serviceStart, sheet.rowCount] : null,
      issueCounts, totalsByCurrency,
      distinctSupplierSpellings: new Set(rows.map((r) => r.supplierRaw).filter(Boolean)).size,
      distinctSupplierExact: spell.size,
      planOnSettledRows: rows.filter((r) => r.plan.length && r.amount && r.openingPaid && dec(r.amount).minus(r.openingPaid).lte(0)).length,
    },
    rates, rateConflicts: findRateConflicts(rates), controlTotals, controlChecks, debtWithoutCurrency, supplierGroups, supplierSuggestions,
  };
}
