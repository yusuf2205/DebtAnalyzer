'use client';
import { useEffect, useState, type FormEvent } from 'react';
import { api, money } from '@/lib/api';
import { useSession } from '@/lib/session';

const ST: Record<string, [string, string]> = { PENDING_CONFIRMATION: ['Ожидает подтверждения', 'b-warn'], CONFIRMED: ['Подтверждён', 'b-ok'], REJECTED: ['Отклонён', 'b-mute'] };

export default function FxPage() {
  const { can } = useSession();
  const [rates, setRates] = useState<any[] | null>(null);
  const [error, setError] = useState('');
  const [f, setF] = useState({ currency: 'USD', uzsPerUnit: '', effectiveDate: new Date().toISOString().slice(0, 10), source: '' });
  const load = () => api<any[]>('GET', '/fx/rates').then(setRates).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);
  const act = async (fn: () => Promise<any>) => { setError(''); try { await fn(); await load(); } catch (e) { setError((e as Error).message); } };
  const askDate = (r: any) => (r.effectiveDate ? undefined : (prompt('У курса нет даты. Укажите дату действия (ГГГГ-ММ-ДД):') ?? null));

  return (
    <div className="space-y-4 max-w-5xl">
      <div><h1 className="text-xl font-semibold">Курсы валют</h1><p className="muted">Курс — сколько UZS за 1 единицу валюты. Курсы из файлов не применяются, пока их не подтвердит пользователь. Записи не редактируются — только добавляются.</p></div>
      {error && <p role="alert" className="b-err">{error}</p>}
      <div className="panel overflow-x-auto"><table className="tbl"><thead><tr><th>Валюта</th><th className="num">UZS за 1 ед.</th><th>Дата действия</th><th>Источник</th><th>Статус</th><th></th></tr></thead>
        <tbody>{rates?.map((r) => { const st = ST[r.status]; return (
          <tr key={r.id}><td><b>{r.currency}</b></td><td className="num">{money(r.uzsPerUnit)}</td><td>{r.effectiveDate?.slice(0, 10) ?? '—'}</td><td className="max-w-72 truncate" title={r.source}>{r.source}</td>
            <td><span className={`badge ${st[1]}`}>{st[0]}</span></td>
            <td className="whitespace-nowrap">{can('fx.manage') && r.status === 'PENDING_CONFIRMATION' && (<>
              <button className="btn" onClick={() => { const d = askDate(r); if (d !== null) act(() => api('POST', `/fx/rates/${r.id}/confirm`, d ? { effectiveDate: d } : {})); }}>Подтвердить</button>{' '}
              <button className="btn" onClick={() => act(() => api('POST', `/fx/rates/${r.id}/reject`))}>Отклонить</button></>)}</td></tr>); })}
          {rates?.length === 0 && <tr><td colSpan={6} className="muted">Курсов пока нет</td></tr>}</tbody></table></div>
      {can('fx.manage') && (
        <form className="panel p-4 flex gap-3 flex-wrap items-end" onSubmit={(e: FormEvent) => { e.preventDefault(); act(() => api('POST', '/fx/rates', f)); }}>
          <label className="space-y-1 block"><span className="muted text-xs">Валюта</span><select className="input block" value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })}>{['USD', 'EUR', 'RUB'].map((c) => <option key={c}>{c}</option>)}</select></label>
          <label className="space-y-1 block"><span className="muted text-xs">UZS за 1 ед.</span><input className="input block" required inputMode="decimal" pattern="\d+(\.\d{1,8})?" value={f.uzsPerUnit} onChange={(e) => setF({ ...f, uzsPerUnit: e.target.value })} /></label>
          <label className="space-y-1 block"><span className="muted text-xs">Дата действия</span><input className="input block" type="date" required value={f.effectiveDate} onChange={(e) => setF({ ...f, effectiveDate: e.target.value })} /></label>
          <label className="space-y-1 block"><span className="muted text-xs">Источник (например, ЦБ РУз)</span><input className="input block" required minLength={2} value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })} /></label>
          <button className="btn btn-primary">Добавить курс</button>
        </form>)}
    </div>
  );
}
