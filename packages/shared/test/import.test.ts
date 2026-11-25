import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { analyzeSheet, detectLayout, diffBatches, findDates, readCsv, readWorkbook, readXlsx } from '../src/import';

const HEADERS = ['', '№', 'Проект', 'Номер контракта', 'Наименование контрагента', 'Наименования товара', 'Сумма контракта', 'Оплачено ', 'Остаток суммы\n(ДОЛГ)', 'Валюта'];

/** Собирает книгу с той же структурой, что и реальный реестр: месяцы/W1..W4 над заголовком, данные ниже. */
async function book(rows: any[][], extra?: (ws: ExcelJS.Worksheet) => void): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Реестр договоров');
  ws.getCell('K3').value = 'Июнь'; ws.getCell('L3').value = 'Июнь';
  ws.getCell('K4').value = 'W1'; ws.getCell('L4').value = 'W2';
  HEADERS.forEach((h, i) => { if (h) ws.getCell(5, i + 1).value = h; });
  ws.getCell('AM5').value = 'Примечание'; ws.getCell('AN5').value = 'Исполнитель';
  rows.forEach((r, i) => r.forEach((v, c) => { if (v !== undefined && v !== '') ws.getCell(6 + i, c + 1).value = v; }));
  extra?.(ws);
  wb.addWorksheet('Лист4').state = 'hidden';
  return Buffer.from(await wb.xlsx.writeBuffer());
}
// Остаток заполняется как в реальном реестре: =IF(G-H=0,"",G-H) — пусто только при нулевом остатке.
const row = (o: Partial<Record<'project' | 'no' | 'sup' | 'goods' | 'amount' | 'paid' | 'cur', any>>) => {
  const paid = typeof o.paid === 'number' ? o.paid : typeof o.paid === 'object' && o.paid ? o.paid.result : 0;
  const debt = typeof o.amount === 'number' && typeof paid === 'number' && o.amount - paid !== 0 ? o.amount - paid : undefined;
  return ['', 1, o.project ?? 'P1', o.no ?? 'Договор №1 от 01.02.2026', o.sup ?? 'ACME MCHJ', o.goods ?? 'Кабель', o.amount, o.paid, debt, o.cur];
};

const analyze = async (rows: any[][], extra?: (ws: ExcelJS.Worksheet) => void, overrides = {}) => {
  const sheets = await readXlsx(await book(rows, extra));
  return analyzeSheet(sheets[0], { allSheets: sheets, overrides });
};

