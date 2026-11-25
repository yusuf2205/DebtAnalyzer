'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, money } from '@/lib/api';
import { useSession } from '@/lib/session';
import { PAY_KIND } from '@/lib/ui';

const ST: Record<string, [string, string]> = { PENDING: ['Ожидает проверки', 'b-warn'], MATCHED: ['Сопоставлено', 'b-info'], CONFIRMED: ['Подтверждено', 'b-ok'], REJECTED: ['Отклонено', 'b-mute'] };
const FIELD: Record<string, string> = { openingPaid: 'Оплачено (историческое)', amount: 'Сумма договора', currency: 'Валюта' };

export default function ReconciliationPage() {
  const [tab, setTab] = useState<'open' | 'closed' | 'dups'>('open');
  const [stats, setStats] = useState<any>(null);
  const [items, setItems] = useState<any[] | null>(null);
  const [dups, setDups] = useState<any[] | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api('GET', '/reconciliation/stats').then(setStats).catch((e) => setError(e.message));
    if (tab === 'dups') api<any[]>('GET', '/reconciliation/duplicates').then(setDups).catch((e) => setError(e.message));
    else api('GET', `/reconciliation?open=${tab === 'open'}&pageSize=100`).then((r) => setItems(r.items)).catch((e) => setError(e.message));
  }, [tab]);
  useEffect(() => { setItems(null); load(); }, [load]);

  const open = (stats?.byStatus?.PENDING ?? 0) + (stats?.byStatus?.MATCHED ?? 0);
  const Tab = ({ k, label }: { k: typeof tab; label: string }) => <button className="btn" style={tab === k ? { background: 'var(--border)', fontWeight: 600 } : undefined} onClick={() => setTab(k)}>{label}</button>;

  return (
    <div className="space-y-4 max-w-6xl">
      <div><h1 className="text-xl font-semibold">Сверка</h1>
        <p className="muted">Расхождения между исходной таблицей и платежами приложения. Ничего не применяется автоматически: каждое решение принимает человек и пишется в журнал.</p></div>
      {error && <p role="alert" className="b-err">{error}</p>}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="panel p-3"><div className="muted text-xs">Открытые расхождения</div><div className={`text-lg font-semibold ${open ? 'b-warn' : ''}`}>{open}</div></div>
        <div className="panel p-3"><div className="muted text-xs">Платежей ждут подтверждения</div><div className="text-lg font-semibold"><Link className={stats?.pendingPayments ? 'b-warn' : ''} href="/payments?status=PENDING">{stats?.pendingPayments ?? 0}</Link></div></div>
        <div className="panel p-3"><div className="muted text-xs">Возможные дубликаты платежей</div><div className={`text-lg font-semibold ${stats?.duplicateGroups ? 'b-err' : ''}`}>{stats?.duplicateGroups ?? 0}</div></div>
        <div className="panel p-3"><div className="muted text-xs">Решено (подтв. / откл.)</div><div className="text-lg font-semibold">{stats?.byStatus?.CONFIRMED ?? 0} / {stats?.byStatus?.REJECTED ?? 0}</div></div>
      </div>
      <nav className="flex gap-1 flex-wrap"><Tab k="open" label="Расхождения с источником" /><Tab k="closed" label="Решённые" /><Tab k="dups" label="Возможные дубликаты платежей" /></nav>

      {tab !== 'dups' && (items === null ? <p className="muted">Загрузка…</p> : items.length === 0 ? <p className="muted">{tab === 'open' ? 'Открытых расхождений нет.' : 'Решённых задач пока нет.'}</p> :
        <div className="space-y-3">{items.map((t) => <Task key={t.id} t={t} onDone={load} />)}</div>)}

      {tab === 'dups' && (dups === null ? <p className="muted">Загрузка…</p> : dups.length === 0 ? <p className="muted">Дубликатов не найдено.</p> :
        <div className="space-y-3">{dups.map((g, i) => (
          <section key={i} className="panel p-3 space-y-1"><div className="muted text-xs">Причина: {g.reason}. Если это ошибка — сторнируйте лишний платёж на его странице.</div>
            {g.payments.map((p: any) => <div key={p.id} className="text-sm"><Link className="underline" href={`/payments/${p.id}`}>{p.paymentDate}</Link> · {PAY_KIND[p.kind]} {money(p.amount, p.currency)} · {p.supplier.name} · {p.contract.number} · {p.status === 'PENDING' ? 'ожидает' : 'подтверждён'}{p.transactionNo ? ` · ${p.transactionNo}` : ''}</div>)}</section>))}</div>)}
    </div>
  );
}

