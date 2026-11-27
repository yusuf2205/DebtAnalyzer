'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { ContractPeek } from '@/lib/contract-peek';
import { ColumnChooser, SavedViews, useColumns, type Col } from '@/lib/list-tools';
import { api, money } from '@/lib/api';
import { useSession } from '@/lib/session';
import { CURRENCIES, ExportLink, OriginBadge, PagerBar, qs, usePageSize, StateBadge, Th, TotalsStrip } from '@/lib/ui';

const COLS: Col[] = [
  { key: 'number', label: 'Договор', fixed: true }, { key: 'supplier', label: 'Контрагент' }, { key: 'project', label: 'Проект' }, { key: 'currency', label: 'Валюта' },
  { key: 'origin', label: 'Тип' }, { key: 'amount', label: 'Сумма' }, { key: 'paid', label: 'Оплачено' }, { key: 'debt', label: 'Долг' }, { key: 'state', label: 'Состояние' }, { key: 'executor', label: 'Исполнитель' },
];

export default function Page() { return <Suspense fallback={<p className="muted">Загрузка…</p>}><Contracts /></Suspense>; }

function Contracts() {
  const { can } = useSession();
  const cols = useColumns('contracts', COLS);
  const canArchive = can('contracts.archive'), canManage = can('contracts.manage');
  const bulkAllowed = canArchive || canManage;
  const sp = useSearchParams();
  const [peek, setPeek] = useState<string | null>(null); // открытая краткая панель договора
  const closePeek = useCallback(() => setPeek(null), []);
  const [sel, setSel] = useState<Set<string>>(new Set());   // выбранные договоры текущей страницы
  const [tick, setTick] = useState(0);                         // принудительная перезагрузка списка
  const [notice, setNotice] = useState('');
  const [bulkExecutor, setBulkExecutor] = useState('');
  const [busy, setBusy] = useState(false);
  const p = (k: string, d = '') => sp.get(k) ?? d; // фильтры можно задавать ссылкой, например /contracts?state=OPEN&currency=USD
  const [f, setF] = useState({ q: p('q'), supplierId: p('supplierId'), project: p('project'), executor: p('executor'), currency: p('currency'), origin: p('origin'), status: p('status', 'ACTIVE'), state: p('state'), sort: p('sort', 'created'), dir: p('dir', 'desc'), page: 1 });
  const [data, setData] = useState<any>(null);
  const [executors, setExecutors] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [pageSize, setPageSize] = usePageSize('contracts');
  const query = qs({ ...f, pageSize });

  useEffect(() => { api('GET', '/contracts/facets').then((r) => setExecutors(r.executors)).catch(() => {}); }, []);
  useEffect(() => {
    const t = setTimeout(() => api('GET', `/contracts?${query}`).then(setData).catch((e) => setError(e.message)), 200);
    return () => clearTimeout(t);
  }, [query, tick]);
  useEffect(() => { setSel(new Set()); }, [query]); // другая страница или фильтр — выбор сбрасывается

  async function runBulk(action: 'archive' | 'restore' | 'executor' | 'origin' | 'origin-accept', ask?: string, extra?: Record<string, unknown>) {
    if (ask && !confirm(ask)) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const r = await api<{ updated: number; skipped: number }>('POST', '/contracts/bulk', { action, ids: [...sel], ...(extra ?? {}) });
      setNotice(`Изменено: ${r.updated}${r.skipped ? `, пропущено: ${r.skipped} (уже в нужном состоянии или в архиве)` : ''}`);
      setSel(new Set()); setBulkExecutor(''); setTick((t) => t + 1);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const set = (p: Partial<typeof f>) => setF((s) => ({ ...s, page: 1, ...p }));
  const onSort = (field: string) => set({ sort: field, dir: f.sort === field && f.dir === 'asc' ? 'desc' : 'asc' });

  return (
    <div className="space-y-4 max-w-7xl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div><h1 className="text-xl font-semibold">Договоры</h1><p className="muted">Реестр договоров снабжения. Суммы по валютам не складываются.</p></div>
        <div className="flex gap-2">
          {can('reports.export') && <ExportLink href={`/contracts/export?${qs({ ...f, page: undefined })}`}>Экспорт в Excel</ExportLink>}
          {can('contracts.manage') && <Link className="btn btn-primary" href="/contracts/new">Новый договор</Link>}
        </div>
      </div>
      {error && <p role="alert" className="b-err">{error}</p>}
      <div className="flex gap-2 flex-wrap">
        <input className="input" placeholder="Поиск: номер, поставщик, товар, проект…" value={f.q} onChange={(e) => set({ q: e.target.value })} />
        <input className="input" placeholder="Проект" value={f.project} onChange={(e) => set({ project: e.target.value })} />
        <select className="input" value={f.executor} onChange={(e) => set({ executor: e.target.value })}><option value="">Все исполнители</option>{executors.map((x) => <option key={x}>{x}</option>)}</select>
        <select className="input" value={f.currency} onChange={(e) => set({ currency: e.target.value })}><option value="">Все валюты</option>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</select>
        <select className="input" value={f.origin} onChange={(e) => set({ origin: e.target.value })} aria-label="Тип договора"><option value="">Любой тип</option><option value="LOCAL">Местные</option><option value="FOREIGN">Зарубежные</option><option value="UNSET">Тип не определён</option></select>
        <select className="input" value={f.state} onChange={(e) => set({ state: e.target.value })}><option value="">Любое состояние</option><option value="OPEN">Есть долг</option><option value="UNPAID">Не оплачен</option><option value="PARTIAL">Частично</option><option value="PAID">Оплачен</option><option value="OVERPAID">Переплата</option></select>
        <select className="input" value={f.status} onChange={(e) => set({ status: e.target.value })}><option value="ACTIVE">Активные</option><option value="ARCHIVED">Архив</option><option value="ALL">Все</option></select>
        {f.supplierId && <button className="btn" onClick={() => set({ supplierId: '' })}>Сбросить фильтр по контрагенту ✕</button>}
      </div>
      <div className="flex gap-2 flex-wrap items-start">
        <SavedViews storeKey="contracts" current={f} onApply={(v) => setF(v as typeof f)} />
        <ColumnChooser cols={COLS} state={cols} />
      </div>
      <TotalsStrip totals={data?.totals ?? []} />
      {data && <PagerBar page={f.page} pageSize={pageSize} total={data.total} noun="договоров" onPage={(p) => setF({ ...f, page: p })} onPageSize={(n) => { setPageSize(n); setF({ ...f, page: 1 }); }} />}
      {bulkAllowed && data && data.items.length > 0 && (
        <div className="flex items-center gap-3 flex-wrap text-sm" role="toolbar" aria-label="Действия над выбранными договорами">
          <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" style={{ accentColor: 'var(--accent)', width: 16, height: 16 }}
            checked={sel.size > 0 && sel.size === data.items.length} ref={(el) => { if (el) el.indeterminate = sel.size > 0 && sel.size < data.items.length; }}
            onChange={(e) => setSel(e.target.checked ? new Set(data.items.map((x: any) => x.id)) : new Set())} aria-label="Выбрать все договоры на странице" />
            {sel.size ? <b>Выбрано: {sel.size}</b> : <span className="muted">Выбрать все на странице</span>}</label>
          {sel.size > 0 && (<>
            {canArchive && f.status !== 'ARCHIVED' && <button className="btn" disabled={busy} onClick={() => runBulk('archive', 'Отправить в архив выбранные договоры (' + sel.size + ')? Они исчезнут из списков и итогов, но сохранятся в системе.')}>В архив</button>}
            {canArchive && f.status !== 'ACTIVE' && <button className="btn" disabled={busy} onClick={() => runBulk('restore')}>Восстановить</button>}
            {canManage && (
              <form className="flex gap-1.5 items-center" onSubmit={(e) => { e.preventDefault(); runBulk('executor', `Назначить исполнителя «${bulkExecutor.trim() || '—'}» выбранным договорам (${sel.size})?`, { executor: bulkExecutor.trim() || null }); }}>
                <input className="input" style={{ padding: '4px 10px' }} list="bulk-executors" placeholder="Исполнитель" value={bulkExecutor} onChange={(e) => setBulkExecutor(e.target.value)} aria-label="Исполнитель для выбранных" />
                <datalist id="bulk-executors">{executors.map((x) => <option key={x} value={x} />)}</datalist>
                <button className="btn" disabled={busy}>{bulkExecutor.trim() ? 'Назначить' : 'Очистить исполнителя'}</button>
              </form>)}
            {canManage && (
              <span className="flex gap-1.5 items-center flex-wrap" role="group" aria-label="Тип выбранных договоров">
                <span className="muted">Тип:</span>
                <button className="btn" disabled={busy} onClick={() => runBulk('origin', undefined, { origin: 'LOCAL' })}>Местный</button>
                <button className="btn" disabled={busy} onClick={() => runBulk('origin', undefined, { origin: 'FOREIGN' })}>Зарубежный</button>
                <button className="btn" disabled={busy} title="Применить предложения системы к тем договорам, где тип ещё не подтверждён" onClick={() => runBulk('origin-accept', 'Принять предложения системы для выбранных договоров, у которых тип ещё не подтверждён?')}>Принять предложения</button>
                <button className="btn" disabled={busy} onClick={() => runBulk('origin', undefined, { origin: null })}>Сбросить</button>
              </span>)}
            <button className="btn" onClick={() => setSel(new Set())}>Снять выбор</button>
          </>)}
          {notice && <span role="status" className="b-ok">{notice}</span>}
        </div>)}
      <div className="panel overflow-auto" style={{ maxHeight: '62vh' }}>
        <table className="tbl"><thead><tr>
          <Th label="Договор" field="number" sort={f.sort} dir={f.dir} onSort={onSort} />{cols.show('supplier') && <Th label="Контрагент" field="supplier" sort={f.sort} dir={f.dir} onSort={onSort} />}{cols.show('project') && <Th label="Проект" field="project" sort={f.sort} dir={f.dir} onSort={onSort} />}
          {cols.show('currency') && <th>Вал.</th>}{cols.show('origin') && <th>Тип</th>}{cols.show('amount') && <Th label="Сумма" field="amount" sort={f.sort} dir={f.dir} onSort={onSort} className="num" />}{cols.show('paid') && <th className="num">Оплачено</th>}{cols.show('debt') && <Th label="Долг" field="debt" sort={f.sort} dir={f.dir} onSort={onSort} className="num" />}{cols.show('state') && <th>Состояние</th>}{cols.show('executor') && <th>Исполнитель</th>}</tr></thead>
          <tbody>{data?.items.map((c: any) => (
            <tr key={c.id} className="row-link" aria-selected={peek === c.id} style={c.status === 'ARCHIVED' ? { opacity: .55 } : undefined}
              onClick={(e) => { if (!(e.target as HTMLElement).closest('a,button,input,select')) setPeek(c.id); }}>
              <td className="max-w-72"><div className="flex items-start gap-2.5">
                {bulkAllowed && <input type="checkbox" className="mt-1 shrink-0" style={{ accentColor: 'var(--accent)', width: 16, height: 16 }} aria-label={`Выбрать договор ${c.number ?? ''}`} checked={sel.has(c.id)}
                  onChange={(e) => setSel((p) => { const n = new Set(p); if (e.target.checked) n.add(c.id); else n.delete(c.id); return n; })} />}
                <div className="min-w-0"><Link className="underline" href={`/contracts/${c.id}`} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); setPeek(c.id); }}>{c.number ?? '—'}</Link>{c.status === 'ARCHIVED' && <span className="badge b-mute ml-2">архив</span>}</div></div></td>
              {cols.show('supplier') && <td className="max-w-56"><Link href={`/suppliers/${c.supplier.id}`}>{c.supplier.name}</Link></td>}{cols.show('project') && <td className="max-w-40 truncate" title={c.project ?? ''}>{c.project}</td>}
              {cols.show('currency') && <td>{c.currency}</td>}{cols.show('origin') && <td><OriginBadge c={c} /></td>}{cols.show('amount') && <td className="num">{money(c.amount)}</td>}{cols.show('paid') && <td className="num b-ok">{money(c.openingPaid)}</td>}{cols.show('debt') && <td className="num b-err">{Number(c.debt) ? money(c.debt) : '—'}</td>}
              {cols.show('state') && <td><StateBadge state={c.state} /></td>}{cols.show('executor') && <td>{c.executor}</td>}</tr>))}
            {data?.items.length === 0 && <tr><td colSpan={COLS.length} className="muted">Ничего не найдено</td></tr>}</tbody></table>
      </div>
      {data && <PagerBar page={f.page} pageSize={pageSize} total={data.total} noun="договоров" onPage={(p) => setF({ ...f, page: p })} onPageSize={(n) => { setPageSize(n); setF({ ...f, page: 1 }); }} />}
      {peek && <ContractPeek id={peek} onClose={closePeek} />}
    </div>
  );
}
