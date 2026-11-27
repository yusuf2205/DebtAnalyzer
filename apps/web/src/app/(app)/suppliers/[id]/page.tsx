'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { api, money } from '@/lib/api';
import { HistoryList } from '@/lib/history';
import { useSession } from '@/lib/session';
import { PAY_KIND, PayBadge, StateBadge, TotalsStrip } from '@/lib/ui';

export default function SupplierPage() {
  const { id } = useParams<{ id: string }>();
  const { can } = useSession();
  const [s, setS] = useState<any>(null);
  const [payments, setPayments] = useState<any>(null);
  const [error, setError] = useState('');
  const [alias, setAlias] = useState('');
  const [edit, setEdit] = useState<{ name: string; taxId: string } | null>(null);
  const load = useCallback(() => api('GET', `/suppliers/${id}`).then(setS).catch((e) => setError(e.message)), [id]);
  useEffect(() => { load(); api('GET', `/payments?supplierId=${id}&pageSize=100`).then(setPayments).catch(() => {}); }, [load, id]);
  const act = async (fn: () => Promise<any>) => { setError(''); try { await fn(); await load(); } catch (e) { setError((e as Error).message); } };

  if (!s) return <p className="muted">{error || 'Загрузка…'}</p>;
  const manage = can('suppliers.manage') && s.status === 'ACTIVE';
  return (
    <div className="space-y-4 max-w-6xl">
      <div className="flex justify-between gap-3 flex-wrap items-start">
        <div>
          <Link href="/suppliers" className="muted text-sm">← Контрагенты</Link>
          <h1 className="text-xl font-semibold">{s.name} {s.status === 'ARCHIVED' && <span className="badge b-mute">объединён</span>}</h1>
          <p className="muted">{s.taxId ? `ИНН ${s.taxId}` : 'ИНН не указан'}{s.mergedInto && <> · объединён в <Link className="underline" href={`/suppliers/${s.mergedInto.id}`}>{s.mergedInto.name}</Link></>}</p>
        </div>
        <div className="flex gap-2 flex-wrap">
        {can('reports.view') && <Link className="btn" href={`/reports?report=supplier-statement&supplierId=${id}&supplierName=${encodeURIComponent(s.name)}`}>Акт сверки</Link>}
        {manage && !edit && <button className="btn" onClick={() => setEdit({ name: s.name, taxId: s.taxId ?? '' })}>Изменить</button>}
        </div>
      </div>
      {error && <p role="alert" className="b-err">{error}</p>}
      {edit && (
        <form className="panel p-3 flex gap-2 flex-wrap items-end" onSubmit={(e) => { e.preventDefault(); act(async () => { await api('PATCH', `/suppliers/${id}`, { name: edit.name, taxId: edit.taxId || null }); setEdit(null); }); }}>
          <label className="block space-y-1"><span className="muted text-xs">Название</span><input className="input w-96 block" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></label>
          <label className="block space-y-1"><span className="muted text-xs">ИНН (9–14 цифр)</span><input className="input block" value={edit.taxId} pattern="\d{9,14}|" onChange={(e) => setEdit({ ...edit, taxId: e.target.value })} /></label>
          <button className="btn btn-primary">Сохранить</button><button type="button" className="btn" onClick={() => setEdit(null)}>Отмена</button>
        </form>)}

      <TotalsStrip totals={s.totals} />
      <p className="muted text-xs">Итоги — по активным договорам. Оплаты приложения (подтверждённые платежи) появятся в этапе M4; сейчас «Оплачено» — начальный остаток из импорта.</p>

      <section className="panel p-4 space-y-2">
        <h2 className="font-semibold">Написания названия ({s.aliases.length})</h2>
        <p className="muted text-xs">При импорте строка с любым из этих написаний попадёт к этому контрагенту.</p>
        <ul className="space-y-1">{s.aliases.map((a: any) => (
          <li key={a.id} className="flex gap-2 items-center"><span>{a.alias}</span><span className="muted text-xs">{({ IMPORT: 'из таблицы', MANUAL: 'вручную', MERGE: 'при объединении' } as Record<string, string>)[a.source.split(':')[0]] ?? a.source.split(':')[0]}</span>
            {manage && s.aliases.length > 1 && <button className="btn" onClick={() => act(() => api('DELETE', `/suppliers/${id}/aliases/${a.id}`))}>Удалить</button>}</li>))}</ul>
        {manage && <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); act(async () => { await api('POST', `/suppliers/${id}/aliases`, { alias }); setAlias(''); }); }}>
          <input className="input w-96" placeholder="Добавить написание вручную" value={alias} onChange={(e) => setAlias(e.target.value)} /><button className="btn" disabled={alias.trim().length < 2}>Добавить</button></form>}
      </section>

      <section className="space-y-2">
        <div className="flex justify-between items-center"><h2 className="font-semibold">Договоры ({s.contracts.length})</h2>
          {can('contracts.manage') && s.status === 'ACTIVE' && <Link className="btn" href={`/contracts/new?supplierId=${id}`}>Новый договор</Link>}</div>
        <div className="panel overflow-auto" style={{ maxHeight: '50vh' }}>
          <table className="tbl"><thead><tr><th>Договор</th><th>Проект</th><th>Товар</th><th>Вал.</th><th className="num">Сумма</th><th className="num">Оплачено</th><th className="num">Долг</th><th>Состояние</th><th className="num">План</th></tr></thead>
            <tbody>{s.contracts.map((c: any) => (
              <tr key={c.id} style={c.status === 'ARCHIVED' ? { opacity: .55 } : undefined}>
                <td className="max-w-72"><Link className="underline" href={`/contracts/${c.id}`}>{c.number ?? '—'}</Link>{c.status === 'ARCHIVED' && <span className="badge b-mute ml-2">архив</span>}</td>
                <td className="max-w-40 truncate">{c.project}</td><td className="max-w-40 truncate">{c.goods}</td><td>{c.currency}</td>
                <td className="num">{money(c.amount)}</td><td className="num b-ok">{money(c.openingPaid)}</td><td className="num b-err">{Number(c.debt) ? money(c.debt) : '—'}</td>
                <td><StateBadge state={c.state} /></td><td className="num b-info">{Number(c.planned) ? money(c.planned) : '—'}</td></tr>))}</tbody></table>
        </div>
      </section>

      <section className="space-y-2">
        <div className="flex justify-between items-center"><h2 className="font-semibold">История оплат</h2><Link className="underline text-sm" href={`/payments?supplierId=${id}`}>все платежи →</Link></div>
        <p className="muted text-xs">Историческая оплата из файла хранится в договорах (колонка «Оплачено»); ниже — платежи, зарегистрированные в приложении.</p>
        <div className="panel overflow-auto" style={{ maxHeight: '40vh' }}><table className="tbl"><thead><tr><th>Дата</th><th>Договор</th><th>Тип</th><th className="num">Сумма</th><th>Статус</th></tr></thead>
          <tbody>{payments?.items.map((p: any) => <tr key={p.id}><td><Link className="underline" href={`/payments/${p.id}`}>{new Date(p.paymentDate).toLocaleDateString('ru-RU')}</Link></td><td className="max-w-64 truncate">{p.contract.number}</td><td>{PAY_KIND[p.kind]}</td>
            <td className={`num ${p.kind === 'PAYMENT' ? 'b-ok' : 'b-err'}`}>{money(p.amount, p.currency)}</td><td><PayBadge status={p.status} /></td></tr>)}
            {payments?.items.length === 0 && <tr><td colSpan={5} className="muted">Платежей в приложении пока нет</td></tr>}</tbody></table></div>
      </section>

      <section className="panel p-4 space-y-2">
        <h2 className="font-semibold">Журнал изменений</h2>
        <HistoryList items={s.history} />
      </section>
    </div>
  );
}
