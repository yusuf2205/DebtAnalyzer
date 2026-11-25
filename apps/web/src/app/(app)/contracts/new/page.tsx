'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { CURRENCIES } from '@/lib/ui';

export default function Page() { return <Suspense fallback={<p className="muted">Загрузка…</p>}><NewContract /></Suspense>; }

function NewContract() {
  const router = useRouter();
  const sp = useSearchParams();
  const [supplier, setSupplier] = useState<{ id: string; name: string } | null>(null);
  const [search, setSearch] = useState('');
  const [found, setFound] = useState<any[]>([]);
  const [f, setF] = useState({ number: '', contractDate: '', project: '', goods: '', amount: '', currency: 'USD', openingPaid: '0', executor: '', notes: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { const id = sp.get('supplierId'); if (id) api('GET', `/suppliers/${id}`).then((s) => setSupplier({ id: s.id, name: s.name })).catch(() => {}); }, [sp]);
  useEffect(() => {
    if (search.trim().length < 2) { setFound([]); return; }
    const t = setTimeout(() => api('GET', `/suppliers?q=${encodeURIComponent(search)}&pageSize=8`).then((r) => setFound(r.items)).catch(() => {}), 200);
    return () => clearTimeout(t);
  }, [search]);

  async function submit(e: FormEvent) {
    e.preventDefault(); if (!supplier) return setError('Выберите контрагента');
    setBusy(true); setError('');
    const body: any = { supplierId: supplier.id, ...f };
    for (const k of ['contractDate', 'project', 'goods', 'executor', 'notes']) if (!body[k]) delete body[k];
    try { const r = await api<{ id: string }>('POST', '/contracts', body); router.push(`/contracts/${r.id}`); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  const inp = (k: keyof typeof f, label: string, extra: object = {}) => (
    <label className="block space-y-1"><span className="muted text-xs">{label}</span><input className="input w-full" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} {...extra} /></label>);

  return (
    <form onSubmit={submit} className="space-y-4 max-w-3xl">
      <div><Link href="/contracts" className="muted text-sm">← Договоры</Link><h1 className="text-xl font-semibold">Новый договор</h1></div>
      {error && <p role="alert" className="b-err">{error}</p>}
      <section className="panel p-4 space-y-2">
        <span className="muted text-xs">Контрагент</span>
        {supplier ? <div className="flex gap-2 items-center"><b>{supplier.name}</b><button type="button" className="btn" onClick={() => setSupplier(null)}>Изменить</button></div> : (<>
          <input className="input w-full" placeholder="Начните вводить название…" value={search} onChange={(e) => setSearch(e.target.value)} />
          <ul>{found.map((s) => <li key={s.id}><button type="button" className="underline py-1" onClick={() => setSupplier({ id: s.id, name: s.name })}>{s.name}</button></li>)}</ul>
          <p className="muted text-xs">Нет в списке? Сначала создайте контрагента в разделе «Контрагенты».</p></>)}
      </section>
      <section className="panel p-4 grid sm:grid-cols-2 gap-3">
        {inp('number', 'Номер договора *', { required: true })}{inp('contractDate', 'Дата договора', { type: 'date' })}
        {inp('project', 'Проект')}{inp('goods', 'Товар')}
        {inp('amount', 'Сумма *', { required: true, inputMode: 'decimal', pattern: '\\d+(\\.\\d{1,2})?' })}
        <label className="block space-y-1"><span className="muted text-xs">Валюта *</span><select className="input w-full" value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })}>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</select></label>
        {inp('openingPaid', 'Начальный оплаченный остаток', { inputMode: 'decimal', pattern: '\\d+(\\.\\d{1,2})?' })}{inp('executor', 'Исполнитель')}
        <label className="block space-y-1 sm:col-span-2"><span className="muted text-xs">Примечание</span><textarea className="input w-full" rows={3} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></label>
      </section>
      <p className="muted text-xs">Начальный остаток — оплата, уже произведённая до учёта в системе. Новые оплаты регистрируются как платежи (этап M4) и требуют подтверждения.</p>
      <button className="btn btn-primary" disabled={busy || !supplier}>Создать договор</button>
    </form>
  );
}