describe('Import Engine: XLSX', () => {
  it('распознаёт заголовки, поля и недельные колонки', async () => {
    const sheets = await readXlsx(await book([row({ amount: 100, paid: 10, cur: 'USD' })]));
    const m = detectLayout(sheets[0])!;
    expect(m.headerRow).toBe(5);
    expect(m.fields).toMatchObject({ project: 3, contractNo: 4, supplier: 5, amount: 7, paid: 8, debt: 9, currency: 10 });
    expect(m.weekColumns).toEqual([{ col: 11, month: 6, week: 1 }, { col: 12, month: 6, week: 2 }]);
    expect(m.missing).toEqual([]);
  });

  it('скрытый пустой лист определяется как пустой', async () => {
    const sheets = await readXlsx(await book([]));
    const info = (await import('../src/import')).describeSheets(sheets);
    expect(info.find((s) => s.name === 'Лист4')).toMatchObject({ hidden: true, empty: true });
  });

  it('импортирует строку и сохраняет исходные значения без изменений', async () => {
    const a = await analyze([row({ amount: 1000, paid: 250.5, cur: 'USD' })]);
    const r = a.rows[0];
    expect(r.status).toBe('OK');
    expect(r.amount).toBe('1000.00');
    expect(r.openingPaid).toBe('250.50');
    expect(r.amountRaw).toBe('1000');
    expect(r.raw['G6'].v).toBe(1000);
    expect(r.contractDate).toBe('2026-02-01');
  });

  it('пустые значения: «Оплачено» пусто -> 0, но это фиксируется в отчёте', async () => {
    const a = await analyze([row({ amount: 500, cur: 'UZS' })]);
    expect(a.rows[0].openingPaid).toBe('0.00');
    expect(a.rows[0].issues.map((i) => i.code)).toContain('PAID_EMPTY_AS_ZERO');
  });

  it('формула «Оплачено»: берётся сохранённый результат, формула сохраняется', async () => {
    const a = await analyze([row({ amount: 100, paid: { formula: '60+40', result: 100 }, cur: 'USD' })]);
    expect(a.rows[0].openingPaid).toBe('100.00');
    expect(a.rows[0].openingPaidFormula).toBe('60+40');
    expect(a.rows[0].issues.map((i) => i.code)).toContain('PAID_FORMULA');
  });

  it('ошибка #REF! в сумме не попадает в расчёты: строка заблокирована', async () => {
    const a = await analyze([row({ amount: { formula: 'A1', result: { error: '#REF!' } }, paid: 0, cur: 'USD' })]);
    expect(a.rows[0].status).toBe('BLOCKED');
    expect(a.rows[0].amount).toBeNull();
    expect(a.rows[0].issues.map((i) => i.code)).toContain('EXCEL_ERROR_CELL');
    expect(a.summary.importable).toBe(0);
  });

  it('ошибка #REF! в «Оплачено» не превращается в 0', async () => {
    const a = await analyze([row({ amount: 100, paid: { formula: 'A1', result: { error: '#REF!' } }, cur: 'USD' })]);
    expect(a.rows[0].status).toBe('BLOCKED');
    expect(a.rows[0].openingPaid).toBeNull();
  });

  it('пустая валюта при наличии суммы блокирует строку; ручной выбор валюты разблокирует', async () => {
    const rows = [row({ amount: 100, paid: 0 })];
    expect((await analyze(rows)).rows[0].status).toBe('BLOCKED');
    const fixed = await analyze(rows, undefined, { 6: { currency: 'USD' } });
    expect(fixed.rows[0].status).toBe('OK');
    expect(fixed.rows[0].currency).toBe('USD');
    expect(fixed.rows[0].issues.map((i) => i.code)).toContain('CURRENCY_MANUAL');
  });

  it('неизвестная валюта: ошибка, не угадываем', async () => {
    const a = await analyze([row({ amount: 100, paid: 0, cur: 'GBP' })]);
    expect(a.rows[0].status).toBe('BLOCKED');
    expect(a.rows[0].issues.map((i) => i.code)).toContain('UNKNOWN_CURRENCY');
  });

  it('EURO -> EUR с предупреждением (не молчаливая правка)', async () => {
    const a = await analyze([row({ amount: 100, paid: 0, cur: 'EURO' })]);
    expect(a.rows[0].currency).toBe('EUR');
    expect(a.rows[0].currencyRaw).toBe('EURO');
    expect(a.rows[0].status).toBe('WARNING');
  });

  it('точный дубль помечается и по умолчанию не импортируется; можно включить вручную', async () => {
    const rows = [row({ amount: 100, paid: 0, cur: 'USD' }), row({ amount: 100, paid: 0, cur: 'USD' })];
    const a = await analyze(rows);
    expect(a.rows[1].status).toBe('DUPLICATE');
    expect(a.rows[1].duplicateOfRow).toBe(6);
    expect(a.summary.importable).toBe(1);
    const forced = await analyze(rows, undefined, { 7: { include: true } });
    expect(forced.rows[1].status).toBe('WARNING');
  });

  it('тот же договор, но другая сумма — не дубль', async () => {
    const a = await analyze([row({ amount: 100, paid: 0, cur: 'USD' }), row({ amount: 200, paid: 0, cur: 'USD' })]);
    expect(a.rows.map((r) => r.status)).toEqual(['OK', 'OK']);
    expect(new Set(a.rows.map((r) => r.identityKey)).size).toBe(2);
  });

  it('недельные колонки: числа -> план; текст -> примечание плана, не сумма', async () => {
    const a = await analyze([row({ amount: 1000, paid: 0, cur: 'USD' })], (ws) => {
      ws.getCell('K6').value = 400; ws.getCell('L6').value = 'Оплата по поручению руководства';
    });
    expect(a.rows[0].plan).toEqual([{ month: 6, week: 1, amount: '400', cell: 'K6' }]);
    expect(a.rows[0].planNotes).toEqual(['Оплата по поручению руководства']);
  });

  it('шаблонные строки (#REF! в индексе, пустая заготовка примечания) и блок курсов не импортируются как договоры', async () => {
    const a = await analyze([row({ amount: 100, paid: 0, cur: 'USD' })], (ws) => {
      for (let r = 7; r <= 9; r++) {
        ws.getCell(r, 2).value = { formula: 'B1', result: '#REF!' } as any;
        ws.getCell(r, 39).value = 'Дата готовности производства: \nДата прибытия на склад:    \nУсловия поставки:';
      }
      ws.getCell('B11').value = 'Курс валют на 20.08.2026'; ws.getCell('E12').value = 'Итоговые суммы по каждой валюте отдельно:';
      ws.getCell('B13').value = 'Евро'; ws.getCell('C13').value = 'Сумм'; ws.getCell('B14').value = 1; ws.getCell('C14').value = 13950;
      ws.getCell('B15').value = 'Доллар'; ws.getCell('C15').value = 'Сумм'; ws.getCell('B16').value = 1; ws.getCell('C16').value = 11850;
    });
    expect(a.summary.dataRows).toBe(1);
    expect(a.summary.skippedTemplate).toBe(3);
    expect(a.summary.skippedService).toBeGreaterThan(0);
    expect(a.rates.map((r) => `${r.currency}:${r.uzsPerUnit}:${r.date}`).sort()).toEqual(['EUR:13950:2026-08-20', 'USD:11850:2026-08-20']);
  });

  it('конфликт курсов между блоками обнаруживается, но не разрешается автоматически', async () => {
    const wb = new ExcelJS.Workbook();
    const put = (name: string, v: number, date: string) => {
      const ws = wb.addWorksheet(name);
      ws.getCell('B3').value = `Курс валют на ${date}`; ws.getCell('B4').value = 'Доллар'; ws.getCell('C4').value = 'Сумм';
      ws.getCell('B5').value = 1; ws.getCell('C5').value = v;
    };
    put('A', 11850, '20.08.2026'); put('B', 12085, '19.10.2026');
    const { scanRates, findRateConflicts, readXlsx: rx } = await import('../src/import');
    const sheets = await rx(Buffer.from(await wb.xlsx.writeBuffer()));
    const conflicts = findRateConflicts(scanRates(sheets));
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].currency).toBe('USD');
    expect(conflicts[0].candidates.map((c) => c.uzsPerUnit).sort()).toEqual(['11850', '12085']);
  });

  it('несоответствие остатка источника «Сумма − Оплачено» видно, расчёт идёт по «Сумма − Оплачено»', async () => {
    const a = await analyze([['', 1, 'P', 'Д №1', 'ACME', 'x', 1000, 400, 599, 'USD']]);
    expect(a.rows[0].issues.map((i) => i.code)).toContain('DEBT_MISMATCH');
    expect(a.summary.totalsByCurrency.USD.debt).toBe('600.00');
  });

  it('переплата в источнике — предупреждение, не ошибка', async () => {
    const a = await analyze([row({ amount: 100, paid: 150, cur: 'USD' })]);
    expect(a.rows[0].status).toBe('WARNING');
    expect(a.rows[0].issues.map((i) => i.code)).toContain('OVERPAID');
  });

  it('суммы с более чем 2 знаками округляются только в нормализованном поле; исходное значение сохраняется', async () => {
    const a = await analyze([row({ amount: 100.123456, paid: 0, cur: 'USD' })]);
    expect(a.rows[0].amount).toBe('100.12');
    expect(a.rows[0].amountRaw).toBe('100.123456');
    expect(a.rows[0].issues.map((i) => i.code)).toContain('AMOUNT_PRECISION');
  });

  it('несколько дат в номере -> дата не определяется автоматически', () => {
    expect(findDates('Спец №1 от 24.11.2026г. к Договору № 335 от 23.11.2026г.')).toHaveLength(2);
    expect(findDates('Договор от 25 Ноября 2026 г.')).toEqual(['2026-11-25']);
    expect(findDates('ДОГОВОР № 834 от 24,11,2026')).toEqual(['2026-11-24']);
    expect(findDates('Договор от 31.02.2026')).toEqual([]);
  });

  it('поставщики: группировка по точному ключу, нечёткие совпадения — только предложения', async () => {
    const a = await analyze([
      row({ sup: '"Mini Mall" MCHJ', no: 'Д1', amount: 1, paid: 0, cur: 'USD' }),
      row({ sup: ' "MINI MALL"  Mchj\n', no: 'Д2', amount: 1, paid: 0, cur: 'USD' }),
      row({ sup: 'ООО Mini Mall', no: 'Д3', amount: 1, paid: 0, cur: 'USD' }),
    ]);
    expect(a.supplierGroups).toHaveLength(2); // MCHJ-варианты слиты по точному ключу, ООО — отдельно
    expect(a.supplierSuggestions).toHaveLength(1); // но предложены к проверке
  });
});

