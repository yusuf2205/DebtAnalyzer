'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';

export default function Page() { return <Suspense fallback={<p className="muted">Загрузка…</p>}><GooglePage /></Suspense>; }

const STATUS: Record<string, [string, string]> = { CHANGES: ['Есть изменения', 'b-warn'], UNCHANGED: ['Без изменений', 'b-ok'], ERROR: ['Ошибка', 'b-err'] };
const dt = (v?: string | null) => (v ? new Date(v).toLocaleString('ru-RU') : '—');

function GooglePage() {
  const { can } = useSession();
  const sp = useSearchParams();
  const manage = can('integrations.manage');
  const [status, setStatus] = useState<any>(null);
  const [sources, setSources] = useState<any[] | null>(null);
  const [error, setError] = useState(sp.get('error') ?? '');
  const [notice, setNotice] = useState(sp.get('connected') ? 'Google-аккаунт подключён' : '');
  const [needAuth, setNeedAuth] = useState(false);
  const [busy, setBusy] = useState('');

  const [url, setUrl] = useState('');
  const [insp, setInsp] = useState<any>(null);
  const [sheet, setSheet] = useState('');
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [auto, setAuto] = useState(true);
  const [interval, setIntervalMin] = useState('60');

  const load = useCallback(() => {
    api('GET', '/google/status').then(setStatus).catch(() => {});
    api<any[]>('GET', '/google/sources').then(setSources).catch((e) => setError(e.message));
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key); setError(''); setNotice('');
    try { await fn(); } catch (e) { setError((e as Error).message); if (e instanceof ApiError && e.code === 'GOOGLE_ACCESS_REQUIRED') setNeedAuth(true); } finally { setBusy(''); }
  };

  const inspect = () => run('inspect', async () => {
    setNeedAuth(false); setInsp(null);
    const r = await api('POST', '/google/sources/inspect', { url });
    setInsp(r); setSheet(r.suggestedSheet ?? '');
  });

  const create = () => run('create', async () => {
    const r = await api('POST', '/google/sources', { url, sheetName: sheet, planYear: Number(year), autoSync: auto, intervalMinutes: Number(interval), syncNow: true });
    setUrl(''); setInsp(null); load();
    if (r.syncError) setError(`Источник сохранён, но первая загрузка не удалась: ${r.syncError}`);
    else if (r.sync?.batchId) location.href = `/imports/${r.sync.batchId}`;
    else setNotice('Источник подключён');
  });

  const connect = () => run('oauth', async () => { const r = await api('GET', '/google/oauth/start'); location.href = r.url; });
  const syncNow = (id: string) => run(`sync-${id}`, async () => {
    const r = await api('POST', `/google/sources/${id}/sync`);
    load();
    if (r.status === 'CHANGES' && r.batchId) location.href = `/imports/${r.batchId}`; else setNotice('Таблица не изменилась с прошлой синхронизации');
  });

  return (
    <div className="space-y-4 max-w-5xl">
      <div><h1 className="text-xl font-semibold">Google Sheets</h1>
        <p className="muted">Вставьте ссылку на таблицу — система будет читать из неё данные. Таблица никогда не изменяется. Новые данные сначала показываются как предпросмотр изменений и применяются только после вашего подтверждения.</p></div>
      {error && <p role="alert" className="b-err">{error}</p>}
      {notice && <p className="b-ok">{notice}</p>}

      {manage && (
        <section className="panel p-4 space-y-3">
          <h2 className="font-semibold">Подключить таблицу</h2>
          <div className="flex gap-2 flex-wrap">
            <input className="input flex-1 min-w-72" placeholder="https://docs.google.com/spreadsheets/d/…" value={url} onChange={(e) => { setUrl(e.target.value); setInsp(null); }} />
            <button className="btn btn-primary" disabled={busy === 'inspect' || url.trim().length < 10} onClick={inspect}>{busy === 'inspect' ? 'Проверка…' : 'Проверить доступ'}</button>
          </div>
          <p className="muted text-xs">Доступ: если у таблицы включено «Все, у кого есть ссылка → Читатель», ключи не нужны. Закрытую таблицу можно читать через подключённый Google-аккаунт (только чтение).</p>

          {needAuth && (
            <div className="panel p-3" style={{ borderColor: 'var(--pending)' }}>
              {status?.oauthConfigured
                ? <><b className="b-warn">Таблица закрыта</b><p className="text-sm">Подключите Google-аккаунт, у которого есть доступ к этой таблице, и повторите проверку.</p><button className="btn mt-2" onClick={connect}>Подключить Google-аккаунт</button></>
                : <><b className="b-warn">Таблица закрыта, а вход через Google на сервере не настроен</b><p className="text-sm">Либо откройте таблицу по ссылке («Все, у кого есть ссылка → Читатель»), либо администратор должен задать GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI / TOKEN_ENCRYPTION_KEY (см. docs/RUNBOOK.md).</p></>}
            </div>)}

          {insp && (
            <div className="space-y-3">
              <p className="text-sm">Доступ есть ({insp.mode === 'PUBLIC' ? 'по публичной ссылке' : 'через подключённый аккаунт'}){insp.title ? `: «${insp.title}»` : ''}. Выберите лист с реестром:</p>
              {insp.sheets.map((s: any) => (
                <label key={s.name} className="flex items-center gap-2" style={{ opacity: s.empty ? .55 : 1 }}>
                  <input type="radio" name="gs" checked={sheet === s.name} disabled={s.empty || !s.layoutDetected} onChange={() => setSheet(s.name)} />
                  <span>{s.name}</span><span className="muted text-xs">{s.empty ? 'пустой' : s.layoutDetected ? `${s.rowCount} строк, заголовки распознаны` : 'заголовки реестра не найдены'}{s.hidden ? ', скрыт' : ''}</span>
                </label>))}
              <div className="flex gap-4 flex-wrap items-center">
                <label className="flex items-center gap-2">Год плана (W1–W4)<input className="input w-24" value={year} onChange={(e) => setYear(e.target.value)} inputMode="numeric" /></label>
                <label className="flex items-center gap-2"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Обновлять автоматически</label>
                {auto && <label className="flex items-center gap-2">каждые<select className="input" value={interval} onChange={(e) => setIntervalMin(e.target.value)}>{[['15', '15 минут'], ['60', 'час'], ['180', '3 часа'], ['720', '12 часов'], ['1440', 'сутки']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>}
              </div>
              <button className="btn btn-primary" disabled={busy === 'create' || !sheet || !/^\d{4}$/.test(year)} onClick={create}>{busy === 'create' ? 'Загрузка данных…' : 'Подключить и загрузить данные'}</button>
              <p className="muted text-xs">После загрузки откроется предпросмотр — данные попадут в систему только после вашего подтверждения.</p>
            </div>)}
        </section>)}

      <section className="space-y-2">
        <h2 className="font-semibold">Подключённые таблицы</h2>
        <div className="panel overflow-x-auto">
          <table className="tbl"><thead><tr><th>Таблица</th><th>Лист</th><th>Статус</th><th>Последняя синхронизация</th><th>Следующая</th><th>Изменения</th><th></th></tr></thead>
            <tbody>{sources?.map((s) => { const st = STATUS[s.lastStatus ?? ''] ?? ['Не запускалась', 'b-mute']; const c = s.lastChanges; return (
              <tr key={s.id}>
                <td className="max-w-64"><a className="underline" href={s.url} target="_blank" rel="noreferrer noopener">{s.name}</a><div className="muted text-xs">{s.mode === 'PUBLIC' ? 'публичная ссылка' : 'через аккаунт Google'}</div></td>
                <td>{s.sheetName}<div className="muted text-xs">план {s.planYear}</div></td>
                <td><span className={`badge ${st[1]}`}>{s.syncing ? 'Синхронизируется…' : st[0]}</span>{s.lastError && <div className="b-err text-xs max-w-64">{s.lastError}</div>}</td>
                <td>{dt(s.lastSyncAt)}</td><td>{s.autoSync ? dt(s.nextSyncAt) : <span className="muted">вручную</span>}</td>
                <td className="text-xs">{c ? <>+{c.added} новых · {c.changed} изм.{c.paidChanged ? <b className="b-warn"> ({c.paidChanged} по «Оплачено»)</b> : null} · −{c.removed}{c.blocked ? <span className="b-err"> · {c.blocked} заблокировано</span> : null}</> : '—'}
                  {s.lastBatchId && s.lastBatchStatus === 'ANALYZED' && <div><Link className="underline b-warn" href={`/imports/${s.lastBatchId}`}>Проверить и применить →</Link></div>}</td>
                <td className="whitespace-nowrap">{can('import.run') && <button className="btn" disabled={!!busy || s.syncing} onClick={() => syncNow(s.id)}>{busy === `sync-${s.id}` ? '…' : 'Синхронизировать'}</button>}{' '}
                  {manage && <>
                    <button className="btn" onClick={() => run('auto', async () => { await api('PATCH', `/google/sources/${s.id}`, { autoSync: !s.autoSync }); load(); })}>{s.autoSync ? 'Выкл. авто' : 'Вкл. авто'}</button>{' '}
                    <button className="btn" onClick={() => confirm('Удалить источник? Уже сохранённые договоры останутся.') && run('del', async () => { await api('DELETE', `/google/sources/${s.id}`); load(); })}>Удалить</button></>}</td>
              </tr>); })}
              {sources?.length === 0 && <tr><td colSpan={7} className="muted">Таблицы ещё не подключены</td></tr>}</tbody></table>
        </div>
      </section>

      {manage && (
        <section className="panel p-4 space-y-2">
          <h2 className="font-semibold">Google-аккаунт (для закрытых таблиц)</h2>
          {!status?.oauthConfigured
            ? <p className="muted text-sm">Не настроено на сервере. Для публичных таблиц это не требуется.</p>
            : status.connection
              ? <div className="flex gap-3 items-center flex-wrap"><span>Подключён: <b>{status.connection.email ?? 'аккаунт Google'}</b> <span className="muted text-xs">(права: только чтение таблиц)</span></span>
                  <button className="btn" onClick={() => run('disc', async () => { await api('POST', '/google/oauth/disconnect'); load(); })}>Отключить</button></div>
              : <button className="btn" onClick={connect}>Подключить Google-аккаунт</button>}
        </section>)}
    </div>
  );
}
