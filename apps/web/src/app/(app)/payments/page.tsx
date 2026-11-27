'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { api, money } from '@/lib/api';
import { useSession } from '@/lib/session';
import { CURRENCIES, ExportLink, PAY_KIND, PAY_STATUS, PayBadge, PagerBar, qs, usePageSize } from '@/lib/ui';

export default function Page() { return <Suspense fallback={<p className="muted">Загрузка…</p>}><Payments /></Suspense>; }

function Payments() {
  const { can } = useSession();
  const sp = useSearchParams();
  const [f, setF] = useState({ status: sp.get('status') ?? '', kind: '', currency: '', q: '', from: '', to: '', contractId: sp.get('contractId') ?? '', supplierId: sp.get('supplierId') ?? '', page: 1 });
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState('');
  const [pageSize, setPageSize] = usePageSize('payments');
  const query = qs({ ...f, pageSize });
  useEffect(() => {
    const t = setTimeout(() => api('GET', `/payments?${query}`).then(setData).catch((e) => setError(e.message)), 200);
    return () => clearTimeout(t);
  }, [query]);
  const set = (p: Partial<typeof f>) => setF((s) => ({ ...s, page: 1, ...p }));
  const pending = data?.byStatus?.PENDING ?? 0;

  return (
    <div className="space-y-4 max-w-7xl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div><h1 className="text-xl font-semibold">Платежи</h1><p className="muted">Фактические оплаты. В долг засчитываются только подтверждённые платежи.</p></div>
        <div className="flex gap-2">
          {can('reports.export') && <ExportLink href={`/payments/export?${qs({ ...f, page: undefined })}`}>Экспорт в Excel</ExportLink>}
          {can('payments.create') && <Link className="btn btn-primary" href="/payments/new">Новый платёж</Link>}
        </div>
      </div>
      {error && <p role="alert" className="b-err">{error}</p>}
      <nav className="flex gap-1 flex-wrap">
        <button className="btn" style={!f.status ? { background: 'var(--border)', fontWeight: 600 } : undefined} onClick={() => set({ status: '' })}>Все</button>
        <button className="btn" style={f.status === 'PENDING' ? { background: 'var(--border)', fontWeight: 600 } : undefined} onClick={() => set({ status: 'PENDING' })}>Ожидают подтверждения{pending ? <span className="badge b-warn ml-2">{pending}</span> : null}</button>
      </nav>
      <div className="flex gap-2 flex-wrap">
        <input className="input" placeholder="Поиск: договор, поставщик, документ, транзакция…" value={f.q} onChange={(e) => set({ q: e.target.value })} />
        <select className="input" value={f.status} onChange={(e) => set({ status: e.target.value })}><option value="">Все статусы</option>{Object.entries(PAY_STATUS).map(([k, v]) => <option key={k} value={k}>{v[0]}</option>)}</select>
        <select className="input" value={f.kind} onChange={(e) => set({ kind: e.target.value })}><option value="">Все типы</option>{Object.entries(PAY_KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        <select className="input" value={f.currency} onChange={(e) => set({ currency: e.target.value })}><option value="">Все валюты</option>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</select>
        <label className="flex items-center gap-1 muted text-xs">с<input className="input" type="date" value={f.from} onChange={(e) => set({ from: e.target.value })} /></label>
        <label className="flex items-center gap-1 muted text-xs">по<input className="input" type="date" value={f.to} onChange={(e) => set({ to: e.target.value })} /></label>
        {(f.contractId || f.supplierId) && <button className="btn" onClick={() => set({ contractId: '', supplierId: '' })}>Сбросить фильтр по договору/контрагенту ✕</button>}
      </div>
      {data?.totals?.length > 0 && (
        <div className="panel overflow-x-auto"><table className="tbl"><thead><tr><th>Валюта</th><th className="num">Подтверждено (чистая оплата)</th><th className="num">Ожидает подтверждения</th></tr></thead>
          <tbody>{data.totals.map((t: any) => <tr key={t.currency}><td><b>{t.currency}</b></td><td className="num b-ok">{money(t.approvedNet)}</td><td className="num b-warn">{Number(t.pending) ? money(t.pending) : '—'}</td></tr>)}</tbody></table></div>)}
      <div className="panel overflow-auto" style={{ maxHeight: '62vh' }}>
        <table className="tbl"><thead><tr><th>Дата</th><th>Контрагент</th><th>Договор</th><th>Тип</th><th className="num">Сумма</th><th>Вал.</th><th>Статус</th><th>Документ / транзакция</th><th>Создал</th></tr></thead>
          <tbody>{data?.items.map((p: any) => (
            <tr key={p.id}>
              <td><Link className="underline" href={`/payments/${p.id}`}>{new Date(p.paymentDate).toLocaleDateString('ru-RU')}</Link></td>
              <td className="max-w-56"><Link href={`/suppliers/${p.supplier.id}`}>{p.supplier.name}</Link></td><td className="max-w-48 truncate"><Link href={`/contracts/${p.contract.id}`}>{p.contract.number}</Link></td>
              <td>{PAY_KIND[p.kind]}</td><td className={`num ${p.kind === 'PAYMENT' ? 'b-ok' : 'b-err'}`}>{p.kind === 'PAYMENT' ? '' : '−'}{money(p.amount)}</td><td>{p.currency}</td>
              <td><PayBadge status={p.status} />{p.reversedByPaymentId && <span className="badge b-mute ml-1">сторнирован</span>}{p.reflectedInOpening && <span className="badge b-info ml-1">в остатке</span>}</td>
              <td className="text-xs">{[p.bankDocument, p.transactionNo].filter(Boolean).join(' / ')}</td><td className="text-xs">{p.createdBy.name}</td></tr>))}
            {data?.items.length === 0 && <tr><td colSpan={9} className="muted">Платежей нет</td></tr>}</tbody></table>
      </div>
      {data && <PagerBar page={f.page} pageSize={pageSize} total={data.total} noun="платежей" onPage={(p) => setF({ ...f, page: p })} onPageSize={(n) => { setPageSize(n); setF({ ...f, page: 1 }); }} />}
    </div>
  );
}
