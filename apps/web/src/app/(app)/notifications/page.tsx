'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';

type Settings = {
  enabled: boolean; hour: number; weekdaysOnly: boolean; leadDays: number; telegramChatIds: string[]; emails: string[]; alerts: boolean;
  include: { overdue: boolean; upcoming: boolean; pending: boolean; plant: boolean; fx: boolean; system: boolean };
};
const INCLUDE: [keyof Settings['include'], string][] = [
  ['overdue', 'Просроченные обязательства'], ['upcoming', 'Ближайшие платежи'], ['pending', 'Платежи, ожидающие подтверждения'],
  ['fx', 'Курсы, ожидающие подтверждения'], ['plant', 'Состояние цветка'], ['system', 'Проблемы системы'],
];
const split = (s: string) => s.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);

export default function NotificationsPage() {
  const [data, setData] = useState<{ settings: Settings; channels: { telegram: boolean; email: boolean; timezone: string }; state: any } | null>(null);
  const [s, setS] = useState<Settings | null>(null);
  const [tg, setTg] = useState('');
  const [mail, setMail] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [preview, setPreview] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api<any>('GET', '/notifications/settings').then((r) => { setData(r); setS(r.settings); setTg(r.settings.telegramChatIds.join('\n')); setMail(r.settings.emails.join('\n')); }).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);

  const body = (): Settings | null => (s ? { ...s, telegramChatIds: split(tg), emails: split(mail) } : null);
  const run = async (fn: () => Promise<void>) => { setBusy(true); setError(''); setNotice(''); try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  const save = () => run(async () => { await api('PUT', '/notifications/settings', body()); setNotice('Настройки сохранены.'); await load(); });
  const report = (r: { sent: number; errors: string[] }) => { setNotice(r.sent ? `Отправлено получателям: ${r.sent}.` : ''); if (r.errors.length) setError(r.errors.join(' · ')); };
  const test = () => run(async () => { await api('PUT', '/notifications/settings', body()); report(await api('POST', '/notifications/test')); await load(); });
  const sendNow = () => run(async () => { await api('PUT', '/notifications/settings', body()); report(await api('POST', '/notifications/send-digest')); await load(); });
  const show = () => run(async () => { setPreview((await api<any>('GET', `/notifications/preview?lead=${s?.leadDays ?? 3}`)).text); });

  if (!s || !data) return <p className="muted">{error || 'Загрузка…'}</p>;
  const ch = data.channels;
  return (
    <div className="space-y-4 max-w-4xl">
      <div><h1 className="text-xl font-semibold">Уведомления</h1>
        <p className="muted">Ежедневная сводка и тревоги о проблемах системы в Telegram и на почту. Расчёты те же, что на Dashboard. Время — по часовому поясу {ch.timezone}.</p></div>
      {error && <p role="alert" className="b-err">{error}</p>}
      {notice && <p role="status" className="b-ok">{notice}</p>}

      <section className="panel p-4 space-y-2">
        <h2 className="font-semibold">Каналы</h2>
        <ul className="text-sm space-y-1">
          <li><span className={`badge ${ch.telegram ? 'b-ok' : 'b-warn'}`}>Telegram: {ch.telegram ? 'подключён' : 'не подключён'}</span>{!ch.telegram && <span className="muted"> — задайте <code>TELEGRAM_BOT_TOKEN</code> (токен бота от @BotFather) в <code>.env</code> на сервере и перезапустите.</span>}</li>
          <li><span className={`badge ${ch.email ? 'b-ok' : 'b-warn'}`}>Почта: {ch.email ? 'подключена' : 'не подключена'}</span>{!ch.email && <span className="muted"> — задайте <code>SMTP_HOST</code>, <code>SMTP_FROM</code> (и при необходимости <code>SMTP_USER</code>, <code>SMTP_PASS</code>) в <code>.env</code>.</span>}</li>
        </ul>
      </section>

      <section className="panel p-4 space-y-3">
        <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" style={{ accentColor: 'var(--accent)', width: 16, height: 16 }} checked={s.enabled} onChange={(e) => setS({ ...s, enabled: e.target.checked })} /><b>Уведомления включены</b></label>
        <div className="grid sm:grid-cols-3 gap-3">
          <label className="block space-y-1"><span className="muted text-xs">Отправлять сводку после, часов</span>
            <select className="input w-full" value={s.hour} onChange={(e) => setS({ ...s, hour: Number(e.target.value) })}>{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}</select></label>
          <label className="block space-y-1"><span className="muted text-xs">Ближайшие платежи — за, дней</span>
            <select className="input w-full" value={s.leadDays} onChange={(e) => setS({ ...s, leadDays: Number(e.target.value) })}>{[1, 2, 3, 5, 7, 10, 14].map((d) => <option key={d} value={d}>{d}</option>)}</select></label>
          <label className="flex items-end gap-2 pb-2 cursor-pointer"><input type="checkbox" style={{ accentColor: 'var(--accent)', width: 16, height: 16 }} checked={s.weekdaysOnly} onChange={(e) => setS({ ...s, weekdaysOnly: e.target.checked })} />Только по будням</label>
        </div>
        <div className="grid sm:grid-cols-2 gap-3">
          <label className="block space-y-1"><span className="muted text-xs">Telegram: chat id (по одному в строке; можно @канал)</span>
            <textarea className="input w-full" rows={3} value={tg} onChange={(e) => setTg(e.target.value)} placeholder="123456789" /></label>
          <label className="block space-y-1"><span className="muted text-xs">Почта: адреса (по одному в строке)</span>
            <textarea className="input w-full" rows={3} value={mail} onChange={(e) => setMail(e.target.value)} placeholder="name@example.com" /></label>
        </div>
        <fieldset className="space-y-1"><legend className="muted text-xs">Что включать в сводку</legend>
          <div className="grid sm:grid-cols-2 gap-x-4 gap-y-1">{INCLUDE.map(([k, label]) => (
            <label key={k} className="flex items-center gap-2 cursor-pointer"><input type="checkbox" style={{ accentColor: 'var(--accent)' }} checked={s.include[k]} onChange={(e) => setS({ ...s, include: { ...s.include, [k]: e.target.checked } })} />{label}</label>))}</div></fieldset>
        <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" style={{ accentColor: 'var(--accent)' }} checked={s.alerts} onChange={(e) => setS({ ...s, alerts: e.target.checked })} />Сразу сообщать о проблемах системы (воркер, резервные копии, диск) — один раз, затем напоминание раз в сутки</label>
        <div className="flex gap-2 flex-wrap">
          <button className="btn btn-primary" disabled={busy} onClick={save}>Сохранить</button>
          <button className="btn" disabled={busy} onClick={test}>Пробное сообщение</button>
          <button className="btn" disabled={busy} onClick={sendNow}>Отправить сводку сейчас</button>
          <button className="btn" disabled={busy} onClick={show}>Предпросмотр сводки</button>
        </div>
        <p className="muted text-xs">«Пробное сообщение» и «Отправить сейчас» сначала сохраняют форму. {data.state?.lastDigestAt && <>Последняя сводка: {new Date(data.state.lastDigestAt).toLocaleString('ru-RU')}. </>}{data.state?.lastError && <span className="b-err">Последняя ошибка: {data.state.lastError}</span>}</p>
      </section>

      {preview && (
        <section className="panel p-4 space-y-2"><h2 className="font-semibold">Так будет выглядеть сообщение</h2>
          <pre className="text-sm whitespace-pre-wrap" style={{ font: 'inherit' }}>{preview}</pre></section>)}
    </div>
  );
}
