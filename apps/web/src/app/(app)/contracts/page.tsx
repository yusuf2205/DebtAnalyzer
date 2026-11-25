'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { api, money } from '@/lib/api';
import { useSession } from '@/lib/session';
import { CURRENCIES, ExportLink, Pager, qs, StateBadge, Th, TotalsStrip } from '@/lib/ui';

export default function Page() { return <Suspense fallback={<p className="muted">Загрузка…</p>}><Contracts /></Suspense>; }

function Contracts() {
  const { can } = useSession();
  const sp = useSearchParams();
  const p = (k: string, d = '') => sp.get(k) ?? d; // фильтры можно задавать ссылкой, например /contracts?state=OPEN&currency=USD
  const [f, setF] = useState({ q: p('q'), supplierId: p('supplierId'), project: p('project'), executor: p('executor'), currency: p('currency'), status: p('status', 'ACTIVE'), state: p('state'), sort: p('sort', 'created'), dir: p('dir', 'desc'), page: 1 });
  const [data, setData] = useState<any>(null);
  const [executors, setExecutors] = useState<string[]>([]);
  const [error, setError] = useState('');
  const query = qs({ ...f, pageSize: 50 });

  useEffect(() => { api('GET', '/contracts/facets').then((r) => setExecutors(r.executors)).catch(() => {}); }, []);
  useEffect(() => {
    const t = setTimeout(() => api('GET', `/contracts?${query}`).then(setData).catch((e) => setError(e.message)), 200);
    return () => clearTimeout(t);
  }, [query]);

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
        <select className="input" value={f.state} onChange={(e) => set({ state: e.target.value })}><option value="">Любое состояние</option><option value="OPEN">Есть долг</option><option value="UNPAID">Не оплачен</option><option value="PARTIAL">Частично</option><option value="PAID">Оплачен</option><option value="OVERPAID">Переплата</option></select>
        <select className="input" value={f.status} onChange={(e) => set({ status: e.target.value })}><option value="ACTIVE">Активные</option><option value="ARCHIVED">Архив</option><option value="ALL">Все</option></select>
        {f.supplierId && <button className="btn" onClick={() => set({ supplierId: '' })}>Сбросить фильтр по контрагенту ✕</button>}
      </div>
      <TotalsStrip totals={data?.totals ?? []} />
      <div className="panel overflow-auto" style={{ maxHeight: '62vh' }}>
        <table className="tbl"><thead><tr>
          <Th label="Договор" field="number" sort={f.sort} dir={f.dir} onSort={onSort} /><Th label="Контрагент" field="supplier" sort={f.sort} dir={f.dir} onSort={onSort} /><Th label="Проект" field="project" sort={f.sort} dir={f.dir} onSort={onSort} />
          <th>Вал.</th><Th label="Сумма" field="amount" sort={f.sort} dir={f.dir} onSort={onSort} className="num" /><th className="num">Оплачено</th><Th label="Долг" field="debt" sort={f.sort} dir={f.dir} onSort={onSort} className="num" /><th>Состояние</th><th>Исполнитель</th></tr></thead>
          <tbody>{data?.items.map((c: any) => (
            <tr key={c.id} style={c.status === 'ARCHIVED' ? { opacity: .55 } : undefined}>
              <td className="max-w-72"><Link className="underline" href={`/contracts/${c.id}`}>{c.number ?? '—'}</Link>{c.status === 'ARCHIVED' && <span className="badge b-mute ml-2">архив</span>}</td>
              <td className="max-w-56"><Link href={`/suppliers/${c.supplier.id}`}>{c.supplier.name}</Link></td><td className="max-w-40 truncate" title={c.project ?? ''}>{c.project}</td>
              <td>{c.currency}</td><td className="num">{money(c.amount)}</td><td className="num b-ok">{money(c.openingPaid)}</td><td className="num b-err">{Number(c.debt) ? money(c.debt) : '—'}</td>
              <td><StateBadge state={c.state} /></td><td>{c.executor}</td></tr>))}
            {data?.items.length === 0 && <tr><td colSpan={9} className="muted">Ничего не найдено</td></tr>}</tbody></table>
      </div>
      <div className="flex items-center gap-4"><span className="muted">{data ? `${data.total} договоров` : ''}</span>{data && <Pager page={f.page} pageSize={data.pageSize} total={data.total} onPage={(p) => setF({ ...f, page: p })} />}</div>
    </div>
  );
}
