'use client';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, money } from '@/lib/api';
import { CURRENCIES, SupplierPicker, compact, qs } from '@/lib/ui';

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const C = { paid: 'var(--paid)', debt: 'var(--debt)', plan: 'var(--plan)', pending: 'var(--pending)', muted: 'var(--muted)' };
const PIE = ['#1d4ed8', '#15803d', '#c2570c', '#7c3aed'];
const num = (v: any) => (v === null || v === undefined ? 0 : Number(v));

export default function DashboardPage() {
  const [f, setF] = useState({ currency: '', project: '', executor: '', status: 'ACTIVE', from: '', to: '', horizon: '30' });
  const [supplier, setSupplier] = useState<{ id: string; name: string } | null>(null);
  const [display, setDisplay] = useState('AUTO'); // AUTO = USD-эквивалент, если курсы есть
  const [d, setD] = useState<any>(null);
  const [error, setError] = useState('');
  const query = qs({ ...f, supplierId: supplier?.id });

  useEffect(() => {
    const t = setTimeout(() => api('GET', `/dashboard?${query}`).then((r) => { setD(r); setError(''); }).catch((e) => setError(e.message)), f.project || f.executor ? 300 : 0);
    return () => clearTimeout(t);
  }, [query, f.project, f.executor]);

  const present: string[] = useMemo(() => d?.kpi.byCurrency.map((c: any) => c.currency) ?? [], [d]);
  const mode = display === 'AUTO' ? (d?.rates.usdComplete && present.length ? 'USD_EQ' : (present.includes('USD') ? 'USD' : present[0] ?? 'USD')) : display;
  const unit = mode === 'USD_EQ' ? 'USD (экв.)' : mode;

  return (
    <div className="space-y-4 max-w-7xl">
      <div><h1 className="text-xl font-semibold">Dashboard</h1><p className="muted">Задолженность перед поставщиками, оплаты и планы. Валюты не смешиваются: суммы показаны в исходных валютах и в эквиваленте USD по подтверждённым курсам.</p></div>
      {error && <p role="alert" className="b-err">{error}</p>}

      <div className="flex gap-2 flex-wrap items-center">
        <select className="input" value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })}><option value="">Все валюты</option>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</select>
        <SupplierPicker value={supplier} onChange={setSupplier} />
        <input className="input w-36" placeholder="Проект" value={f.project} onChange={(e) => setF({ ...f, project: e.target.value })} />
        <input className="input w-36" placeholder="Исполнитель" value={f.executor} onChange={(e) => setF({ ...f, executor: e.target.value })} />
        <select className="input" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="ACTIVE">Активные договоры</option><option value="ARCHIVED">Архивные</option><option value="ALL">Все</option></select>
        <label className="flex items-center gap-1 muted text-xs">период с<input className="input" type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></label>
        <label className="flex items-center gap-1 muted text-xs">по<input className="input" type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></label>
        <label className="flex items-center gap-1 muted text-xs">предстоящие, дней<select className="input" value={f.horizon} onChange={(e) => setF({ ...f, horizon: e.target.value })}>{['7', '14', '30', '60', '90', '365'].map((x) => <option key={x}>{x}</option>)}</select></label>
      </div>

      {d?.rates.note && <div className="panel p-3" style={{ borderColor: 'var(--pending)' }}><b className="b-warn">Итоги в USD неполные.</b> {d.rates.note} <Link className="underline" href="/fx">Курсы валют →</Link></div>}

      {!d ? <p className="muted">Загрузка…</p> : (<>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Card title="Договоров" value={d.kpi.contracts} />
          <Card title="Контрагентов" value={d.kpi.suppliers} />
          <Money complete={d.rates.usdComplete} title="Сумма договоров" tone="" usd={d.kpi.totalUsd.amount} rows={d.kpi.byCurrency.map((c: any) => ({ cur: c.currency, v: c.amount }))} />
          <Money complete={d.rates.usdComplete} title="Оплачено" tone="b-ok" hint="остаток из файла + подтверждённые платежи" usd={d.kpi.totalUsd.paid} rows={d.kpi.byCurrency.map((c: any) => ({ cur: c.currency, v: c.paid }))} />
          <Money complete={d.rates.usdComplete} title="Текущая задолженность" tone="b-err" usd={d.kpi.totalUsd.debt} rows={d.kpi.byCurrency.map((c: any) => ({ cur: c.currency, v: c.debt }))} />
          <Money complete={d.rates.usdComplete} title="Плановые платежи" tone="b-info" hint="не уменьшают долг" usd={d.kpi.totalUsd.planned} rows={d.kpi.byCurrency.map((c: any) => ({ cur: c.currency, v: c.planned }))} />
          <Money complete={d.rates.usdComplete} title="Просроченные обязательства" tone="b-err" hint="невыполненный план прошедших недель, не больше долга" usd={d.overdue.totalUsd} rows={d.overdue.byCurrency.map((c: any) => ({ cur: c.currency, v: c.amount }))} empty="нет" />
          <Money complete={d.rates.usdComplete} title={`Предстоящие платежи (${d.upcoming.horizonDays} дн.)`} tone="b-info" usd={d.upcoming.totalUsd} rows={d.upcoming.byCurrency.map((c: any) => ({ cur: c.currency, v: c.amount }))} empty="нет" />
          <Money complete={d.rates.usdComplete} title="Переплаты" tone="b-info" usd={d.overpaid.totalUsd} rows={d.overpaid.byCurrency.map((c: any) => ({ cur: c.currency, v: c.amount }))} empty="нет" />
        </div>

        <div className="flex items-center gap-2 flex-wrap"><span className="muted text-sm">Графики показаны в:</span>
          <select className="input" value={display} onChange={(e) => setDisplay(e.target.value)}>
            <option value="AUTO">Авто</option>{d.rates.usdComplete && <option value="USD_EQ">USD (эквивалент всех валют)</option>}{present.map((c) => <option key={c} value={c}>{c} (в исходной валюте)</option>)}
          </select><span className="muted text-xs">сейчас: {unit}</span></div>

        <div className="grid lg:grid-cols-2 gap-4">
          <SuppliersAmountChart d={d} mode={mode} unit={unit} />
          <DebtByCurrencyChart d={d} />
          <DebtBySupplierChart d={d} mode={mode} unit={unit} />
          <PlanFactChart d={d} mode={mode} unit={unit} />
          <DynamicsChart d={d} mode={mode} unit={unit} />
          <Lists d={d} />
        </div>

        <details className="panel p-3"><summary className="cursor-pointer text-sm">Как считаются показатели</summary>
          <ul className="text-sm list-disc pl-5 mt-2 muted">{d.notes.map((n: string, i: number) => <li key={i}>{n}</li>)}
            <li>Использованные курсы (UZS за 1 ед.): {d.rates.used.length ? d.rates.used.map((u: any) => `${u.currency} ${u.uzsPerUnit} от ${u.effectiveDate}`).join('; ') : 'подтверждённых курсов нет'}</li></ul></details>
      </>)}
    </div>
  );
}

