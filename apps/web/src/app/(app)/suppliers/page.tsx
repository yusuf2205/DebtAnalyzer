'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { CURRENCIES, ExportLink, Pager, PerCurrency, qs, Th, TotalsStrip } from '@/lib/ui';

export default function SuppliersPage() {
  const { can } = useSession();
  const [tab, setTab] = useState<'list' | 'dups'>('list');
  const [f, setF] = useState({ q: '', status: 'ACTIVE', currency: '', executor: '', hasDebt: '', sort: 'name', dir: 'asc', page: 1 });
  const [data, setData] = useState<any>(null);
  const [dups, setDups] = useState<any[] | null>(null);
  const [error, setError] = useState('');
  const [newName, setNewName] = useState('');

  const query = qs({ ...f, pageSize: 50 });
  const load = useCallback(() => {
    const t = setTimeout(() => api('GET', `/suppliers?${query}`).then(setData).catch((e) => setError(e.message)), 200);
    return () => clearTimeout(t);
  }, [query]);
  useEffect(() => load(), [load]);
  const loadDups = useCallback(() => api<any[]>('GET', '/suppliers/suggestions').then(setDups).catch((e) => setError(e.message)), []);
  useEffect(() => { loadDups(); }, [loadDups]);

  const set = (p: Partial<typeof f>) => setF((s) => ({ ...s, page: 1, ...p }));
  const onSort = (field: string) => set({ sort: field, dir: f.sort === field && f.dir === 'asc' ? 'desc' : 'asc' });

  async function create() {
    setError('');
    try { const s = await api<{ id: string }>('POST', '/suppliers', { name: newName }); location.href = `/suppliers/${s.id}`; } catch (e) { setError((e as Error).message); }
  }

  return (
    <div className="space-y-4 max-w-7xl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div><h1 className="text-xl font-semibold">Контрагенты</h1><p className="muted">Суммы показаны отдельно по каждой валюте. Долг = сумма − оплачено.</p></div>
        <div className="flex gap-2 flex-wrap">
          {can('reports.export') && <ExportLink href={`/suppliers/export?${qs({ ...f, page: undefined })}`}>Экспорт в Excel</ExportLink>}
        </div>
      </div>
      {error && <p role="alert" className="b-err">{error}</p>}
      <nav className="flex gap-1">
        <button className="btn" style={tab === 'list' ? { background: 'var(--border)', fontWeight: 600 } : undefined} onClick={() => setTab('list')}>Справочник</button>
        <button className="btn" style={tab === 'dups' ? { background: 'var(--border)', fontWeight: 600 } : undefined} onClick={() => setTab('dups')}>Возможные дубликаты{dups ? ` (${dups.length})` : ''}</button>
      </nav>

      {tab === 'list' && (<>
        <div className="flex gap-2 flex-wrap">
          <input className="input" placeholder="Поиск: название, написание, ИНН…" value={f.q} onChange={(e) => set({ q: e.target.value })} />
          <select className="input" value={f.status} onChange={(e) => set({ status: e.target.value })}><option value="ACTIVE">Активные</option><option value="ARCHIVED">Объединённые (архив)</option><option value="ALL">Все</option></select>
          <select className="input" value={f.currency} onChange={(e) => set({ currency: e.target.value })}><option value="">Все валюты</option>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</select>
          <input className="input" placeholder="Исполнитель" value={f.executor} onChange={(e) => set({ executor: e.target.value })} />
          <select className="input" value={f.hasDebt} onChange={(e) => set({ hasDebt: e.target.value })}><option value="">Долг: любой</option><option value="true">Есть долг</option><option value="false">Нет долга</option></select>
        </div>
        {f.sort !== 'name' && f.sort !== 'contracts' && <p className="muted text-xs">Сортировка по суммам идёт по выбранной валюте ({f.currency || 'USD'}).</p>}
        <TotalsStrip totals={data?.totals ?? []} />
        <div className="panel overflow-auto" style={{ maxHeight: '62vh' }}>
          <table className="tbl"><thead><tr>
            <Th label="Контрагент" field="name" sort={f.sort} dir={f.dir} onSort={onSort} /><Th label="Договоров" field="contracts" sort={f.sort} dir={f.dir} onSort={onSort} className="num" />
            <Th label="Сумма" field="amount" sort={f.sort} dir={f.dir} onSort={onSort} className="num" /><Th label="Оплачено" field="paid" sort={f.sort} dir={f.dir} onSort={onSort} className="num" />
            <Th label="Долг" field="debt" sort={f.sort} dir={f.dir} onSort={onSort} className="num" /><Th label="План" field="planned" sort={f.sort} dir={f.dir} onSort={onSort} className="num" /><th>Исполнители</th></tr></thead>
            <tbody>{data?.items.map((s: any) => (
              <tr key={s.id}>
                <td className="max-w-80"><Link className="underline" href={`/suppliers/${s.id}`}>{s.name}</Link>{s.status === 'ARCHIVED' && <span className="badge b-mute ml-2">объединён</span>}{s.aliasCount > 1 && <span className="muted text-xs ml-2">{s.aliasCount} написаний</span>}</td>
                <td className="num">{s.contracts}</td>
                <td><PerCurrency items={s.byCurrency} field="amount" /></td><td><PerCurrency items={s.byCurrency} field="paid" tone="b-ok" /></td>
                <td><PerCurrency items={s.byCurrency} field="debt" tone="b-err" /></td><td><PerCurrency items={s.byCurrency} field="planned" tone="b-info" /></td>
                <td className="text-xs max-w-48">{s.executors.join(', ')}</td></tr>))}
              {data?.items.length === 0 && <tr><td colSpan={7} className="muted">Ничего не найдено</td></tr>}</tbody></table>
        </div>
        <div className="flex items-center gap-4"><span className="muted">{data ? `${data.total} контрагентов` : ''}</span>{data && <Pager page={f.page} pageSize={data.pageSize} total={data.total} onPage={(p) => setF({ ...f, page: p })} />}</div>
        {can('suppliers.manage') && (
          <div className="panel p-3 flex gap-2 flex-wrap items-center"><span className="muted">Новый контрагент:</span>
            <input className="input w-80" placeholder="Название" value={newName} onChange={(e) => setNewName(e.target.value)} /><button className="btn" disabled={newName.trim().length < 2} onClick={create}>Создать</button></div>)}
      </>)}

      {tab === 'dups' && <Duplicates groups={dups} canMerge={can('suppliers.merge')} onDone={() => { loadDups(); load(); }} setError={setError} />}
    </div>
  );
}

