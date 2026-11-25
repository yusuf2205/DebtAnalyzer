'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, money } from '@/lib/api';

export default function Page() { return <Suspense fallback={<p className="muted">Загрузка…</p>}><NewPayment /></Suspense>; }

function NewPayment() {
  const router = useRouter();
  const sp = useSearchParams();
  const key = useRef(crypto.randomUUID()); // ключ идемпотентности формы: повторная отправка не создаст второй платёж
  const today = new Date().toISOString().slice(0, 10);
  const [contract, setContract] = useState<any>(null);
  const [search, setSearch] = useState('');
  const [found, setFound] = useState<any[]>([]);
  const [f, setF] = useState({ paymentDate: today, amount: '', kind: 'PAYMENT', bankDocument: '', transactionNo: '', comment: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { const id = sp.get('contractId'); if (id) api('GET', `/contracts/${id}`).then(setContract).catch(() => {}); }, [sp]);
  useEffect(() => {
    if (search.trim().length < 2) { setFound([]); return; }
    const t = setTimeout(() => api('GET', `/contracts?q=${encodeURIComponent(search)}&status=ACTIVE&pageSize=8`).then((r) => setFound(r.items)).catch(() => {}), 200);
    return () => clearTimeout(t);
  }, [search]);

  async function send(submit: boolean, confirmDuplicate = false) {
    if (!contract) return setError('Выберите договор');
    setBusy(true); setError('');
    const body: any = { contractId: contract.id, ...f, idempotencyKey: key.current, submit, confirmDuplicate };
    for (const k of ['bankDocument', 'transactionNo', 'comment']) if (!body[k]) delete body[k];
    try { const r = await api<{ id: string }>('POST', '/payments', body); router.push(`/payments/${r.id}`); }
    catch (e) {
      if (e instanceof ApiError && e.code === 'DUPLICATE_SUSPECT' && confirm(`${e.message}\n\nСоздать ещё один платёж?`)) return send(submit, true);
      setError((e as Error).message);
    } finally { setBusy(false); }
  }

  return (
    <form onSubmit={(e: FormEvent) => { e.preventDefault(); send(true); }} className="space-y-4 max-w-3xl">
      <div><Link href="/payments" className="muted text-sm">← Платежи</Link><h1 className="text-xl font-semibold">Новый платёж</h1></div>
      {error && <p role="alert" className="b-err">{error}</p>}
      <section className="panel p-4 space-y-2">
        <span className="muted text-xs">Договор</span>
        {contract ? (
          <div className="space-y-1">
            <div className="flex gap-2 items-center flex-wrap"><b>{contract.number}</b><span className="muted">{contract.supplier.name}</span><button type="button" className="btn" onClick={() => setContract(null)}>Изменить</button></div>
            <p className="text-sm">Сумма {money(contract.amount, contract.currency)} · оплачено {money(contract.paid, contract.currency)} · <b className="b-err">долг {money(contract.debt, contract.currency)}</b></p>
          </div>) : (<>
          <input className="input w-full" placeholder="Номер договора, поставщик, товар…" value={search} onChange={(e) => setSearch(e.target.value)} />
          <ul>{found.map((c) => <li key={c.id}><button type="button" className="underline py-1 text-left" onClick={() => api('GET', `/contracts/${c.id}`).then(setContract)}>{c.number} — {c.supplier.name} ({c.currency}, долг {money(c.debt)})</button></li>)}</ul></>)}
      </section>
      <section className="panel p-4 grid sm:grid-cols-2 gap-3">
        <label className="block space-y-1"><span className="muted text-xs">Тип</span><select className="input w-full" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="PAYMENT">Оплата поставщику</option><option value="REFUND">Возврат от поставщика</option></select></label>
        <label className="block space-y-1"><span className="muted text-xs">Дата оплаты *</span><input className="input w-full" type="date" required max={today} value={f.paymentDate} onChange={(e) => setF({ ...f, paymentDate: e.target.value })} /></label>
        <label className="block space-y-1"><span className="muted text-xs">Сумма{contract ? `, ${contract.currency}` : ''} *</span><input className="input w-full" required inputMode="decimal" pattern="\d+(\.\d{1,2})?" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></label>
        <label className="block space-y-1"><span className="muted text-xs">Банковский документ (№ поручения)</span><input className="input w-full" value={f.bankDocument} onChange={(e) => setF({ ...f, bankDocument: e.target.value })} /></label>
        <label className="block space-y-1"><span className="muted text-xs">Номер транзакции</span><input className="input w-full" value={f.transactionNo} onChange={(e) => setF({ ...f, transactionNo: e.target.value })} /></label>
        <label className="block space-y-1 sm:col-span-2"><span className="muted text-xs">Комментарий</span><textarea className="input w-full" rows={2} value={f.comment} onChange={(e) => setF({ ...f, comment: e.target.value })} /></label>
      </section>
      <p className="muted text-xs">Валюта платежа всегда равна валюте договора. Платёж уменьшит долг только после подтверждения другим сотрудником с правом подтверждения.</p>
      <div className="flex gap-2"><button className="btn btn-primary" disabled={busy || !contract}>Отправить на подтверждение</button><button type="button" className="btn" disabled={busy || !contract} onClick={() => send(false)}>Сохранить черновик</button></div>
    </form>
  );
}