function Card({ title, value }: { title: string; value: any }) {
  return <div className="panel p-3"><div className="muted text-xs">{title}</div><div className="text-2xl font-semibold">{value}</div></div>;
}

function Money({ title, tone, usd, rows, hint, empty, complete }: { title: string; tone: string; usd: string | null; rows: { cur: string; v: string }[]; hint?: string; empty?: string; complete?: boolean }) {
  const nz = rows.filter((r) => num(r.v) !== 0);
  return (
    <div className="panel p-3 space-y-1">
      <div className="muted text-xs" title={hint}>{title}</div>
      {usd !== null && usd !== undefined ? <div className={`text-xl font-semibold ${tone}`}>{money(usd)} <span className={`text-xs font-normal ${complete === false ? 'b-warn' : 'muted'}`} title={complete === false ? 'Не по всем валютам есть подтверждённый курс: в итог вошли только валюты с курсом' : undefined}>{complete === false ? 'USD, итог неполный' : 'USD экв.'}</span></div> : <div className="text-sm muted">{nz.length ? 'USD: нет курса' : (empty ?? '—')}</div>}
      <div className="space-y-0.5">{nz.map((r) => <div key={r.cur} className="text-xs flex justify-between gap-2"><span className="muted">{r.cur}</span><span className={tone}>{money(r.v)}</span></div>)}</div>
    </div>
  );
}

