'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, money } from '@/lib/api';
import { useSession } from '@/lib/session';
import { CURRENCIES, PAY_KIND, PayBadge, Stat, StateBadge } from '@/lib/ui';

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

export default function ContractPage() {
  const { id } = useParams<{ id: string }>();
  const { can } = useSession();
  const [c, setC] = useState<any>(null);
  const [error, setError] = useState('');
  const [edit, setEdit] = useState<any>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const load = useCallback(() => api('GET', `/contracts/${id}`).then(setC).catch((e) => setError(e.message)), [id]);
  useEffect(() => { load(); }, [load]);
  const act = async (fn: () => Promise<any>) => { setError(''); try { await fn(); await load(); } catch (e) { setError((e as Error).message); } };

  if (!c) return <p className="muted">{error || 'Загрузка…'}</p>;
  const archived = c.status === 'ARCHIVED';
  const manage = can('contracts.manage') && !archived;
  const startEdit = () => setEdit({ number: c.number ?? '', contractDate: c.contractDate ?? '', project: c.project ?? '', goods: c.goods ?? '', executor: c.executor ?? '', notes: c.notes ?? '', amount: c.amount, currency: c.currency, reason: '' });
  const financialChanged = edit && (edit.amount !== c.amount || edit.currency !== c.currency);

  async function save() {
    const body: any = { number: edit.number, contractDate: edit.contractDate || null, project: edit.project || null, goods: edit.goods || null, executor: edit.executor || null, notes: edit.notes || null };
    if (financialChanged) { body.amount = edit.amount; body.currency = edit.currency; body.reason = edit.reason; }
    await act(async () => { await api('PATCH', `/contracts/${id}`, body); setEdit(null); });
  }
  const field = (k: string, label: string, extra: object = {}) => (
    <label className="block space-y-1"><span className="muted text-xs">{label}</span><input className="input w-full" value={edit[k]} onChange={(e) => setEdit({ ...edit, [k]: e.target.value })} {...extra} /></label>);

  return (
    <div className="space-y-4 max-w-6xl">
      <div className="flex justify-between gap-3 flex-wrap items-start">
        <div>
          <Link href="/contracts" className="muted text-sm">← Договоры</Link>
          <h1 className="text-xl font-semibold">{c.number ?? 'Без номера'} {archived && <span className="badge b-mute">архив</span>}</h1>
          <p className="muted"><Link className="underline" href={`/suppliers/${c.supplier.id}`}>{c.supplier.name}</Link>{c.project && <> · {c.project}</>}{c.contractDate && <> · от {new Date(c.contractDate).toLocaleDateString('ru-RU')}</>}</p>
        </div>
        <div className="flex gap-2">
          {manage && !edit && <button className="btn" onClick={startEdit}>Редактировать</button>}
          {can('contracts.archive') && (archived
            ? <button className="btn" onClick={() => act(() => api('POST', `/contracts/${id}/restore`))}>Восстановить</button>
            : <button className="btn" onClick={() => confirm('Архивировать договор? Он исчезнет из списков и итогов, но сохранится в системе.') && act(() => api('POST', `/contracts/${id}/archive`))}>В архив</button>)}
        </div>
      </div>
      {error && <p role="alert" className="b-err">{error}</p>}

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Stat label={`Сумма договора, ${c.currency}`} value={money(c.amount)} />
        <Stat label="Оплачено (остаток + платежи)" value={money(c.paid)} tone="b-ok" />
        <Stat label="Остаток задолженности" value={Number(c.debt) ? money(c.debt) : '—'} tone="b-err" />
        <Stat label="Переплата" value={Number(c.overpaid) ? money(c.overpaid) : '—'} tone="b-info" />
        <Stat label="Плановые платежи" value={Number(c.planned) ? money(c.planned) : '—'} tone="b-info" />
      </div>
      <div className="flex gap-3 items-center flex-wrap"><StateBadge state={c.state} />
        <span className="muted text-sm">Долг = {money(c.debtDetails.contractAmount)} − {money(c.debtDetails.openingPaid)} (начальная оплата) − {money(c.debtDetails.newApprovedPaid)} (подтверждённые платежи приложения). План на долг не влияет.</span></div>

      {edit && (
        <section className="panel p-4 space-y-3">
          <h2 className="font-semibold">Редактирование</h2>
          <div className="grid sm:grid-cols-2 gap-3">
            {field('number', 'Номер договора')}{field('contractDate', 'Дата договора', { type: 'date' })}{field('project', 'Проект')}{field('goods', 'Товар')}{field('executor', 'Исполнитель')}
            {field('amount', 'Сумма', { inputMode: 'decimal' })}
            <label className="block space-y-1"><span className="muted text-xs">Валюта</span><select className="input w-full" value={edit.currency} onChange={(e) => setEdit({ ...edit, currency: e.target.value })}>{CURRENCIES.map((x) => <option key={x}>{x}</option>)}</select></label>
            <label className="block space-y-1 sm:col-span-2"><span className="muted text-xs">Примечание</span><textarea className="input w-full" rows={3} value={edit.notes} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} /></label>
          </div>
          {financialChanged && <div className="panel p-3" style={{ borderColor: 'var(--pending)' }}>
            <b className="b-warn">Изменение суммы или валюты</b>
            <p className="text-sm">Оно будет записано в журнал аудита{c.sourceBatchId ? ', а значение договора разойдётся с исходной таблицей' : ''}. Укажите причину (например, номер доп. соглашения).</p>
            <input className="input w-full mt-2" placeholder="Причина *" value={edit.reason} onChange={(e) => setEdit({ ...edit, reason: e.target.value })} /></div>}
          <p className="muted text-xs">«Оплачено» здесь не редактируется: оно меняется только подтверждёнными платежами и сверкой.</p>
          <div className="flex gap-2"><button className="btn btn-primary" disabled={financialChanged && edit.reason.trim().length < 3} onClick={save}>Сохранить</button><button className="btn" onClick={() => setEdit(null)}>Отмена</button></div>
        </section>)}

      <section className="panel p-4 space-y-1">
        <h2 className="font-semibold">Сведения</h2>
        <dl className="grid sm:grid-cols-2 gap-x-6 gap-y-1 text-sm">
          <div><dt className="muted inline">Товар: </dt><dd className="inline">{c.goods ?? '—'}</dd></div><div><dt className="muted inline">Исполнитель: </dt><dd className="inline">{c.executor ?? '—'}</dd></div>
          <div className="sm:col-span-2"><dt className="muted inline">Примечание: </dt><dd className="inline whitespace-pre-line">{c.notes ?? '—'}</dd></div>
          <div className="sm:col-span-2 muted text-xs">{c.sourceBatchId ? `Источник: импорт, строка ${c.sourceRow}; «Оплачено» в источнике: ${money(c.sourcePaid)}` : 'Создан вручную'}</div>
        </dl>
      </section>

      <section className="panel p-4 space-y-2">
        <h2 className="font-semibold">График платежей (план)</h2>
        {c.plans.length ? <table className="tbl"><thead><tr><th>Период</th><th>Неделя</th><th className="num">Сумма</th><th>Источник</th></tr></thead>
          <tbody>{c.plans.map((p: any) => <tr key={p.id}><td>{MONTHS[p.month - 1]} {p.year}</td><td>W{p.week}</td><td className="num b-info">{money(p.amount, p.currency)}</td><td>{p.source === 'IMPORT' ? 'импорт' : 'вручную'}</td></tr>)}</tbody></table>
          : <p className="muted text-sm">План не задан. Редактирование плана и календарь — этап M5.</p>}
      </section>

      <section className="panel p-4 space-y-2">
        <div className="flex justify-between items-center gap-2 flex-wrap"><h2 className="font-semibold">Платежи ({c.payments.length})</h2>
          {can('payments.create') && !archived && <Link className="btn" href={`/payments/new?contractId=${id}`}>Добавить платёж</Link>}</div>
        <p className="muted text-xs">В долг входят только подтверждённые платежи. «В остатке» — платёж уже учтён в историческом «Оплачено» (сверка), повторно не вычитается.</p>
        {c.payments.length > 0 && <table className="tbl"><thead><tr><th>Дата</th><th>Тип</th><th className="num">Сумма</th><th>Статус</th><th>Документ / транзакция</th></tr></thead>
          <tbody>{c.payments.map((p: any) => <tr key={p.id}><td><Link className="underline" href={`/payments/${p.id}`}>{new Date(p.paymentDate).toLocaleDateString('ru-RU')}</Link></td><td>{PAY_KIND[p.kind]}</td>
            <td className={`num ${p.kind === 'PAYMENT' ? 'b-ok' : 'b-err'}`}>{money(p.amount, p.currency)}</td><td><PayBadge status={p.status} />{p.reflectedInOpening && <span className="badge b-info ml-1">в остатке</span>}</td>
            <td className="text-xs">{[p.bankDocument, p.transactionNo].filter(Boolean).join(' / ')}</td></tr>)}</tbody></table>}
        {c.reconciliation.length > 0 && <div className="panel p-3" style={{ borderColor: 'var(--pending)' }}><b className="b-warn">Сверка с источником: {c.reconciliation.length}</b> <Link className="underline text-sm" href="/reconciliation">открыть сверку</Link>
          <ul className="text-sm list-disc pl-5">{c.reconciliation.map((t: any) => <li key={t.id}>{t.status === 'PENDING' || t.status === 'MATCHED' ? 'Открыта' : t.status === 'CONFIRMED' ? 'Применена' : 'Отклонена'}: {(t.details.changes ?? []).map((x: any) => `${x.field}: ${x.from} → ${x.to}`).join('; ')}</li>)}</ul></div>}
      </section>

      <section className="panel p-4 space-y-2">
        <div className="flex justify-between items-center"><h2 className="font-semibold">Документы ({c.documents.length})</h2>
          {manage && <><input ref={fileRef} type="file" hidden accept=".pdf,.png,.jpg,.jpeg,.docx,.xlsx" onChange={(e) => { const file = e.target.files?.[0]; if (!file) return; const fd = new FormData(); fd.append('file', file); act(() => api('POST', `/contracts/${id}/documents`, fd)); e.target.value = ''; }} />
            <button className="btn" onClick={() => fileRef.current?.click()}>Прикрепить файл</button></>}</div>
        <ul className="text-sm space-y-1">{c.documents.map((d: any) => (
          <li key={d.id} className="flex gap-2 items-center"><a className="underline" href={`/api/contracts/${id}/documents/${d.id}`} download>{d.filename}</a><span className="muted text-xs">{(d.size / 1024).toFixed(0)} КБ · {new Date(d.createdAt).toLocaleDateString('ru-RU')}</span>
            {manage && <button className="btn" onClick={() => confirm('Удалить документ из договора? Запись сохранится в журнале.') && act(() => api('DELETE', `/contracts/${id}/documents/${d.id}`))}>Удалить</button>}</li>))}
          {!c.documents.length && <li className="muted">Документов нет. Допустимо: PDF, PNG, JPG, DOCX, XLSX до 20 МБ.</li>}</ul>
      </section>

      <section className="panel p-4 space-y-2">
        <h2 className="font-semibold">Журнал изменений</h2>
        <ul className="text-sm space-y-1">{c.history.map((h: any) => <li key={h.id}><span className="muted">{new Date(h.at).toLocaleString('ru-RU')}</span> · {h.userEmail ?? 'система'} · <b>{h.action}</b>{h.meta?.reason && <> — {h.meta.reason}</>}</li>)}{!c.history.length && <li className="muted">Записей нет</li>}</ul>
      </section>
    </div>
  );
}
