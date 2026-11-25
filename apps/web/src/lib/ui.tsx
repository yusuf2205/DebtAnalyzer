'use client';
import type { ReactNode } from 'react';
import { money } from './api';

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

export function TotalsStrip({ totals }: { totals: any[] }) {
  if (!totals?.length) return null;
  return (
    <div className="panel overflow-x-auto">
      <table className="tbl"><thead><tr><th>Итого по валюте</th><th className="num">Договоров</th><th className="num">Сумма</th><th className="num">Оплачено</th><th className="num">Долг</th><th className="num">Переплата</th><th className="num">План</th></tr></thead>
        <tbody>{totals.map((t) => (
          <tr key={t.currency}><td><b>{t.currency}</b></td><td className="num">{t.contracts}</td><td className="num">{money(t.amount)}</td><td className="num b-ok">{money(t.paid)}</td>
            <td className="num b-err">{money(t.debt)}</td><td className="num b-info">{Number(t.overpaid) ? money(t.overpaid) : '—'}</td><td className="num b-info">{money(t.planned)}</td></tr>))}</tbody></table>
    </div>
  );
}

export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  if (total <= pageSize) return null;
  const pages = Math.ceil(total / pageSize);
  return (
    <div className="flex gap-2 items-center">
      <button className="btn" disabled={page <= 1} onClick={() => onPage(page - 1)}>←</button>
      <span className="muted">{page} / {pages}</span>
      <button className="btn" disabled={page >= pages} onClick={() => onPage(page + 1)}>→</button>
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
  return <div className="panel p-3"><div className="muted text-xs">{label}</div><div className={`text-lg font-semibold ${tone ?? ''}`}>{value}</div></div>;
}

/** Скачивание файла из API (с cookie). Ссылка <a href> достаточна: GET, same-origin. */
export function ExportLink({ href, children }: { href: string; children: ReactNode }) {
  return <a className="btn" href={`/api${href}`} download>{children}</a>;
}
