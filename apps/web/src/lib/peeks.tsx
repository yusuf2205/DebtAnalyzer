'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, ApiError, money } from './api';
import { PeekShell, Row, Tile } from './peek-shell';
import { useSession } from './session';
import { PAY_KIND, PayBadge, StateBadge } from './ui';

const num = (v: any) => Number(v ?? 0);
const dt = (v: string) => new Date(v).toLocaleDateString('ru-RU');

function useLoad<T = any>(path: string, tick = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    setData(null); setError('');
    api<T>('GET', path).then((r) => alive && setData(r)).catch((e) => alive && setError(e.message));
    return () => { alive = false; };
  }, [path, tick]);
  return { data, error };
}

/** Краткая панель контрагента: итоги по валютам, договоры с наибольшим долгом, последние платежи. */
export function SupplierPeek({ id, onClose }: { id: string; onClose: () => void }) {
  const { can } = useSession();
  const { data: s, error } = useLoad(`/suppliers/${id}`);
  const { data: pays } = useLoad<any>(`/payments?supplierId=${id}&pageSize=5`);
  const contracts: any[] = s ? [...s.contracts].filter((c) => c.status === 'ACTIVE').sort((a, b) => num(b.debt) - num(a.debt)) : [];

  return (
    <PeekShell label="Краткая карточка контрагента" focusKey={id} onClose={onClose}
      title={<>{s ? s.name : 'Загрузка…'}{s?.status === 'ARCHIVED' && <span className="badge b-mute ml-2">объединён</span>}</>}
      subtitle={s && (s.taxId ? `ИНН ${s.taxId}` : 'ИНН не указан')}>
      {error && <p role="alert" className="b-err px-4">{error}</p>}
      {s && (
        <div className="px-4 pb-4 space-y-4 overflow-y-auto">
          <section className="space-y-2">
            <h3 className="text-sm font-semibold">Итоги по валютам</h3>
            {s.totals.length === 0 ? <p className="muted text-sm">Активных договоров нет.</p> : s.totals.map((t: any) => (
              <div key={t.currency} className="panel px-3 py-2 text-sm">
                <div className="flex justify-between"><b>{t.currency}</b><span className="muted">договоров: {t.contracts}</span></div>
                <div className="grid grid-cols-2 gap-x-4 tabular-nums">
                  <span className="muted">Сумма</span><span className="text-right">{money(t.amount)}</span>
                  <span className="muted">Оплачено</span><span className="text-right b-ok">{money(t.paid)}</span>
                  <span className="muted">Долг</span><span className="text-right b-err">{num(t.debt) ? money(t.debt) : '—'}</span>
                  <span className="muted">План</span><span className="text-right b-info">{num(t.planned) ? money(t.planned) : '—'}</span>
                </div>
              </div>))}
          </section>

          <section>
            <h3 className="text-sm font-semibold b-err">Договоры с наибольшим долгом</h3>
            {contracts.length === 0 ? <p className="muted text-sm">Нет.</p> : (
              <ul className="text-sm">{contracts.slice(0, 5).map((c) => (
                <li key={c.id} className="flex items-baseline justify-between gap-3 py-1">
                  <span className="min-w-0"><Link className="underline block truncate" href={`/contracts/${c.id}`}>{c.number ?? '—'}</Link><StateBadge state={c.state} /></span>
                  <span className="tabular-nums shrink-0 text-right">{num(c.debt) ? <span className="b-err">{money(c.debt)} {c.currency}</span> : <span className="muted">—</span>}</span></li>))}</ul>)}
            {contracts.length > 5 && <p className="muted text-xs">Показаны 5 из {contracts.length} активных договоров.</p>}
          </section>

          <section>
            <h3 className="text-sm font-semibold b-ok">Последние платежи</h3>
            {!pays ? <p className="muted text-sm">Загрузка…</p> : pays.items.length === 0 ? <p className="muted text-sm">Платежей в приложении нет.</p> : (
              <ul className="text-sm">{pays.items.map((p: any) => (
                <li key={p.id} className="flex items-center justify-between gap-3 py-1">
                  <span><Link className="underline" href={`/payments/${p.id}`}>{dt(p.paymentDate)}</Link> <span className="muted text-xs">{PAY_KIND[p.kind]}</span> <PayBadge status={p.status} /></span>
                  <span className={`tabular-nums shrink-0 ${p.kind === 'PAYMENT' ? 'b-ok' : 'b-err'}`}>{money(p.amount)} {p.currency}</span></li>))}</ul>)}
          </section>

          <dl className="text-sm"><Row k="Написаний названия" v={String(s.aliases.length)} /></dl>
          <div className="flex gap-2 flex-wrap pt-1">
            <Link href={`/suppliers/${id}`} className="btn btn-primary">Открыть полностью</Link>
            {can('contracts.manage') && s.status === 'ACTIVE' && <Link href={`/contracts/new?supplierId=${id}`} className="btn">Новый договор</Link>}
            <Link href={`/contracts?supplierId=${id}`} className="btn">Все договоры</Link>
            {can('reports.view') && <Link href={`/reports?report=supplier-statement&supplierId=${id}&supplierName=${encodeURIComponent(s.name)}`} className="btn">Акт сверки</Link>}
          </div>
        </div>)}
    </PeekShell>
  );
}

