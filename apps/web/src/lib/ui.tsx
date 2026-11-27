'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { api, money } from './api';

export const STATE: Record<string, [string, string]> = {
  UNPAID: ['Не оплачен', 'b-err'], PARTIAL: ['Частично', 'b-mute'], PAID: ['Оплачен', 'b-ok'], OVERPAID: ['Переплата', 'b-info'],
};
export const PAY_STATUS: Record<string, [string, string]> = {
  DRAFT: ['Черновик', 'b-mute'], PENDING: ['Ожидает подтверждения', 'b-warn'], APPROVED: ['Подтверждён', 'b-ok'], REJECTED: ['Отклонён', 'b-err'], CANCELLED: ['Отменён', 'b-mute'],
};
export const PAY_KIND: Record<string, string> = { PAYMENT: 'Оплата', REFUND: 'Возврат', REVERSAL: 'Сторно' };
export function PayBadge({ status }: { status: string }) {
  const s = PAY_STATUS[status] ?? [status, 'b-mute'];
  return <span className={`badge ${s[1]}`}>{s[0]}</span>;
}
export const ORIGIN_TEXT: Record<string, string> = { LOCAL: 'Местный', FOREIGN: 'Зарубежный' };
/** Тип договора: подтверждённое значение — бейдж; если не подтверждено, предложение системы — бледный текст со знаком «?». */
export function OriginBadge({ c }: { c: { origin: string | null; originSuggested: string | null } }) {
  if (c.origin) return <span className={`badge ${c.origin === 'LOCAL' ? 'b-ok' : 'b-info'}`}>{ORIGIN_TEXT[c.origin]}</span>;
  if (c.originSuggested) return <span className="muted text-xs" title="Предложение системы: ещё не подтверждено">{ORIGIN_TEXT[c.originSuggested].toLowerCase()}?</span>;
  return <span className="muted">—</span>;
}
export const CURRENCIES = ['USD', 'UZS', 'RUB', 'EUR'] as const;

export function StateBadge({ state }: { state: string }) {
  const s = STATE[state] ?? [state, 'b-mute'];
  return <span className={`badge ${s[1]}`}>{s[0]}</span>;
}

export function qs(o: Record<string, string | number | undefined | null>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  return p.toString();
}

/** Значения по валютам столбиком — разные валюты никогда не складываются. */
export function PerCurrency({ items, field, tone }: { items: any[]; field: string; tone?: string }) {
  if (!items?.length) return <span className="muted">—</span>;
  return <div className="space-y-0.5">{items.map((c) => <div key={c.currency} className={`num ${Number(c[field]) ? tone ?? '' : 'muted'}`}>{money(c[field])} <span className="muted text-xs">{c.currency}</span></div>)}</div>;
}

/** «Итого по валюте» можно скрыть; выбор запоминается в браузере и общий для списков. */
export function TotalsStrip({ totals }: { totals: any[] }) {
  const [hidden, setHidden] = useState(false);
  useEffect(() => { try { setHidden(localStorage.getItem('pf-totals-hidden') === '1'); } catch {} }, []);
  const toggle = () => { const n = !hidden; setHidden(n); try { localStorage.setItem('pf-totals-hidden', n ? '1' : '0'); } catch {} };
  if (!totals?.length) return null;
  return (
    <div className="space-y-2">
      <button type="button" className="chip" aria-expanded={!hidden} onClick={toggle}>{hidden ? '▸ Показать итоги по валюте' : '▾ Скрыть итоги по валюте'}</button>
      {!hidden && (
        <div className="panel overflow-x-auto">
          <table className="tbl"><thead><tr><th>Итого по валюте</th><th className="num">Договоров</th><th className="num">Сумма</th><th className="num">Оплачено</th><th className="num">Долг</th><th className="num">Переплата</th><th className="num">План</th></tr></thead>
            <tbody>{totals.map((t) => (
              <tr key={t.currency}><td><b>{t.currency}</b></td><td className="num">{t.contracts}</td><td className="num">{money(t.amount)}</td><td className="num b-ok">{money(t.paid)}</td>
                <td className="num b-err">{money(t.debt)}</td><td className="num b-info">{Number(t.overpaid) ? money(t.overpaid) : '—'}</td><td className="num b-info">{money(t.planned)}</td></tr>))}</tbody></table>
        </div>)}
    </div>
  );
}