function Panel({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return <section className="panel p-4 space-y-2"><div><h2 className="font-semibold">{title}</h2>{note && <p className="muted text-xs">{note}</p>}</div>{children}</section>;
}
const tt = (unit: string) => ({ formatter: (v: any) => `${money(v)} ${unit}`, contentStyle: { background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text)' }, labelStyle: { color: 'var(--text)' } });
const axis = { tick: { fill: 'var(--muted)', fontSize: 11 }, stroke: 'var(--border)' };

function pick(s: any, k: 'amount' | 'paid' | 'debt', mode: string) {
  return mode === 'USD_EQ' ? (s.usd ? num(s.usd[k]) : null) : num(s.byCurrency[mode]?.[k]);
}

function SuppliersAmountChart({ d, mode, unit }: any) {
  const data = d.charts.suppliers.map((s: any) => ({ name: s.name.replace(/\s+/g, ' ').slice(0, 22), amount: pick(s, 'amount', mode), paid: pick(s, 'paid', mode) }))
    .filter((x: any) => x.amount !== null && x.amount > 0).sort((a: any, b: any) => b.amount - a.amount).slice(0, 10);
  return (
    <Panel title="Договоры и оплаты по контрагентам" note={`Топ-10 по сумме договоров, ${unit}. Оплачено = остаток из файла + подтверждённые платежи.`}>
      {data.length === 0 ? <p className="muted text-sm">Нет данных в выбранной валюте.</p> : (
        <ResponsiveContainer width="100%" height={300}><BarChart data={data} margin={{ left: 8, right: 8, bottom: 40 }}>
          <CartesianGrid stroke="var(--border)" vertical={false} /><XAxis dataKey="name" {...axis} angle={-30} textAnchor="end" interval={0} height={60} /><YAxis {...axis} tickFormatter={compact} width={52} />
          <Tooltip {...tt(unit)} /><Legend verticalAlign="top" height={28} /><Bar isAnimationActive={false} dataKey="amount" name="Сумма договоров" fill={C.muted} /><Bar isAnimationActive={false} dataKey="paid" name="Оплачено" fill={C.paid} /></BarChart></ResponsiveContainer>)}
    </Panel>
  );
}

function DebtByCurrencyChart({ d }: any) {
  const data = d.kpi.byCurrency.map((c: any) => ({ name: c.currency, value: c.usd ? num(c.usd.debt) : 0, native: c.debt, has: !!c.usd })).filter((x: any) => x.value > 0);
  const missing = d.kpi.byCurrency.filter((c: any) => !c.usd && num(c.debt) > 0).map((c: any) => c.currency);
  return (
    <Panel title="Задолженность по валютам" note="Доля в эквиваленте USD по подтверждённым курсам.">
      {data.length === 0 ? <p className="muted text-sm">Нужны подтверждённые курсы валют, чтобы сравнить валюты. <Link className="underline" href="/fx">Подтвердить курсы →</Link></p> : (
        <ResponsiveContainer width="100%" height={300}><PieChart>
          <Pie isAnimationActive={false} data={data} dataKey="value" nameKey="name" outerRadius={100} label={(p: any) => `${p.name} ${(p.percent * 100).toFixed(0)}%`}>{data.map((_: any, i: number) => <Cell key={i} fill={PIE[i % PIE.length]} />)}</Pie>
          <Tooltip {...tt('USD экв.')} /><Legend /></PieChart></ResponsiveContainer>)}
      {missing.length > 0 && data.length > 0 && <p className="text-xs b-warn">Не показаны (нет курса): {missing.join(', ')}</p>}
    </Panel>
  );
}

function DebtBySupplierChart({ d, mode, unit }: any) {
  const data = d.charts.suppliers.map((s: any) => ({ name: s.name.replace(/\s+/g, ' ').slice(0, 26), debt: pick(s, 'debt', mode) })).filter((x: any) => x.debt !== null && x.debt > 0).sort((a: any, b: any) => b.debt - a.debt).slice(0, 10);
  return (
    <Panel title="Задолженность по контрагентам" note={`Топ-10, ${unit}.`}>
      {data.length === 0 ? <p className="muted text-sm">Долгов в выбранной валюте нет.</p> : (
        <ResponsiveContainer width="100%" height={320}><BarChart data={data} layout="vertical" margin={{ left: 16, right: 16 }}>
          <CartesianGrid stroke="var(--border)" horizontal={false} /><XAxis type="number" {...axis} tickFormatter={compact} /><YAxis type="category" dataKey="name" {...axis} width={150} />
          <Tooltip {...tt(unit)} /><Bar isAnimationActive={false} dataKey="debt" name="Долг" fill={C.debt} /></BarChart></ResponsiveContainer>)}
    </Panel>
  );
}

function PlanFactChart({ d, mode, unit }: any) {
  const data = d.charts.months.map((m: any) => {
    const v = mode === 'USD_EQ' ? m.usd : m.byCurrency[mode];
    return { name: `${MONTHS[m.month - 1]} ${String(m.year).slice(2)}`, planned: v ? num(v.planned) : null, actual: v ? num(v.actual) : 0 };
  });
  return (
    <Panel title="План и факт платежей" note={`Период ${d.period.from} — ${d.period.to}, ${unit}. Факт — подтверждённые платежи приложения с датой.`}>
      <ResponsiveContainer width="100%" height={300}><BarChart data={data} margin={{ left: 8, right: 8 }}>
        <CartesianGrid stroke="var(--border)" vertical={false} /><XAxis dataKey="name" {...axis} /><YAxis {...axis} tickFormatter={compact} width={52} />
        <Tooltip {...tt(unit)} /><Legend /><Bar isAnimationActive={false} dataKey="planned" name="План" fill={C.plan} /><Bar isAnimationActive={false} dataKey="actual" name="Факт" fill={C.paid} /></BarChart></ResponsiveContainer>
    </Panel>
  );
}

function DynamicsChart({ d, mode, unit }: any) {
  const data = d.charts.dynamics.map((p: any) => ({ date: p.date.slice(5), value: mode === 'USD_EQ' ? (p.usdComplete ? num(p.totalUsd) : null) : num(p.byCurrency[mode]) }));
  return (
    <Panel title="Динамика задолженности" note={`${unit}. Накапливается ежедневными снимками с момента запуска; снимок — по всему портфелю без фильтров.`}>
      {data.length < 2 ? <p className="muted text-sm">Снимков пока {data.length}. График появится, когда накопится хотя бы два дня.{data.length === 1 && <> Сейчас: {money(data[0].value)} {unit}.</>}</p> : (
        <ResponsiveContainer width="100%" height={300}><LineChart data={data} margin={{ left: 8, right: 8 }}>
          <CartesianGrid stroke="var(--border)" vertical={false} /><XAxis dataKey="date" {...axis} /><YAxis {...axis} tickFormatter={compact} width={52} />
          <Tooltip {...tt(unit)} /><Line isAnimationActive={false} type="monotone" dataKey="value" name="Долг" stroke={C.debt} strokeWidth={2} dot={data.length < 30} connectNulls={false} /></LineChart></ResponsiveContainer>)}
    </Panel>
  );
}

function Lists({ d }: any) {
  const row = (x: any, extra?: string) => <tr key={x.contractId + (x.year ?? '') + (x.week ?? '')}><td className="max-w-48 truncate"><Link className="underline" href={`/contracts/${x.contractId}`}>{x.number ?? '—'}</Link><div className="text-xs muted truncate">{x.supplier.name}</div></td><td className="num whitespace-nowrap">{money(x.amount)} {x.currency}</td>{extra !== undefined && <td className="text-xs muted whitespace-nowrap">{extra}</td>}</tr>;
  return (
    <Panel title="Требуют внимания">
      <div className="space-y-3">
        <div><h3 className="text-sm font-semibold b-err">Просрочено</h3>
          <table className="tbl"><tbody>{d.overdue.items.slice(0, 5).map((x: any) => row(x))}{!d.overdue.items.length && <tr><td className="muted">Просроченных обязательств нет</td></tr>}</tbody></table></div>
        <div><h3 className="text-sm font-semibold b-info">Ближайшие платежи</h3>
          <table className="tbl"><tbody>{d.upcoming.items.slice(0, 5).map((x: any) => row(x, `${x.from.slice(5)}…${x.to.slice(5)}`))}{!d.upcoming.items.length && <tr><td className="muted">На ближайшие недели плана нет</td></tr>}</tbody></table></div>
        <div><h3 className="text-sm font-semibold b-info">Переплаты</h3>
          <table className="tbl"><tbody>{d.overpaid.items.slice(0, 5).map((x: any) => row(x))}{!d.overpaid.items.length && <tr><td className="muted">Переплат нет</td></tr>}</tbody></table></div>
        <p className="text-xs"><Link className="underline" href="/calendar">Календарь платежей →</Link> · <Link className="underline" href="/reports">Отчёты →</Link></p>
      </div>
    </Panel>
  );
}