/** Краткая панель платежа: что, кому, по какому договору, кто создал и подтвердил. */
export function PaymentPeek({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged?: () => void }) {
  const { me, can } = useSession();
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [actErr, setActErr] = useState('');
  const { data: p, error } = useLoad(`/payments/${id}`, tick);
  const done = () => { setTick((t) => t + 1); onChanged?.(); };
  const own = !!p && p.createdBy?.id === me?.id && me?.role !== 'SUPER_ADMIN';

  async function approve() {
    setBusy(true); setActErr('');
    try { await api('POST', `/payments/${id}/approve`, {}); done(); }
    catch (e) {
      if (e instanceof ApiError && e.code === 'OVERPAYMENT' && confirm(`${e.message}\n\nПодтвердить с переплатой?`)) {
        try { await api('POST', `/payments/${id}/approve`, { confirmOverpayment: true }); done(); } catch (e2) { setActErr((e2 as Error).message); }
      } else setActErr((e as Error).message);
    } finally { setBusy(false); }
  }
  async function reject() {
    const reason = prompt('Причина отклонения (не менее 3 символов):');
    if (!reason || reason.trim().length < 3) return;
    setBusy(true); setActErr('');
    try { await api('POST', `/payments/${id}/reject`, { reason: reason.trim() }); done(); } catch (e) { setActErr((e as Error).message); } finally { setBusy(false); }
  }
  const sign = p && p.kind !== 'PAYMENT' ? '−' : '';
  return (
    <PeekShell label="Краткая карточка платежа" focusKey={id} onClose={onClose}
      title={p ? <>{PAY_KIND[p.kind]} <span className={p.kind === 'PAYMENT' ? 'b-ok' : 'b-err'}>{sign}{money(p.amount)} {p.currency}</span></> : 'Загрузка…'}
      subtitle={p && <>{dt(p.paymentDate)}</>}>
      {error && <p role="alert" className="b-err px-4">{error}</p>}
      {p && (
        <div className="px-4 pb-4 space-y-4 overflow-y-auto">
          <div className="flex items-center gap-2 flex-wrap"><PayBadge status={p.status} />
            {p.reversedByPaymentId && <span className="badge b-mute">сторнирован</span>}{p.reflectedInOpening && <span className="badge b-info">в остатке</span>}</div>
          <dl className="text-sm space-y-1">
            <div className="flex gap-2"><dt className="muted shrink-0">Контрагент:</dt><dd><Link className="underline" href={`/suppliers/${p.supplier.id}`}>{p.supplier.name}</Link></dd></div>
            <div className="flex gap-2"><dt className="muted shrink-0">Договор:</dt><dd><Link className="underline" href={`/contracts/${p.contract.id}`}>{p.contract.number}</Link></dd></div>
            <Row k="Документ" v={p.bankDocument} /><Row k="Транзакция" v={p.transactionNo} /><Row k="Комментарий" v={p.comment} />
            <Row k="Создал" v={p.createdBy?.name} />
            <Row k="Документов" v={p.documentCount ? `${p.documentCount} (в полной карточке)` : 'нет'} />
            {p.approvedBy && <Row k="Подтвердил" v={`${p.approvedBy.name ?? '—'}${p.approvedAt ? `, ${dt(p.approvedAt)}` : ''}`} />}
            {p.status === 'REJECTED' && <Row k="Причина отклонения" v={p.rejectReason} />}
          </dl>
          {p.status === 'PENDING' && <p className="text-xs muted">Ожидает подтверждения: сумма пока не уменьшает долг. Подтвердить может сотрудник с правом подтверждения, но не тот, кто создал платёж.</p>}
          {actErr && <p role="alert" className="b-err text-sm">{actErr}</p>}
          {p.status === 'PENDING' && can('payments.approve') && (
            <div className="flex gap-2 flex-wrap">
              <button className="btn btn-primary" disabled={busy || own} title={own ? 'Платёж не может подтверждать тот, кто его создал' : ''} onClick={approve}>Подтвердить</button>
              <button className="btn" disabled={busy} onClick={reject}>Отклонить</button>
            </div>)}
          <div className="flex gap-2 flex-wrap pt-1">
            <Link href={`/payments/${id}`} className="btn btn-primary">Открыть полностью</Link>
            <Link href={`/contracts/${p.contract.id}`} className="btn">К договору</Link>
          </div>
        </div>)}
    </PeekShell>
  );
}