describe('Import Engine: CSV', () => {
  const csv = [
    ',№,Проект,Номер контракта,Наименование контрагента,Наименования товара,Сумма контракта,Оплачено,Остаток суммы,Валюта',
    ',1,P1,"Договор №1, от 01.02.2026",ACME MCHJ,Кабель,1000.50,200,,USD',
    ',2,P1,Договор №2,"BETA, LLC",Болты,,,,UZS',
  ].join('\n');
  it('читает CSV с кавычками и запятыми внутри значений', async () => {
    const sheets = readCsv(Buffer.from(csv));
    const a = analyzeSheet(sheets[0], { allSheets: sheets });
    expect(a.rows[0].contractNoRaw).toBe('Договор №1, от 01.02.2026');
    expect(a.rows[0].amount).toBe('1000.50');
    expect(a.rows[1].status).toBe('BLOCKED'); // нет суммы
  });
  it('XLS отклоняется с понятным сообщением', async () => {
    await expect(readWorkbook(Buffer.from(''), 'a.xls')).rejects.toThrow(/XLS/);
  });
});

describe('Повторный импорт: diff', () => {
  const mk = async (rows: any[][]) => (await analyze(rows)).rows;
  it('показывает изменение «Оплачено» и требует сверки, ничего не применяя', async () => {
    const before = await mk([row({ amount: 1000, paid: 100, cur: 'USD' })]);
    const after = await mk([row({ amount: 1000, paid: 400, cur: 'USD' })]);
    const d = diffBatches(before, after);
    expect(d.changed).toHaveLength(1);
    expect(d.changed[0].fields).toEqual([{ field: 'openingPaid', from: '100.00', to: '400.00' }]);
    expect(d.changed[0].requiresReconciliation).toBe(true);
  });
  it('новые и удалённые строки', async () => {
    const before = await mk([row({ no: 'A', amount: 1, paid: 0, cur: 'USD' }), row({ no: 'B', amount: 1, paid: 0, cur: 'USD' })]);
    const after = await mk([row({ no: 'B', amount: 1, paid: 0, cur: 'USD' }), row({ no: 'C', amount: 1, paid: 0, cur: 'USD' })]);
    const d = diffBatches(before, after);
    expect(d.added.map((r) => r.contractNoRaw)).toEqual(['C']);
    expect(d.removed.map((r) => r.contractNoRaw)).toEqual(['A']);
    expect(d.unchanged).toBe(1);
  });
  it('идентичные импорты не дают изменений', async () => {
    const r = await mk([row({ amount: 5, paid: 1, cur: 'USD' })]);
    expect(diffBatches(r, r).changed).toHaveLength(0);
  });
  it('изменение только плана не требует сверки', async () => {
    const a = await analyze([row({ amount: 100, paid: 0, cur: 'USD' })]);
    const b = await analyze([row({ amount: 100, paid: 0, cur: 'USD' })], (ws) => { ws.getCell('K6').value = 50; });
    const d = diffBatches(a.rows, b.rows);
    expect(d.changed[0].fields.map((f) => f.field)).toEqual(['plan']);
    expect(d.changed[0].requiresReconciliation).toBe(false);
  });
});

// Реальный файл подключается только локально: PF_REAL_XLSX=<путь>. В репозиторий он не попадает.
const REAL = process.env.PF_REAL_XLSX;
describe.skipIf(!REAL)('Реальный реестр (локально)', () => {
  it('воспроизводит итоги источника и находит известные проблемы', async () => {
    const { readFileSync } = await import('node:fs');
    const sheets = await readWorkbook(readFileSync(REAL!), 'r.xlsx');
    const a = analyzeSheet(sheets.find((s) => s.name === 'Реестр договоров')!, { allSheets: sheets });
    expect(a.mapping.weekColumns).toHaveLength(28);
    expect(a.summary.templateRange).toEqual([718, 888]);
    for (const c of a.controlChecks.filter((c) => c.currency !== 'UZS')) expect(c.match).toBe(true);
    expect(a.rateConflicts.map((c) => c.currency).sort()).toEqual(['EUR', 'RUB', 'USD']);
    expect(a.rows.filter((r) => r.status === 'BLOCKED').every((r) => r.issues.some((i) => i.code === 'MISSING_CURRENCY'))).toBe(true);
  });
});
