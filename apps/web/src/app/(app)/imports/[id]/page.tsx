'use client';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { api, money } from '@/lib/api';
import { useSession } from '@/lib/session';

const FIELD_LABELS: Record<string, string> = {
  project: 'Проект', contractNo: 'Номер контракта', supplier: 'Контрагент', goods: 'Товар', amount: 'Сумма контракта',
  paid: 'Оплачено', debt: 'Остаток (долг)', currency: 'Валюта', notes: 'Примечание', executor: 'Исполнитель',
};
const REQUIRED = ['supplier', 'contractNo', 'amount', 'currency'];
const ISSUE_LABELS: Record<string, string> = {
  EXCEL_ERROR_CELL: 'Ошибка Excel (#REF! и т.п.)', FORMULA_NO_CACHE: 'Формула без значения', MISSING_SUPPLIER: 'Нет поставщика', MISSING_AMOUNT: 'Нет суммы',
  NON_NUMERIC_AMOUNT: 'Сумма — не число', NUMERIC_TEXT: 'Число записано текстом', MISSING_CURRENCY: 'Не указана валюта', UNKNOWN_CURRENCY: 'Неизвестная валюта',
  CURRENCY_ALIAS: 'Написание валюты приведено (EURO→EUR)', CURRENCY_MANUAL: 'Валюта задана вручную', MISSING_CONTRACT_NO: 'Нет номера договора', AMOUNT_PRECISION: 'Более 2 знаков в сумме',
  PAID_EMPTY_AS_ZERO: '«Оплачено» пусто → 0', PAID_FORMULA: '«Оплачено» — формула', PAID_NON_NUMERIC: '«Оплачено» — не число', OVERPAID: 'Переплата в источнике',
  DEBT_MISMATCH: 'Остаток источника ≠ Сумма − Оплачено', NEGATIVE_AMOUNT: 'Отрицательная сумма', DUPLICATE_ROW: 'Возможный дубль', WEEK_TEXT_NOTE: 'Текст в недельных колонках',
  WEEK_NON_NUMERIC: 'Недельная ячейка не число', CONTRACT_DATE_AMBIGUOUS: 'Несколько дат в номере договора',
};
const SEV: Record<string, string> = { error: 'b-err', warning: 'b-warn', info: 'b-info' };
const ROW_STATUS: Record<string, [string, string]> = { OK: ['Готово', 'b-ok'], WARNING: ['С замечаниями', 'b-warn'], BLOCKED: ['Заблокирована', 'b-err'], DUPLICATE: ['Дубль', 'b-mute'], EXCLUDED: ['Исключена', 'b-mute'] };

