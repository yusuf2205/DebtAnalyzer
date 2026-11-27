'use client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, money } from '@/lib/api';
import { useSession } from '@/lib/session';

const ST: Record<string, [string, string]> = { PENDING_CONFIRMATION: ['Ожидает подтверждения', 'b-warn'], CONFIRMED: ['Подтверждён', 'b-ok'], REJECTED: ['Отклонён', 'b-mute'] };
const CURS = ['USD', 'EUR', 'RUB'];
const today = () => new Date().toISOString().slice(0, 10);

export default function FxPage() {
  const { can } = useSession();
  const [rates, setRates] = useState<any[] | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [f, setF] = useState({ currency: 'USD', uzsPerUnit: '', effectiveDate: today(), source: '' });
  const formRef = useRef<HTMLFormElement>(null);
  const load = () => api<any[]>('GET', '/fx/rates').then(setRates).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);
  const act = async (fn: () => Promise<any>, ok?: string) => { setError(''); setNotice(''); try { await fn(); await load(); if (ok) setNotice(ok); } catch (e) { setError((e as Error).message); } };
  const askDate = (r: any) => (r.effectiveDate ? undefined : (prompt('У курса нет даты. Укажите дату действия (ГГГГ-ММ-ДД):') ?? null));
  const manage = can('fx.manage');
  const pendingAll = (rates ?? []).filter((r) => r.status === 'PENDING_CONFIRMATION');
  const pendingDated = pendingAll.filter((r) => r.effectiveDate);
  async function fetchCbu() {
    setError(''); setNotice('');
    try {
      const r = await api<{ created: { currency: string; uzsPerUnit: string; effectiveDate: string }[]; skipped: { currency: string; reason: string }[] }>('POST', '/fx/fetch-cbu');
      setNotice(r.created.length ? `Получено курсов ЦБ: ${r.created.map((x) => `${x.currency} ${money(x.uzsPerUnit)} на ${x.effectiveDate}`).join('; ')}. Они ждут вашего подтверждения.` : `Новых курсов нет (${r.skipped.map((x) => `${x.currency}: ${x.reason}`).join('; ')}).`);
      await load();
    } catch (e) { setError((e as Error).message); }
  }
  async function confirmAll() {
    const list = pendingDated.map((r) => `${r.currency} ${money(r.uzsPerUnit)} UZS на ${r.effectiveDate.slice(0, 10)}`).join(String.fromCharCode(10));
    if (!confirm(`Подтвердить ${pendingDated.length} курсов? После этого они начнут применяться в расчётах (итоги в UZS).${String.fromCharCode(10, 10)}${list}`)) return;
    setError(''); setNotice('');
    let ok = 0;
    try { for (const r of pendingDated) { await api('POST', `/fx/rates/${r.id}/confirm`, {}); ok++; } setNotice(`Подтверждено курсов: ${ok}.`); }
    catch (e) { setError(`Подтверждено ${ok} из ${pendingDated.length}; остановилось на ошибке: ${(e as Error).message}`); }
    await load();
  }

  // Действующий курс валюты — подтверждённый с самой поздней датой не позже сегодня (так же выбирает расчёт).
  const current = CURS.map((c) => (rates ?? []).filter((r) => r.currency === c && r.status === 'CONFIRMED' && r.effectiveDate && r.effectiveDate.slice(0, 10) <= today()).sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate) || b.createdAt.localeCompare(a.createdAt))[0] ?? null);

  const edit = (r: any) => {
    setF({ currency: r.currency, uzsPerUnit: String(r.uzsPerUnit).includes('.') ? String(r.uzsPerUnit).replace(/\.?0+$/, '') : String(r.uzsPerUnit), effectiveDate: today(), source: '' });
    setNotice('Форма заполнена данными выбранного курса. Укажите новое значение и дату — старая запись останется в истории.');
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  return (
    <div className="space-y-5 max-w-5xl">
      <div><h1 className="text-xl font-semibold">Курсы валют</h1>
        <p className="muted">Курс — сколько UZS за 1 единицу валюты. Курсы из файлов не применяются, пока их не подтвердит пользователь с правом «Ввод и подтверждение курсов».</p></div>
      {error && <p role="alert" className="b-err">{error}</p>}
      {notice && <p role="status" className="b-ok">{notice}</p>}

      <div className="grid sm:grid-cols-3 gap-4">
        {CURS.map((c, i) => { const r = current[i]; return (
          <div key={c} className={`stat ${['t-green', 't-lav', 't-peach'][i]}`}>
            <div className="text-sm muted">Действующий курс {c}</div>
            {r ? <><div className="big">{money(r.uzsPerUnit)} <span className="text-sm font-normal muted">UZS</span></div><div className="text-xs muted">за 1 {c}, с {r.effectiveDate.slice(0, 10)}</div></>
              : <><div className="big muted">—</div><div className="text-xs b-warn">Нет подтверждённого курса</div></>}
          </div>); })}
      </div>

      {manage && <div className="flex items-center gap-3 flex-wrap"><button className="btn" onClick={fetchCbu}>Подтянуть курсы ЦБ</button><span className="muted text-sm">Официальные курсы ЦБ Узбекистана (USD, EUR, RUB) придут как «ожидает подтверждения»; применяет их только человек. Раз в сутки это происходит автоматически.</span></div>}
      {manage && pendingAll.length > 0 && (
        <div className="panel p-4 flex items-center justify-between gap-3 flex-wrap" style={{ borderColor: 'var(--pending)' }}>
          <div><b className="b-warn">Ожидают подтверждения: {pendingAll.length}</b>
            <p className="muted text-sm">Пока курсы не подтверждены, итоги в UZS по другим валютам считаются неполными. Проверьте значения в таблице ниже и подтвердите.{pendingAll.length !== pendingDated.length && ' У части курсов нет даты — их подтверждают по одному (с указанием даты).'}</p></div>
          {pendingDated.length > 0 && <button className="btn btn-primary" onClick={confirmAll}>Подтвердить все ({pendingDated.length})</button>}
        </div>)}

      <div className="panel p-4 text-sm space-y-1">
        <b>Как изменить курс</b>
        <ul className="list-disc pl-5 muted">
          <li><b>Ожидающий подтверждения</b> (пришёл из файла) — нажмите «Подтвердить» или «Отклонить».</li>
          <li><b>Изменить действующий</b> — нажмите «Изменить» в строке (или заполните форму ниже), укажите новое значение и дату. Новый курс начнёт действовать с этой даты, а старый останется в истории: записи не редактируются и не удаляются, чтобы прошлые расчёты и аудит оставались точными.</li>
        </ul>
      </div>

      <div className="panel overflow-x-auto"><table className="tbl"><thead><tr><th>Валюта</th><th className="num">UZS за 1 ед.</th><th>Дата действия</th><th>Источник</th><th>Статус</th><th></th></tr></thead>
        <tbody>{rates?.map((r) => { const st = ST[r.status]; return (
          <tr key={r.id}><td><b>{r.currency}</b></td><td className="num">{money(r.uzsPerUnit)}</td><td>{r.effectiveDate?.slice(0, 10) ?? '—'}</td><td className="max-w-72 truncate" title={r.source}>{r.source.startsWith('IMPORT:') ? 'Из загруженной таблицы' : r.source}</td>
            <td><span className={`badge ${st[1]}`}>{st[0]}</span></td>
            <td className="whitespace-nowrap">{manage && (<>
              {r.status === 'PENDING_CONFIRMATION' && (<>
                <button className="btn" onClick={() => { const d = askDate(r); if (d !== null) act(() => api('POST', `/fx/rates/${r.id}/confirm`, d ? { effectiveDate: d } : {}), 'Курс подтверждён и применяется в расчётах.'); }}>Подтвердить</button>{' '}
                <button className="btn" onClick={() => act(() => api('POST', `/fx/rates/${r.id}/reject`), 'Курс отклонён.')}>Отклонить</button>{' '}</>)}
              {r.status !== 'REJECTED' && <button className="btn" onClick={() => edit(r)}>Изменить</button>}</>)}</td></tr>); })}
          {rates?.length === 0 && <tr><td colSpan={6} className="muted">Курсов пока нет</td></tr>}</tbody></table></div>
      {manage && (
        <form ref={formRef} className="panel p-4 space-y-3" onSubmit={(e: FormEvent) => { e.preventDefault(); act(() => api('POST', '/fx/rates', f), 'Курс добавлен и подтверждён.'); }}>
          <h2 className="font-semibold">Новый курс</h2>
          <div className="flex gap-3 flex-wrap items-end">
            <label className="space-y-1 block"><span className="muted text-xs">Валюта</span><select className="input block" value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })}>{CURS.map((c) => <option key={c}>{c}</option>)}</select></label>
            <label className="space-y-1 block"><span className="muted text-xs">UZS за 1 ед.</span><input className="input block" required inputMode="decimal" pattern="\d+(\.\d{1,8})?" value={f.uzsPerUnit} onChange={(e) => setF({ ...f, uzsPerUnit: e.target.value })} /></label>
            <label className="space-y-1 block"><span className="muted text-xs">Дата действия</span><input className="input block" type="date" required value={f.effectiveDate} onChange={(e) => setF({ ...f, effectiveDate: e.target.value })} /></label>
            <label className="space-y-1 block"><span className="muted text-xs">Источник (например, ЦБ РУз)</span><input className="input block" required minLength={2} value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })} /></label>
            <button className="btn btn-primary">Добавить курс</button>
          </div>
          <p className="muted text-xs">Добавленный вручную курс сразу считается подтверждённым.</p>
        </form>)}
    </div>
  );
}