function Task({ t, onDone }: { t: any; onDone: () => void }) {
  const { can } = useSession();
  const closed = t.status === 'CONFIRMED' || t.status === 'REJECTED';
  const [sel, setSel] = useState<string[]>(() => (t.resolution?.paymentIds?.length ? t.resolution.paymentIds : t.suggestedPaymentIds ?? []));
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const st = ST[t.status];
  const c = t.contract;
  const delta = t.delta !== null ? Number(t.delta) : null;
  const picked = t.candidates.filter((p: any) => sel.includes(p.id)).reduce((a: number, p: any) => a + Number(p.amount), 0);
  const diff = delta !== null && delta > 0 ? delta - picked : delta;

  const run = async (fn: () => Promise<any>) => { setBusy(true); setError(''); try { await fn(); onDone(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  const confirmTask = async () => {
    setBusy(true); setError('');
    try { await api('POST', `/reconciliation/${t.id}/confirm`, { paymentIds: sel, note: note || undefined }); onDone(); }
    catch (e) {
      if (e instanceof ApiError && e.code === 'RECON_DIFFERENCE') {
        if (confirm(`${e.message}\n\nПринять расхождение и применить данные источника?`)) { try { await api('POST', `/reconciliation/${t.id}/confirm`, { paymentIds: sel, note: note || undefined, acceptDifference: true }); onDone(); } catch (e2) { setError((e2 as Error).message); } }
      } else setError((e as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <section className="panel p-4 space-y-3" style={!closed ? { borderColor: 'var(--pending)' } : undefined}>
      <div className="flex justify-between gap-2 flex-wrap">
        <div>{c ? <><Link className="underline font-semibold" href={`/contracts/${c.id}`}>{c.number}</Link> <span className="muted">· <Link href={`/suppliers/${c.supplier.id}`}>{c.supplier.name}</Link></span></> : 'Договор не найден'}
          <div className="muted text-xs">Источник: строка {t.sourceRow ?? '—'} · {new Date(t.createdAt).toLocaleString('ru-RU')}</div></div>
        <span className={`badge ${st[1]} self-start`}>{st[0]}</span>
      </div>
      <table className="tbl"><thead><tr><th>Поле</th><th className="num">В приложении</th><th className="num">В источнике</th></tr></thead>
        <tbody>{t.changes.map((x: any, i: number) => <tr key={i}><td>{FIELD[x.field] ?? x.field}</td>
          <td className="num">{x.field === 'openingPaid' && c ? money(c.openingPaid) : x.from ?? '—'}</td><td className="num"><b>{x.field === 'currency' ? x.to : money(x.to)}</b></td></tr>)}</tbody></table>

      {!closed && delta !== null && (<>
        {delta > 0 ? <>
          <div className="text-sm">В источнике оплачено больше на <b>{money(delta)} {c?.currency}</b>. Отметьте платежи приложения, которые уже входят в это значение — они не будут вычтены из долга повторно:</div>
          {t.candidates.length === 0 ? <p className="muted text-sm">Подтверждённых платежей приложения по этому договору нет — прирост будет принят как историческая оплата.</p> :
            <div className="space-y-1">{t.candidates.map((p: any) => (
              <label key={p.id} className="flex gap-2 items-center text-sm"><input type="checkbox" disabled={!can('reconciliation.resolve')} checked={sel.includes(p.id)} onChange={(e) => setSel(e.target.checked ? [...sel, p.id] : sel.filter((x) => x !== p.id))} />
                <Link className="underline" href={`/payments/${p.id}`}>{p.paymentDate}</Link> {money(p.amount, c?.currency)} {[p.bankDocument, p.transactionNo].filter(Boolean).join(' / ')}</label>))}
              {t.suggestedPaymentIds && <p className="text-xs b-ok">Найдено точное совпадение по сумме — платежи отмечены автоматически.</p>}</div>}
          <div className="text-sm">Сопоставлено: <b>{money(picked)}</b> · неопознанный остаток: <b className={diff ? 'b-warn' : 'b-ok'}>{money(diff ?? 0)}</b>{picked > delta ? <b className="b-err"> — больше прироста: это двойной учёт</b> : null}</div></>
          : <div className="text-sm b-warn">Источник <b>уменьшил</b> «Оплачено» на {money(Math.abs(delta))} {c?.currency}. Применение уменьшит оплату договора и увеличит долг.</div>}
        {can('reconciliation.resolve') && <input className="input w-full" placeholder="Примечание (необязательно)" value={note} onChange={(e) => setNote(e.target.value)} />}
        {error && <p role="alert" className="b-err text-sm">{error}</p>}
        {can('reconciliation.resolve') ? (
          <div className="flex gap-2 flex-wrap">
            <button className="btn" disabled={busy || picked > delta} onClick={() => run(() => api('POST', `/reconciliation/${t.id}/match`, { paymentIds: sel, note: note || undefined }))}>Сопоставить (сохранить выбор)</button>
            <button className="btn btn-primary" disabled={busy || (delta > 0 && picked > delta)} onClick={confirmTask}>Подтвердить и применить</button>
            <button className="btn" disabled={busy} onClick={() => { const r = prompt('Причина отклонения (данные приложения останутся без изменений):'); if (r && r.trim().length >= 3) run(() => api('POST', `/reconciliation/${t.id}/reject`, { reason: r.trim() })); }}>Отклонить</button>
          </div>) : <p className="muted text-xs">Решения принимают пользователи с правом сверки (FINANCE, администраторы).</p>}
      </>)}
      {!closed && delta === null && (<div className="space-y-2">
        <p className="text-sm">Изменилась сумма или валюта договора в источнике.</p>
        {error && <p role="alert" className="b-err text-sm">{error}</p>}
        {can('reconciliation.resolve') && <div className="flex gap-2"><button className="btn btn-primary" disabled={busy} onClick={confirmTask}>Подтвердить и применить</button>
          <button className="btn" disabled={busy} onClick={() => { const r = prompt('Причина отклонения:'); if (r && r.trim().length >= 3) run(() => api('POST', `/reconciliation/${t.id}/reject`, { reason: r.trim() })); }}>Отклонить</button></div>}</div>)}
      {closed && <p className="text-sm muted">{t.status === 'CONFIRMED' ? `Применено ${t.resolvedBy?.name ?? ''}: сопоставлено ${money(t.resolution?.matchedAmount)}${t.resolution?.acceptedDifference ? `, принято расхождение ${money(t.resolution.difference)}` : ''}` : `Отклонено ${t.resolvedBy?.name ?? ''}: ${t.resolution?.reason ?? ''}`}{t.resolution?.note ? ` — ${t.resolution.note}` : ''}</p>}
    </section>
  );
}