const colToLetter = (n?: number) => { let s = ''; while (n && n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
const letterToCol = (s: string) => [...s.toUpperCase().trim()].reduce((a, c) => a * 26 + c.charCodeAt(0) - 64, 0);

type Tab = 'summary' | 'mapping' | 'rows' | 'issues' | 'rates' | 'suppliers';

export default function ImportWizard() {
  const { id } = useParams<{ id: string }>();
  const { can } = useSession();
  const [b, setB] = useState<any>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>('summary');
  const [sheet, setSheet] = useState('');
  const [planYear, setPlanYear] = useState(String(new Date().getFullYear()));
  const [confirmed, setConfirmed] = useState(false);

  const load = useCallback(() => api('GET', `/imports/${id}`).then((r) => { setB(r); if (!sheet) setSheet(r.sheetName ?? r.sheets?.find((s: any) => s.layoutDetected && !s.empty)?.name ?? ''); }).catch((e) => setError(e.message)), [id, sheet]);
  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (fn: () => Promise<any>) => { setBusy(true); setError(''); try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  const analyze = (extra: object = {}) => run(async () => { setB(await api('POST', `/imports/${id}/analyze`, { sheetName: sheet, ...extra })); });

  if (!b) return <div className="muted">{error || 'Загрузка…'}</div>;
  const s = b.summary, x = b.extras ?? {};
  const analyzed = b.status === 'ANALYZED' || b.status === 'COMMITTED';
  const canCommit = can('import.commit') && b.status === 'ANALYZED';

  return (
    <div className="space-y-4 max-w-6xl">
      <div><h1 className="text-xl font-semibold">{b.filename}</h1>
        <p className="muted">Шаги: загрузка → выбор листа → сопоставление полей → проверка → предпросмотр → подтверждение → отчёт</p></div>
      {error && <p role="alert" className="b-err">{error}</p>}

      {b.status === 'UPLOADED' && (
        <section className="panel p-4 space-y-3">
          <h2 className="font-semibold">Выберите лист</h2>
          {b.sheets.map((sh: any) => (
            <label key={sh.name} className="flex items-center gap-2" style={{ opacity: sh.empty ? .55 : 1 }}>
              <input type="radio" name="sheet" checked={sheet === sh.name} disabled={sh.empty} onChange={() => setSheet(sh.name)} />
              <span>{sh.name}</span>
              <span className="muted text-xs">{sh.empty ? 'пустой — не финансовые данные' : `${sh.rowCount} строк, ${sh.colCount} столбцов`}{sh.hidden ? ', скрыт' : ''}{sh.layoutDetected ? ', заголовки распознаны' : ''}</span>
            </label>))}
          <button className="btn btn-primary" disabled={busy || !sheet || !can('import.run')} onClick={() => analyze()}>{busy ? 'Анализ…' : 'Проверить данные'}</button>
        </section>)}

      {analyzed && s && (<>
        <nav className="flex gap-1 flex-wrap">
          {([['summary', 'Сводка'], ['mapping', 'Сопоставление полей'], ['rows', 'Строки'], ['issues', 'Проблемы'], ['rates', `Курсы${x.rateConflicts?.length ? ' ⚠' : ''}`], ['suppliers', 'Поставщики']] as [Tab, string][]).map(([k, l]) => (
            <button key={k} className="btn" style={tab === k ? { background: 'var(--border)', fontWeight: 600 } : undefined} onClick={() => setTab(k)}>{l}</button>))}
        </nav>

        {tab === 'summary' && <Summary s={s} x={x} />}
        {tab === 'mapping' && <Mapping b={b} busy={busy} disabled={b.status !== 'ANALYZED' || !can('import.run')} onApply={(mapping) => analyze({ mapping })} />}
        {tab === 'rows' && <Rows id={id} editable={b.status === 'ANALYZED' && can('import.run')} version={JSON.stringify(s)} onChange={(r) => setB(r)} setError={setError} />}
        {tab === 'issues' && <Issues id={id} version={JSON.stringify(s)} />}
        {tab === 'rates' && <Rates x={x} />}
        {tab === 'suppliers' && <Suppliers x={x} s={s} />}

        {b.status === 'ANALYZED' && (
          <section className="panel p-4 space-y-3" style={{ borderColor: 'var(--pending)' }}>
            <h2 className="font-semibold">Подтверждение и сохранение</h2>
            <ul className="text-sm list-disc pl-5 muted">
              <li>Будет сохранено строк: <b style={{ color: 'var(--text)' }}>{s.importable}</b>. Не будет сохранено: заблокированных {s.blocked}, дублей {s.duplicates}.</li>
              <li>«Оплачено» сохраняется как начальный исторический остаток; банковские платежи не создаются.</li>
              <li>Курсы из файла сохраняются как кандидаты — их нужно подтвердить на странице «Курсы валют».</li>
            </ul>
            <div className="flex items-center gap-3 flex-wrap">
              <label className="flex items-center gap-2">Год плана (W1–W4) <input className="input w-24" value={planYear} onChange={(e) => setPlanYear(e.target.value)} inputMode="numeric" /></label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /> Я проверил предпросмотр и проблемы</label>
              <button className="btn btn-primary" disabled={!canCommit || !confirmed || busy || !/^\d{4}$/.test(planYear)}
                onClick={() => run(async () => { await api('POST', `/imports/${id}/commit`, { confirm: true, planYear: Number(planYear) }); await load(); })}>{busy ? 'Сохранение…' : 'Сохранить в систему'}</button>
              {!can('import.commit') && <span className="muted text-xs">Сохранение доступно ролям FINANCE и администраторам</span>}
            </div>
          </section>)}

        {b.status === 'COMMITTED' && b.report && <Report r={b.report} at={b.committedAt} />}
      </>)}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: React.ReactNode; tone?: string }) {
  return <div className="panel p-3"><div className="muted text-xs">{label}</div><div className={`text-lg font-semibold ${tone ?? ''}`}>{value}</div></div>;
}

function Summary({ s, x }: { s: any; x: any }) {
  return (
    <div className="space-y-4">
      {x.sync && <SyncPanel c={x.sync} />}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Строк просмотрено" value={s.totalRowsScanned} /><Stat label="Строк договоров" value={s.dataRows} />
        <Stat label="К импорту" value={s.importable} tone="b-ok" /><Stat label="С замечаниями" value={s.warnings} tone="b-warn" />
        <Stat label="Заблокировано" value={s.blocked} tone={s.blocked ? 'b-err' : ''} /><Stat label="Дубликаты" value={s.duplicates} />
        <Stat label="Шаблонные строки (пропущены)" value={s.skippedTemplate} /><Stat label="Служебный блок (пропущен)" value={s.skippedService} />
      </div>
      {s.templateRange && <p className="muted text-sm">Шаблонные строки {s.templateRange[0]}–{s.templateRange[1]} (ошибки #REF! в колонке-индексе, пустые заготовки) не считаются договорами. Блок курсов/итогов: строки {s.serviceRange?.[0]}–{s.serviceRange?.[1]}.</p>}
      <div className="panel overflow-x-auto">
        <table className="tbl"><thead><tr><th>Валюта</th><th className="num">Строк</th><th className="num">Сумма контрактов</th><th className="num">Оплачено (начальный остаток)</th><th className="num">Остаток</th><th>Сверка с итогом источника</th></tr></thead>
          <tbody>{Object.entries(s.totalsByCurrency).map(([c, t]: any) => { const ck = x.controlChecks?.find((k: any) => k.currency === c); return (
            <tr key={c}><td><b>{c}</b></td><td className="num">{t.rows}</td><td className="num">{money(t.amount)}</td><td className="num b-ok">{money(t.paid)}</td><td className="num b-err">{money(t.debt)}</td>
              <td>{ck ? (ck.match ? <span className="badge b-ok">совпадает</span> : <span className="badge b-warn">расхождение {money(ck.diff)}</span>) : <span className="muted">—</span>}</td></tr>); })}</tbody></table>
      </div>
      <p className="muted text-xs">Валюты не суммируются между собой: итоги показаны отдельно по каждой валюте.</p>
      {x.debtWithoutCurrency?.rows > 0 && (
        <div className="panel p-3" style={{ borderColor: 'var(--debt)' }}>
          <b className="b-err">Строки без валюты: {x.debtWithoutCurrency.rows}</b>
          <p className="text-sm">Остаток по ним {money(x.debtWithoutCurrency.debt)} (в единицах неизвестной валюты). Эти суммы <b>не входят</b> в итоги исходной таблицы (SUMIFS по валюте). Выберите валюту на вкладке «Строки», иначе строки не будут импортированы.</p>
        </div>)}
      {s.planOnSettledRows > 0 && <p className="muted text-sm">В {s.planOnSettledRows} строках с нулевым остатком заполнены недельные колонки — вероятно, это история платежей, а не план. Они будут сохранены как плановые записи (на задолженность не влияют).</p>}
    </div>
  );
}

function SyncPanel({ c }: { c: any }) {
  return (
    <section className="panel p-4 space-y-2" style={{ borderColor: 'var(--plan)' }}>
      <h2 className="font-semibold b-info">Изменения в Google-таблице{c.baselineBatchId ? ' с последнего сохранённого импорта' : ' (первая загрузка)'}</h2>
      <div className="flex gap-4 flex-wrap text-sm">
        <span>Новых строк: <b>{c.added}</b></span><span>Изменено: <b>{c.changed}</b>{c.paidChanged ? <b className="b-warn"> (из них «Оплачено»: {c.paidChanged})</b> : null}</span>
        <span>Исчезло из таблицы: <b>{c.removed}</b></span><span>Без изменений: <b>{c.unchanged}</b></span>{c.blocked ? <span className="b-err">Заблокировано: <b>{c.blocked}</b></span> : null}
      </div>
      {c.paidChanged > 0 && <p className="text-sm b-warn">Изменение «Оплачено» не перезапишет договор: оно станет задачей сверки. Строки, исчезнувшие из таблицы, в системе не удаляются.</p>}
      {c.samples?.length > 0 && <details><summary className="cursor-pointer text-sm">Примеры изменений ({c.samples.length})</summary>
        <ul className="text-sm list-disc pl-5">{c.samples.map((x: any, i: number) => <li key={i}>Строка {x.row}, {x.supplier} — {x.contract?.slice(0, 50)}: {x.fields.map((f: any) => `${f.field}: ${f.from ?? '—'} → ${f.to ?? '—'}`).join('; ')}</li>)}</ul></details>}
    </section>
  );
}

function Mapping({ b, onApply, busy, disabled }: { b: any; onApply: (m: any) => void; busy: boolean; disabled: boolean }) {
  const m = b.extras?.mapping;
  const [cols, setCols] = useState<Record<string, string>>(() => Object.fromEntries(Object.keys(FIELD_LABELS).map((k) => [k, colToLetter(m?.fields?.[k])])));
  const [header, setHeader] = useState(String(m?.headerRow ?? ''));
  const apply = () => onApply({ headerRow: Number(header), fields: Object.fromEntries(Object.entries(cols).filter(([, v]) => v.trim()).map(([k, v]) => [k, letterToCol(v)])), weekColumns: m.weekColumns, missing: [] });
  return (
    <section className="panel p-4 space-y-3">
      <p className="muted text-sm">Столбцы распознаны автоматически по заголовкам. При необходимости укажите другие буквы столбцов и примените.</p>
      <div className="grid sm:grid-cols-2 md:grid-cols-3 gap-3">
        <label className="flex items-center gap-2">Строка заголовков <input className="input w-20" value={header} onChange={(e) => setHeader(e.target.value)} disabled={disabled} /></label>
        {Object.entries(FIELD_LABELS).map(([k, l]) => (
          <label key={k} className="flex items-center gap-2">{l}{REQUIRED.includes(k) && <span className="b-err">*</span>}
            <input className="input w-20 uppercase" value={cols[k] ?? ''} onChange={(e) => setCols({ ...cols, [k]: e.target.value })} disabled={disabled} /></label>))}
      </div>
      <p className="muted text-sm">Недельные колонки: {m?.weekColumns?.length ?? 0} (W1–W4 × месяцы{m?.weekColumns?.length ? `, ${colToLetter(m.weekColumns[0].col)}–${colToLetter(m.weekColumns[m.weekColumns.length - 1].col)}` : ''}). Год в файле не указан — задаётся при сохранении.</p>
      <button className="btn" disabled={disabled || busy} onClick={apply}>Применить сопоставление</button>
    </section>
  );
}

function Rows({ id, editable, version, onChange, setError }: { id: string; editable: boolean; version: string; onChange: (b: any) => void; setError: (s: string) => void }) {
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<any>(null);
  useEffect(() => { setPage(1); }, [status, search]);
  useEffect(() => {
    const q = new URLSearchParams({ page: String(page), pageSize: '50', ...(status ? { status } : {}), ...(search ? { search } : {}) });
    const t = setTimeout(() => api('GET', `/imports/${id}/rows?${q}`).then(setData).catch((e) => setError(e.message)), search ? 250 : 0);
    return () => clearTimeout(t);
  }, [id, status, search, page, version, setError]);
  const override = async (row: number, patch: object) => { try { onChange(await api('PATCH', `/imports/${id}/overrides`, { [row]: patch })); } catch (e) { setError((e as Error).message); } };
  return (
    <section className="space-y-2">
      <div className="flex gap-2 flex-wrap">
        <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Все статусы</option>{Object.entries(ROW_STATUS).map(([k, v]) => <option key={k} value={k}>{v[0]}</option>)}</select>
        <input className="input" placeholder="Поиск: поставщик, договор, проект…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <span className="muted self-center">{data ? `${data.total} строк` : ''}</span>
      </div>
      <div className="panel overflow-auto" style={{ maxHeight: '60vh' }}>
        <table className="tbl"><thead><tr><th>Стр.</th><th>Статус</th><th>Проект</th><th>Договор</th><th>Поставщик</th><th className="num">Сумма</th><th className="num">Оплачено</th><th>Вал.</th><th>Замечания</th><th></th></tr></thead>
          <tbody>{data?.items.map((r: any) => { const st = ROW_STATUS[r.status]; const needCur = r.issues.some((i: any) => i.code === 'MISSING_CURRENCY' || i.code === 'UNKNOWN_CURRENCY'); return (
            <tr key={r.rowNumber}>
              <td>{r.rowNumber}</td><td><span className={`badge ${st[1]}`}>{st[0]}</span></td><td className="max-w-40 truncate" title={r.project ?? ''}>{r.project}</td>
              <td className="max-w-56" title={r.contractNoRaw ?? ''}>{r.contractNoRaw?.slice(0, 60)}</td><td className="max-w-56" title={r.supplierRaw ?? ''}>{r.supplierDisplay}</td>
              <td className="num">{money(r.amount)}</td><td className="num b-ok">{money(r.openingPaid)}</td>
              <td>{r.currency ?? (editable && needCur ? (
                <select className="input" defaultValue="" onChange={(e) => e.target.value && override(r.rowNumber, { currency: e.target.value })}><option value="">выбрать…</option>{['USD', 'UZS', 'RUB', 'EUR'].map((c) => <option key={c}>{c}</option>)}</select>) : <span className="b-err">—</span>)}</td>
              <td className="text-xs">{[...new Set(r.issues.filter((i: any) => i.severity !== 'info').map((i: any) => ISSUE_LABELS[i.code] ?? i.code))].join('; ')}</td>
              <td className="whitespace-nowrap">{editable && r.status === 'DUPLICATE' && <button className="btn" onClick={() => override(r.rowNumber, { include: true })}>Включить</button>}
                {editable && (r.status === 'OK' || r.status === 'WARNING') && <button className="btn" onClick={() => override(r.rowNumber, { include: false })}>Исключить</button>}
                {editable && r.status === 'EXCLUDED' && <button className="btn" onClick={() => override(r.rowNumber, { include: true })}>Вернуть</button>}</td>
            </tr>); })}</tbody></table>
      </div>
      {data && data.total > data.pageSize && (
        <div className="flex gap-2 items-center"><button className="btn" disabled={page <= 1} onClick={() => setPage(page - 1)}>←</button>
          <span className="muted">{page} / {Math.ceil(data.total / data.pageSize)}</span><button className="btn" disabled={page * data.pageSize >= data.total} onClick={() => setPage(page + 1)}>→</button></div>)}
    </section>
  );
}

function Issues({ id, version }: { id: string; version: string }) {
  const [d, setD] = useState<any>(null);
  const [sev, setSev] = useState('');
  useEffect(() => { api('GET', `/imports/${id}/issues${sev ? `?severity=${sev}` : ''}`).then(setD); }, [id, sev, version]);
  if (!d) return <div className="muted">Загрузка…</div>;
  return (
    <section className="space-y-2">
      <div className="flex gap-2 items-center"><select className="input" value={sev} onChange={(e) => setSev(e.target.value)}><option value="">Все</option><option value="error">Ошибки</option><option value="warning">Предупреждения</option><option value="info">Информация</option></select><span className="muted">Показано {Math.min(d.total, 2000)} из {d.total}</span></div>
      <div className="grid sm:grid-cols-2 md:grid-cols-3 gap-2">{Object.entries(d.byCode).map(([c, n]) => <div key={c} className="panel p-2 flex justify-between"><span>{ISSUE_LABELS[c] ?? c}</span><b>{n as number}</b></div>)}</div>
      <div className="panel overflow-auto" style={{ maxHeight: '50vh' }}><table className="tbl"><thead><tr><th>Стр.</th><th>Ячейка</th><th>Важность</th><th>Описание</th><th>Исходное значение</th></tr></thead>
        <tbody>{d.items.map((i: any, k: number) => <tr key={k}><td>{i.row}</td><td>{i.cell ?? ''}</td><td><span className={`badge ${SEV[i.severity]}`}>{i.severity}</span></td><td>{i.message}</td><td className="max-w-64 truncate" title={i.original}>{i.original}</td></tr>)}</tbody></table></div>
    </section>
  );
}

function Rates({ x }: { x: any }) {
  if (!x.rates?.length) return <p className="muted">В файле блоков курсов не найдено.</p>;
  return (
    <section className="space-y-3">
      {x.rateConflicts?.length > 0 && <div className="panel p-3" style={{ borderColor: 'var(--pending)' }}><b className="b-warn">Курсы в файле расходятся ({x.rateConflicts.map((c: any) => c.currency).join(', ')})</b><p className="text-sm">Система не выбирает курс автоматически. После сохранения все значения попадут в «Курсы валют» как кандидаты — актуальный курс подтверждает пользователь с правом управления курсами.</p></div>}
      <div className="panel overflow-x-auto"><table className="tbl"><thead><tr><th>Валюта</th><th className="num">UZS за 1 ед.</th><th>Дата</th><th>Источник</th></tr></thead>
        <tbody>{x.rates.map((r: any, i: number) => <tr key={i}><td><b>{r.currency}</b></td><td className="num">{money(r.uzsPerUnit)}</td><td>{r.date ?? '—'}</td><td>{r.sheet}!{r.cell}</td></tr>)}</tbody></table></div>
    </section>
  );
}

function Suppliers({ x, s }: { x: any; s: any }) {
  return (
    <section className="space-y-3">
      <p>Исходных написаний: <b>{s.distinctSupplierSpellings}</b>. После безопасной группировки (регистр, кавычки, пробелы, ИНН): <b>{x.supplierGroupCount}</b>. Эти варианты сохранятся как алиасы одного поставщика.</p>
      <p className="muted text-sm">Ниже — похожие названия, которые система <b>не объединяет</b> сама (например, «ООО Mini Mall» и «Mini Mall MCHJ»). Решение об объединении принимает пользователь в справочнике контрагентов (этап M3).</p>
      <div className="panel overflow-auto" style={{ maxHeight: '50vh' }}><table className="tbl"><thead><tr><th>Возможные дубликаты</th></tr></thead>
        <tbody>{x.supplierSuggestions?.map((g: any, i: number) => <tr key={i}><td>{[...new Set(g.spellings as string[])].map((sp) => sp.replace(/\s+/g, ' ').trim()).join('  ↔  ')}</td></tr>)}
          {!x.supplierSuggestions?.length && <tr><td className="muted">Не найдено</td></tr>}</tbody></table></div>
    </section>
  );
}

function Report({ r, at }: { r: any; at: string }) {
  return (
    <section className="panel p-4 space-y-3" style={{ borderColor: 'var(--paid)' }}>
      <h2 className="font-semibold b-ok">Импорт сохранён {at ? new Date(at).toLocaleString('ru-RU') : ''}</h2>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Создано поставщиков" value={r.suppliersCreated} /><Stat label="Создано договоров" value={r.contractsCreated} tone="b-ok" />
        <Stat label="Без изменений" value={r.contractsUnchanged} /><Stat label="Изменились в источнике" value={r.contractsChangedInSource} tone={r.contractsChangedInSource ? 'b-warn' : ''} />
        <Stat label="Задач сверки создано" value={r.reconciliationTasks} tone={r.reconciliationTasks ? 'b-warn' : ''} /><Stat label="Плановых записей" value={r.planEntriesWritten} tone="b-info" />
        <Stat label="Курсов на подтверждение" value={r.ratesPending} tone={r.ratesPending ? 'b-warn' : ''} /><Stat label="Пропущено (блок/дубли)" value={`${r.skipped.blocked}/${r.skipped.duplicates}`} />
      </div>
      {r.blockedRows?.length > 0 && <details><summary className="cursor-pointer">Не импортированные строки ({r.blockedRows.length})</summary><ul className="text-sm list-disc pl-5">{r.blockedRows.map((b: any) => <li key={b.row}>Строка {b.row}: {b.reasons.join('; ')}</li>)}</ul></details>}
      {r.contractsChangedInSource > 0 && <p className="b-warn text-sm">Существующие договоры не перезаписаны: расхождения ждут решения в разделе «Сверка» (этап M4).</p>}
    </section>
  );
}
