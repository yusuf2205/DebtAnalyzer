'use client';
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { CURRENCIES, SupplierPicker, qs } from '@/lib/ui';

const PERIOD_REPORTS = new Set(['payments', 'plan', 'plan-vs-fact']);
const DEBT_REPORTS = new Set(['debt-by-supplier', 'debt-by-project', 'debt-by-executor', 'debt-by-contract']);
const MAX_PREVIEW = 500;

function fmt(v: any, type: string): string {
  if (v === null || v === undefined || v === '') return '';
  if (type === 'text') return String(v);
  if (type === 'date') { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v)); return m ? `${m[3]}.${m[2]}.${m[1]}` : String(v); }
  const n = Number(v); if (!Number.isFinite(n)) return String(v);
  if (type === 'int') return n.toLocaleString('ru-RU');
  if (type === 'rate') return n.toLocaleString('ru-RU', { maximumFractionDigits: 6 });
  if (type === 'percent') return `${n.toLocaleString('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`;
  return n.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function ReportsPage() {
  const { can } = useSession();
  const [catalog, setCatalog] = useState<any[]>([]);
  const [id, setId] = useState('total-debt');
  const [f, setF] = useState({ currency: '', project: '', executor: '', status: 'ACTIVE', from: '', to: '', asOf: '', onlyDebt: '' });
  const [supplier, setSupplier] = useState<{ id: string; name: string } | null>(null);
  const [r, setR] = useState<any>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => { api('GET', '/reports').then(setCatalog).catch((e) => setError(e.message)); }, []);
  const params = useMemo(() => qs({ ...f, supplierId: supplier?.id }), [f, supplier]);
  useEffect(() => {
    setLoading(true);
    const t = setTimeout(() => api('GET', `/reports/${id}?${params}`).then((x) => { setR(x); setError(''); }).catch((e) => { setError(e.message); setR(null); }).finally(() => setLoading(false)), f.project || f.executor ? 300 : 0);
    return () => clearTimeout(t);
  }, [id, params, f.project, f.executor]);

  const info = catalog.find((c) => c.id === id);
  const exportHref = (fmt: string) => `/api/reports/${id}/export?${qs({ ...f, supplierId: supplier?.id, format: fmt })}`;

  return (
    <div className="space-y-4 max-w-7xl">
      <div><h1 className="text-xl font-semibold">Отчёты</h1><p className="muted">Выберите отчёт, задайте условия, посмотрите результат и выгрузите в Excel, PDF или CSV. Экспорт точно повторяет то, что показано на экране.</p></div>
      {error && <p role="alert" className="b-err">{error}</p>}
      <div className="grid md:grid-cols-[260px_1fr] gap-4">
        <nav className="panel p-2 space-y-0.5 self-start" aria-label="Список отчётов">
          {catalog.map((c) => (
            <button key={c.id} onClick={() => setId(c.id)} className="w-full text-left px-2 py-1.5 rounded-md" style={id === c.id ? { background: 'var(--border)', fontWeight: 600 } : undefined}>{c.title}</button>))}
        </nav>

        <div className="space-y-3 min-w-0">
          {info && <p className="muted text-sm">{info.description}</p>}
          <div className="flex gap-2 flex-wrap items-center">
            <select className="input" value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })}><option value="">Все валюты</option>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</select>
            <SupplierPicker value={supplier} onChange={setSupplier} />
            <input className="input w-36" placeholder="Проект" value={f.project} onChange={(e) => setF({ ...f, project: e.target.value })} />
            <input className="input w-36" placeholder="Исполнитель" value={f.executor} onChange={(e) => setF({ ...f, executor: e.target.value })} />
            <select className="input" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="ACTIVE">Активные договоры</option><option value="ARCHIVED">Архивные</option><option value="ALL">Все</option></select>
            {PERIOD_REPORTS.has(id) && <>
              <label className="flex items-center gap-1 muted text-xs">с<input className="input" type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></label>
              <label className="flex items-center gap-1 muted text-xs">по<input className="input" type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></label></>}
            <label className="flex items-center gap-1 muted text-xs" title="Курсы валют и «прошедшие недели» берутся на эту дату">на дату<input className="input" type="date" value={f.asOf} onChange={(e) => setF({ ...f, asOf: e.target.value })} /></label>
            {DEBT_REPORTS.has(id) && <select className="input" value={f.onlyDebt} onChange={(e) => setF({ ...f, onlyDebt: e.target.value })}><option value="">Только с долгом</option><option value="false">Все строки</option></select>}
          </div>

          {r && (<>
            <div className="flex gap-2 flex-wrap items-center justify-between">
              <div className="text-xs muted">{r.filters.join(' · ')} · {r.rows.length} строк</div>
              {can('reports.export') && (
                <div className="flex gap-2">
                  <a className="btn btn-primary" href={exportHref('xlsx')} download>Excel</a><a className="btn" href={exportHref('pdf')} download>PDF</a><a className="btn" href={exportHref('csv')} download>CSV</a></div>)}
            </div>
            {r.warnings.map((w: string, i: number) => <p key={i} className="text-sm b-warn">⚠ {w}</p>)}
            {r.rates.used.length > 0 && <p className="text-xs muted">Курсы на {r.asOf} (UZS за 1 ед.): {r.rates.used.map((u: any) => `${u.currency} ${Number(u.uzsPerUnit).toLocaleString('ru-RU')} от ${u.effectiveDate}`).join('; ')}</p>}
            <div className="panel overflow-auto" style={{ maxHeight: '62vh', opacity: loading ? 0.6 : 1 }}>
              <table className="tbl"><thead><tr>{r.columns.map((c: any) => <th key={c.key} className={c.type === 'text' ? '' : 'num'}>{c.header}</th>)}</tr></thead>
                <tbody>{r.rows.slice(0, MAX_PREVIEW).map((row: any, i: number) => <tr key={i}>{r.columns.map((c: any) => <td key={c.key} className={c.type === 'text' ? 'max-w-72 truncate' : 'num'} title={c.type === 'text' ? String(row[c.key] ?? '') : undefined}>{fmt(row[c.key], c.type)}</td>)}</tr>)}
                  {r.rows.length === 0 && <tr><td colSpan={r.columns.length} className="muted">По выбранным условиям данных нет</td></tr>}
                  {r.totals.map((row: any, i: number) => <tr key={`t${i}`} style={{ fontWeight: 600, background: 'var(--bg)' }}>{r.columns.map((c: any) => <td key={c.key} className={c.type === 'text' ? '' : 'num'}>{fmt(row[c.key], c.type)}</td>)}</tr>)}</tbody></table>
            </div>
            {r.rows.length > MAX_PREVIEW && <p className="text-xs muted">На экране первые {MAX_PREVIEW} строк из {r.rows.length}; в файл попадают все.</p>}
          </>)}
          {!r && !error && <p className="muted">{loading ? 'Формируем отчёт…' : ''}</p>}
        </div>
      </div>
    </div>
  );
}
