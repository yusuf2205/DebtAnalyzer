'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, money } from '@/lib/api';
import { useSession } from '@/lib/session';
import { PAY_KIND, PayBadge } from '@/lib/ui';

export default function PaymentPage() {
  const { id } = useParams<{ id: string }>();
  const { me, can } = useSession();
  const [p, setP] = useState<any>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState<any>(null);
  const [correct, setCorrect] = useState<any>(null);

  const load = useCallback(() => api('GET', `/payments/${id}`).then(setP).catch((e) => setError(e.message)), [id]);
  useEffect(() => { load(); }, [load]);
  const act = async (fn: () => Promise<any>) => { setBusy(true); setError(''); try { await fn(); await load(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };

  if (!p) return <p className="muted">{error || 'Загрузка…'}</p>;
  const mine = p.createdBy.id === me?.id, superAdmin = me?.role === 'SUPER_ADMIN';
  const canEdit = (p.status === 'DRAFT' || p.status === 'REJECTED') && (mine || superAdmin) && can('payments.create');
  const reversible = p.status === 'APPROVED' && p.kind !== 'REVERSAL' && !p.reversedByPaymentId && can('payments.reverse');
  const ownApproval = mine && !superAdmin;

  async function approve() {
    setBusy(true); setError('');
    try { await api('POST', `/payments/${id}/approve`, {}); }
    catch (e) {
      if (e instanceof ApiError && e.code === 'OVERPAYMENT' && confirm(`${e.message}\n\nПодтвердить с переплатой?`)) {
        try { await api('POST', `/payments/${id}/approve`, { confirmOverpayment: true }); } catch (e2) { setError((e2 as Error).message); }
      } else setError((e as Error).message);
    } finally { setBusy(false); await load(); }
  }
  const ask = (t: string) => { const v = prompt(t); return v && v.trim().length >= 3 ? v.trim() : null; };

  return (
    <div className="space-y-4 max-w-4xl">
      <div>
        <Link href="/payments" className="muted text-sm">← Платежи</Link>
        <h1 className="text-xl font-semibold">{PAY_KIND[p.kind]} {money(p.amount, p.currency)} <PayBadge status={p.status} /></h1>
        <p className="muted"><Link className="underline" href={`/suppliers/${p.supplier.id}`}>{p.supplier.name}</Link> · <Link className="underline" href={`/contracts/${p.contract.id}`}>{p.contract.number}</Link> · {new Date(p.paymentDate).toLocaleDateString('ru-RU')}</p>
      </div>
      {error && <p role="alert" className="b-err">{error}</p>}

      <div className="flex gap-2 flex-wrap">
        {canEdit && !edit && <button className="btn" onClick={() => setEdit({ amount: p.amount, paymentDate: p.paymentDate, bankDocument: p.bankDocument ?? '', transactionNo: p.transactionNo ?? '', comment: p.comment ?? '' })}>Редактировать</button>}
        {canEdit && p.status === 'DRAFT' && <button className="btn btn-primary" disabled={busy} onClick={() => act(() => api('POST', `/payments/${id}/submit`))}>Отправить на подтверждение</button>}
        {p.status === 'PENDING' && can('payments.approve') && <>
          <button className="btn btn-primary" disabled={busy || ownApproval} title={ownApproval ? 'Платёж не может подтверждать тот, кто его создал' : ''} onClick={approve}>Подтвердить</button>
          <button className="btn" disabled={busy} onClick={() => { const r = ask('Причина отклонения (не менее 3 символов):'); if (r) act(() => api('POST', `/payments/${id}/reject`, { reason: r })); }}>Отклонить</button></>}
        {(p.status === 'DRAFT' || p.status === 'PENDING' || p.status === 'REJECTED') && (mine || can('payments.approve')) && can('payments.create') &&
          <button className="btn" disabled={busy} onClick={() => confirm('Отменить платёж?') && act(() => api('POST', `/payments/${id}/cancel`, {}))}>Отменить</button>}
        {reversible && <>
          <button className="btn" disabled={busy} onClick={() => { const r = ask('Причина сторно (не менее 3 символов). Будет создана отдельная запись, оригинал останется в истории:'); if (r) act(() => api('POST', `/payments/${id}/reverse`, { reason: r })); }}>Сторнировать</button>
          <button className="btn" disabled={busy} onClick={() => setCorrect({ reason: '', amount: p.amount, paymentDate: p.paymentDate, bankDocument: p.bankDocument ?? '', transactionNo: p.transactionNo ?? '', comment: p.comment ?? '' })}>Исправить</button></>}
      </div>
      {ownApproval && p.status === 'PENDING' && <p className="muted text-xs">Подтвердить этот платёж должен другой сотрудник (разделение обязанностей).</p>}
      {p.status === 'REJECTED' && <p className="b-err text-sm">Отклонён: {p.rejectReason} ({p.rejectedBy?.name}). Исправьте данные и отправьте снова.</p>}

      {edit && (
        <section className="panel p-4 space-y-3">
          <h2 className="font-semibold">Редактирование</h2>
          <div className="grid sm:grid-cols-2 gap-3">
            {([['amount', 'Сумма'], ['paymentDate', 'Дата'], ['bankDocument', 'Банковский документ'], ['transactionNo', 'Номер транзакции'], ['comment', 'Комментарий']] as const).map(([k, l]) => (
              <label key={k} className="block space-y-1"><span className="muted text-xs">{l}</span><input className="input w-full" type={k === 'paymentDate' ? 'date' : 'text'} value={edit[k]} onChange={(e) => setEdit({ ...edit, [k]: e.target.value })} /></label>))}
          </div>
          <div className="flex gap-2"><button className="btn btn-primary" disabled={busy} onClick={() => act(async () => { await api('PATCH', `/payments/${id}`, { ...edit, bankDocument: edit.bankDocument || undefined, transactionNo: edit.transactionNo || undefined, comment: edit.comment || undefined }); setEdit(null); })}>Сохранить</button><button className="btn" onClick={() => setEdit(null)}>Отмена</button></div>
        </section>)}

      {correct && (
        <section className="panel p-4 space-y-3" style={{ borderColor: 'var(--pending)' }}>
          <h2 className="font-semibold b-warn">Исправление платежа</h2>
          <p className="text-sm">Оригинал будет сторнирован, а новый платёж с исправленными данными уйдёт на подтверждение. Пока он не подтверждён, оплата по договору не учитывается.</p>
          <div className="grid sm:grid-cols-2 gap-3">
            {([['amount', 'Новая сумма'], ['paymentDate', 'Дата'], ['bankDocument', 'Банковский документ'], ['transactionNo', 'Номер транзакции']] as const).map(([k, l]) => (
              <label key={k} className="block space-y-1"><span className="muted text-xs">{l}</span><input className="input w-full" type={k === 'paymentDate' ? 'date' : 'text'} value={correct[k]} onChange={(e) => setCorrect({ ...correct, [k]: e.target.value })} /></label>))}
            <label className="block space-y-1 sm:col-span-2"><span className="muted text-xs">Причина исправления *</span><input className="input w-full" value={correct.reason} onChange={(e) => setCorrect({ ...correct, reason: e.target.value })} /></label>
          </div>
          <div className="flex gap-2"><button className="btn btn-primary" disabled={busy || correct.reason.trim().length < 3}
            onClick={() => act(async () => { const r = await api('POST', `/payments/${id}/correct`, { ...correct, bankDocument: correct.bankDocument || undefined, transactionNo: correct.transactionNo || undefined, comment: undefined, idempotencyKey: crypto.randomUUID() }); location.href = `/payments/${r.id}`; })}>Сторнировать и создать исправленный</button>
            <button className="btn" onClick={() => setCorrect(null)}>Отмена</button></div>
        </section>)}

      <section className="panel p-4">
        <dl className="grid sm:grid-cols-2 gap-x-6 gap-y-1 text-sm">
          <div><dt className="muted inline">Банковский документ: </dt><dd className="inline">{p.bankDocument ?? '—'}</dd></div><div><dt className="muted inline">Номер транзакции: </dt><dd className="inline">{p.transactionNo ?? '—'}</dd></div>
          <div><dt className="muted inline">Создал: </dt><dd className="inline">{p.createdBy.name} · {new Date(p.createdAt).toLocaleString('ru-RU')}</dd></div>
          <div><dt className="muted inline">Подтвердил: </dt><dd className="inline">{p.approvedBy ? `${p.approvedBy.name} · ${new Date(p.approvedAt).toLocaleString('ru-RU')}` : '—'}</dd></div>
          <div><dt className="muted inline">Влияние на оплату: </dt><dd className="inline">{p.signedAmount ? money(p.signedAmount, p.currency) : '—'}</dd></div>
          <div className="sm:col-span-2"><dt className="muted inline">Комментарий: </dt><dd className="inline">{p.comment ?? '—'}</dd></div>
          {p.reflectedInOpening && <div className="sm:col-span-2 b-info">Платёж учтён в начальном остатке (сверка с источником) — повторно из долга не вычитается.</div>}
          {p.reversedByPaymentId && <div className="sm:col-span-2 b-err">Сторнирован: <Link className="underline" href={`/payments/${p.reversedByPaymentId}`}>запись сторно</Link></div>}
          {p.reversesPaymentId && <div className="sm:col-span-2">Сторно платежа: <Link className="underline" href={`/payments/${p.reversesPaymentId}`}>оригинал</Link>{p.reversalReason ? ` — ${p.reversalReason}` : ''}</div>}
          {p.correctsPaymentId && <div className="sm:col-span-2">Исправляет платёж: <Link className="underline" href={`/payments/${p.correctsPaymentId}`}>оригинал</Link></div>}
        </dl>
      </section>

      <section className="panel p-4 space-y-2">
        <h2 className="font-semibold">Журнал операций</h2>
        <ul className="text-sm space-y-1">{p.history.map((h: any) => <li key={h.id}><span className="muted">{new Date(h.at).toLocaleString('ru-RU')}</span> · {h.userEmail ?? 'система'} · <b>{h.action}</b>{h.meta?.reason && <> — {h.meta.reason}</>}</li>)}</ul>
      </section>
    </div>
  );
}