export const PAGE_SIZES = [50, 100, 150, 200, 300, 400, 500] as const;
/** Размер страницы списка: выбор запоминается в браузере отдельно для каждого списка. */
export function usePageSize(key: string): [number, (n: number) => void] {
  const [n, setN] = useState(50);
  useEffect(() => { try { const v = Number(localStorage.getItem(`pf-pagesize-${key}`)); if ((PAGE_SIZES as readonly number[]).includes(v)) setN(v); } catch {} }, [key]);
  const set = (v: number) => { setN(v); try { localStorage.setItem(`pf-pagesize-${key}`, String(v)); } catch {} };
  return [n, set];
}

/** Панель страниц в стиле почты: «Строк: 50 ▾   1–50 из 309   ‹ ›». */
export function PagerBar({ page, pageSize, total, noun, onPage, onPageSize }: { page: number; pageSize: number; total: number; noun: string; onPage: (p: number) => void; onPageSize: (n: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <div className="flex items-center justify-end gap-3 flex-wrap text-sm">
      <label className="flex items-center gap-1.5 muted">Строк на странице
        <select className="input" style={{ padding: '3px 26px 3px 8px' }} value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))} aria-label={`Сколько ${noun} показывать на странице`}>
          {PAGE_SIZES.map((x) => <option key={x} value={x}>{x}</option>)}
        </select></label>
      <span className="tabular-nums" aria-live="polite">{from}–{to} из {total} <span className="muted">{noun}</span></span>
      <span className="flex gap-1">
        <button type="button" className="btn" style={{ padding: '3px 12px' }} disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Предыдущая страница">‹</button>
        <button type="button" className="btn" style={{ padding: '3px 12px' }} disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Следующая страница">›</button>
      </span>
    </div>
  );
}

export function Th({ label, field, sort, dir, onSort, className }: { label: string; field: string; sort: string; dir: string; onSort: (f: string) => void; className?: string }) {
  return (
    <th className={className} style={{ cursor: 'pointer' }} onClick={() => onSort(field)} aria-sort={sort === field ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      {label}{sort === field ? (dir === 'asc' ? ' ↑' : ' ↓') : ''}
    </th>
  );
}

export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: string }) {
  return <div className="panel p-4"><div className="muted text-xs font-medium">{label}</div><div className={`text-xl font-semibold mt-1 tracking-tight ${tone ?? ''}`} style={{ fontVariantNumeric: 'tabular-nums' }}>{value}</div></div>;
}

/** Скачивание файла из API (с cookie). Ссылка <a href> достаточна: GET, same-origin. */
export function ExportLink({ href, children }: { href: string; children: ReactNode }) {
  return <a className="btn" href={`/api${href}`} download>{children}</a>;
}

/** Простое модальное окно (Esc и клик по фону закрывают). */
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div role="dialog" aria-modal="true" aria-label={title} className="fixed inset-0 z-50 grid place-items-center p-4" style={{ background: 'rgba(0,0,0,.45)' }}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="panel w-full max-w-lg p-5 space-y-3 max-h-[90vh] overflow-auto">
        <div className="flex justify-between items-center"><h2 className="font-semibold">{title}</h2><button className="btn" onClick={onClose} aria-label="Закрыть">✕</button></div>
        {children}
      </div>
    </div>
  );
}

/** Выбор контрагента поиском (для фильтров). */
export function SupplierPicker({ value, onChange }: { value: { id: string; name: string } | null; onChange: (v: { id: string; name: string } | null) => void }) {
  const [q, setQ] = useState('');
  const [found, setFound] = useState<any[]>([]);
  useEffect(() => {
    if (q.trim().length < 2) { setFound([]); return; }
    const t = setTimeout(() => api('GET', `/suppliers?q=${encodeURIComponent(q)}&pageSize=8`).then((r) => setFound(r.items)).catch(() => {}), 200);
    return () => clearTimeout(t);
  }, [q]);
  if (value) return <span className="flex items-center gap-1 input">{value.name.slice(0, 30)}<button className="underline text-xs" onClick={() => onChange(null)} aria-label="Сбросить контрагента">✕</button></span>;
  return (
    <span className="relative">
      <input className="input" placeholder="Контрагент…" value={q} onChange={(e) => setQ(e.target.value)} />
      {found.length > 0 && <ul className="panel absolute z-20 mt-1 p-1 w-72 max-h-60 overflow-auto">{found.map((s) => <li key={s.id}><button className="w-full text-left px-2 py-1 hover:underline" onClick={() => { onChange({ id: s.id, name: s.name }); setQ(''); setFound([]); }}>{s.name}</button></li>)}</ul>}
    </span>
  );
}

/** Компактные числа для осей графиков (1,2 млн). */
export const compact = (v: number) => new Intl.NumberFormat('ru-RU', { notation: 'compact', maximumFractionDigits: 1 }).format(v);