function Duplicates({ groups, canMerge, onDone, setError }: { groups: any[] | null; canMerge: boolean; onDone: () => void; setError: (s: string) => void }) {
  const [target, setTarget] = useState<Record<number, string>>({});
  if (!groups) return <p className="muted">Загрузка…</p>;
  if (!groups.length) return <p className="muted">Похожих названий не найдено.</p>;
  async function merge(i: number, g: any) {
    const t = target[i] ?? g.suppliers[0].id;
    const sources = g.suppliers.filter((s: any) => s.id !== t);
    const tName = g.suppliers.find((s: any) => s.id === t).name;
    if (!confirm(`Объединить в «${tName}»:\n${sources.map((s: any) => '• ' + s.name).join('\n')}\n\nДоговоры и написания будут перенесены, исходные карточки уйдут в архив. Действие записывается в журнал аудита.`)) return;
    try { await api('POST', '/suppliers/merge', { targetId: t, sourceIds: sources.map((s: any) => s.id), confirm: true }); onDone(); } catch (e) { setError((e as Error).message); }
  }
  return (
    <div className="space-y-3">
      <p className="muted text-sm">Система только предлагает совпадения по сходству названий или одинаковому ИНН — похожие названия могут быть разными компаниями. Выберите, какая карточка останется основной.</p>
      {groups.map((g, i) => (
        <section key={i} className="panel p-3 space-y-2">
          <div className="muted text-xs">Причина: {g.reasons.join(', ') || 'сходство названий'}</div>
          {g.suppliers.map((s: any) => (
            <label key={s.id} className="flex gap-2 items-start">
              {canMerge && <input type="radio" name={`g${i}`} checked={(target[i] ?? g.suppliers[0].id) === s.id} onChange={() => setTarget({ ...target, [i]: s.id })} />}
              <span><Link className="underline" href={`/suppliers/${s.id}`}>{s.name}</Link> <span className="muted text-xs">{s.contracts} договоров{s.taxId ? `, ИНН ${s.taxId}` : ''}{s.aliases.length > 1 ? `, написаний: ${s.aliases.length}` : ''}</span></span>
            </label>))}
          {canMerge ? <button className="btn" onClick={() => merge(i, g)}>Объединить в выбранную</button> : <span className="muted text-xs">Объединение доступно ролям MANAGER и администраторам</span>}
        </section>))}
    </div>
  );
}
