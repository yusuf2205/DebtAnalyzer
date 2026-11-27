'use client';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, money } from '@/lib/api';
import { Icon, type IconName } from '@/lib/icons';
import { MOOD_NAME, PLANT_RULE_TEXT, Plant, STAGE_NAME } from '@/lib/plant';
import { useSession } from '@/lib/session';
import type { PlantMood, PlantStage } from '@pf/shared';
import { CURRENCIES, SupplierPicker, compact, qs } from '@/lib/ui';

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const C = { paid: 'var(--paid)', debt: 'var(--debt)', plan: 'var(--plan)', pending: 'var(--pending)', muted: 'var(--muted)' };
const PIE = ['#4f7a55', '#c27a1a', '#6659c2', '#cb4a3d'];
const num = (v: any) => (v === null || v === undefined ? 0 : Number(v));

const TABS = ['Долг', 'Оплачено', 'Просрочено', 'Скоро'];
function greeting(name: string) {
  const h = new Date().getHours();
  return `${h < 5 ? 'Доброй ночи' : h < 12 ? 'Доброе утро' : h < 18 ? 'Добрый день' : 'Добрый вечер'}, ${name.split(/\s+/)[0]}`;
}

/** Главное число плитки: итог в USD, а без курсов — суммы по валютам (валюты не смешиваются). */
const whole = (v: any) => Number(v).toLocaleString('ru-RU', { maximumFractionDigits: 0 });
function Big({ usd, rows, complete }: { usd: string | null | undefined; rows: { cur: string; v: string }[]; complete?: boolean }) {
  const nz = rows.filter((r) => num(r.v) !== 0);
  if (usd !== null && usd !== undefined) return <div className="big" title={`${money(usd)} UZS`}>{whole(usd)} <span className="text-sm font-normal muted" title={complete === false ? 'Не по всем валютам есть подтверждённый курс: в итог вошли только валюты с курсом' : undefined}>{complete === false ? 'UZS*' : 'UZS'}</span></div>;
  if (!nz.length) return <div className="big muted">—</div>;
  return <div className="space-y-0.5">{nz.slice(0, 3).map((r) => <div key={r.cur} className="big" style={{ fontSize: '1.25rem' }}>{money(r.v)} <span className="text-sm font-normal muted">{r.cur}</span></div>)}</div>;
}

function StatTile({ tone, title, icon, hint, active = true, children }: { tone: string; title: string; icon: IconName; hint?: string; active?: boolean; children: React.ReactNode }) {
  return (
    <div className={`stat ${tone} ${active ? '' : 'stat-off'}`}>
      <div className="flex items-center gap-2.5"><span className="stat-icon"><Icon name={icon} size={17} /></span><span className="text-sm" title={hint}>{title}</span></div>
      {children}
    </div>
  );
}

export default function DashboardPage() {
  const { me } = useSession();
  const [f, setF] = useState({ currency: '', project: '', executor: '', status: 'ACTIVE', from: '', to: '', horizon: '30' });
  const [supplier, setSupplier] = useState<{ id: string; name: string } | null>(null);
  const [display, setDisplay] = useState('AUTO'); // AUTO = USD-эквивалент, если курсы есть
  const [d, setD] = useState<any>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState(0); // телефон: какая из четырёх плиток показана
  const query = qs({ ...f, supplierId: supplier?.id });
  const activeFilters = [f.currency, supplier, f.project, f.executor, f.from, f.to].filter(Boolean).length + (f.status !== 'ACTIVE' ? 1 : 0);

  useEffect(() => {
    const t = setTimeout(() => api('GET', `/dashboard?${query}`).then((r) => { setD(r); setError(''); }).catch((e) => setError(e.message)), f.project || f.executor ? 300 : 0);
    return () => clearTimeout(t);
  }, [query, f.project, f.executor]);

  const present: string[] = useMemo(() => d?.kpi.byCurrency.map((c: any) => c.currency) ?? [], [d]);
  const mode = display === 'AUTO' ? (d?.rates.uzsComplete && present.length ? 'UZS_EQ' : (present.includes('UZS') ? 'UZS' : present[0] ?? 'UZS')) : display;
  const unit = mode === 'UZS_EQ' ? 'UZS (экв.)' : mode === 'USD_EQ' ? 'USD (экв.)' : mode;
  const rows = (arr: any[], k: string) => arr.map((c: any) => ({ cur: c.currency, v: c[k] }));
  const paidPct = d && d.rates.uzsComplete && num(d.kpi.totalUzs.amount) > 0 ? Math.min(100, Math.round((num(d.kpi.totalUzs.paid) / num(d.kpi.totalUzs.amount)) * 100)) : null;

  return (
    <div className="space-y-5 max-w-7xl">
      <section className="hero">
        {d?.plant && <div className="deco hidden sm:block" title={PLANT_RULE_TEXT}><Plant plant={d.plant} /></div>}
        <p className="muted text-sm">{new Date().toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</p>
        <h1>{greeting(me?.name || 'коллега')}</h1>
        <p className="muted mt-1 max-w-xl hidden sm:block">Главное по задолженности перед поставщиками: сколько должны, сколько уже оплачено и что требует внимания.</p>
        {d && <p className="text-sm mt-2 sm:mt-3"><b>{d.kpi.contracts}</b> <span className="muted">договоров</span> · <b>{d.kpi.suppliers}</b> <span className="muted">контрагентов</span></p>}
        {d?.plant && (
          <div className="mt-2 sm:mt-3 flex items-start gap-2 text-xs sm:text-sm max-w-xl" title={PLANT_RULE_TEXT}>
            <span className={`badge ${d.plant.mood === 'healthy' ? 'b-ok' : d.plant.mood === 'thirsty' ? 'b-warn' : 'b-err'}`}>{STAGE_NAME[d.plant.stage as PlantStage]} · {MOOD_NAME[d.plant.mood as PlantMood]}</span>
            <span className="muted">{d.plant.message}</span>
          </div>)}
      </section>
      {error && <p role="alert" className="b-err">{error}</p>}

      <details>
        <summary className="chip">Фильтры{activeFilters > 0 && <span className="badge b-ok" style={{ padding: '0 8px' }}>{activeFilters}</span>}</summary>
        <div className="panel p-3 mt-2 flex gap-2 flex-wrap items-center">
          <select className="input" value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })}><option value="">Все валюты</option>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</select>
          <SupplierPicker value={supplier} onChange={setSupplier} />
          <input className="input w-36" placeholder="Проект" value={f.project} onChange={(e) => setF({ ...f, project: e.target.value })} />
          <input className="input w-36" placeholder="Исполнитель" value={f.executor} onChange={(e) => setF({ ...f, executor: e.target.value })} />
          <select className="input" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="ACTIVE">Активные договоры</option><option value="ARCHIVED">Архивные</option><option value="ALL">Все</option></select>
          <label className="flex items-center gap-1 muted text-xs">период с<input className="input" type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></label>
          <label className="flex items-center gap-1 muted text-xs">по<input className="input" type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></label>
          <label className="flex items-center gap-1 muted text-xs">предстоящие, дней<select className="input" value={f.horizon} onChange={(e) => setF({ ...f, horizon: e.target.value })}>{['7', '14', '30', '60', '90', '365'].map((x) => <option key={x}>{x}</option>)}</select></label>
        </div>
      </details>

      {d?.rates.uzsNote && <div className="panel p-3" style={{ borderColor: 'var(--pending)' }}><b className="b-warn">Итоги в UZS неполные.</b> {d.rates.uzsNote} <Link className="underline" href="/fx">Курсы валют →</Link></div>}

      {!d ? <p className="muted">Загрузка…</p> : (<>
        <div className="md:hidden flex gap-1.5 overflow-x-auto" role="group" aria-label="Показатели">
          {TABS.map((t, i) => <button key={t} type="button" className={`chip ${tab === i ? 'chip-on' : ''}`} aria-pressed={tab === i} onClick={() => setTab(i)}>{t}</button>)}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
          <StatTile active={tab === 0} tone="t-rose" title="Текущая задолженность" icon="payments"><Big complete={d.rates.uzsComplete} usd={d.kpi.totalUzs.debt} rows={rows(d.kpi.byCurrency, 'debt')} /><span className="text-xs muted">Сколько ещё нужно оплатить</span></StatTile>
          <StatTile active={tab === 1} tone="t-green" title="Оплачено" icon="check" hint="остаток из файла + подтверждённые платежи"><Big complete={d.rates.uzsComplete} usd={d.kpi.totalUzs.paid} rows={rows(d.kpi.byCurrency, 'paid')} />
            {paidPct !== null ? <><div className="bar" aria-hidden="true"><i style={{ width: `${paidPct}%` }} /></div><span className="text-xs muted">{paidPct}% от суммы договоров</span></> : <span className="text-xs muted">Подтверждённые платежи и остаток из файла</span>}</StatTile>
          <StatTile active={tab === 2} tone="t-peach" title="Просрочено" icon="calendar" hint="невыполненный план прошедших недель, не больше долга"><Big complete={d.rates.uzsComplete} usd={d.overdue.totalUzs} rows={rows(d.overdue.byCurrency, 'amount')} /><span className="text-xs muted">{d.overdue.items.length ? `Обязательств: ${d.overdue.items.length}` : 'Просроченных нет'}</span></StatTile>
          <StatTile active={tab === 3} tone="t-lav" title={`Ближайшие платежи (${d.upcoming.horizonDays} дн.)`} icon="reports"><Big complete={d.rates.uzsComplete} usd={d.upcoming.totalUzs} rows={rows(d.upcoming.byCurrency, 'amount')} /><span className="text-xs muted">{d.upcoming.items.length ? `По плану: ${d.upcoming.items.length}` : 'На этот период плана нет'}</span></StatTile>
        </div>

        <div className="md:hidden"><Lists d={d} /></div>

        <div className="flex items-center gap-2 flex-wrap"><span className="muted text-sm">Графики показаны в:</span>
          <select className="input" value={display} onChange={(e) => setDisplay(e.target.value)}>
            <option value="AUTO">Авто</option>{d.rates.uzsComplete && <option value="UZS_EQ">UZS (эквивалент всех валют)</option>}{d.rates.usdComplete && <option value="USD_EQ">USD (эквивалент всех валют)</option>}{present.map((c) => <option key={c} value={c}>{c} (в исходной валюте)</option>)}
          </select><span className="muted text-xs">сейчас: {unit}</span></div>

        <div className="grid lg:grid-cols-2 gap-4">
          <DebtBySupplierChart d={d} mode={mode} unit={unit} />
          <div className="hidden md:block"><Lists d={d} /></div>
        </div>
        <PlanFactChart d={d} mode={mode} unit={unit} />

        <details className="panel p-4">
          <summary className="font-semibold">Подробный анализ</summary>
          <div className="space-y-4 mt-4">
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              <Money complete={d.rates.uzsComplete} title="Сумма договоров" tone="" usd={d.kpi.totalUzs.amount} rows={rows(d.kpi.byCurrency, 'amount')} />
              <Money complete={d.rates.uzsComplete} title="Плановые платежи" tone="b-info" hint="не уменьшают долг" usd={d.kpi.totalUzs.planned} rows={rows(d.kpi.byCurrency, 'planned')} />
              <Money complete={d.rates.uzsComplete} title="Переплаты" tone="b-info" usd={d.overpaid.totalUzs} rows={rows(d.overpaid.byCurrency, 'amount')} empty="нет" />
            </div>
            <div className="grid lg:grid-cols-2 gap-4">
              <SuppliersAmountChart d={d} mode={mode} unit={unit} />
              <DebtByCurrencyChart d={d} />
              <DynamicsChart d={d} mode={mode} unit={unit} />
            </div>
            <div><h3 className="text-sm font-semibold">Как считаются показатели</h3>
              <ul className="text-sm list-disc pl-5 mt-2 muted">{d.notes.map((n: string, i: number) => <li key={i}>{n}</li>)}
                <li>Использованные курсы (UZS за 1 ед.): {d.rates.used.length ? d.rates.used.map((u: any) => `${u.currency} ${u.uzsPerUnit} от ${u.effectiveDate}`).join('; ') : 'подтверждённых курсов нет'}</li></ul></div>
          </div>
        </details>
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
      {usd !== null && usd !== undefined ? <div className={`text-xl font-semibold ${tone}`}>{money(usd)} <span className={`text-xs font-normal ${complete === false ? 'b-warn' : 'muted'}`} title={complete === false ? 'Не по всем валютам есть подтверждённый курс: в итог вошли только валюты с курсом' : undefined}>{complete === false ? 'UZS, итог неполный' : 'UZS экв.'}</span></div> : <div className="text-sm muted">{nz.length ? 'UZS: нет курса' : (empty ?? '—')}</div>}
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
  return mode === 'UZS_EQ' ? (s.uzs ? num(s.uzs[k]) : null) : mode === 'USD_EQ' ? (s.usd ? num(s.usd[k]) : null) : num(s.byCurrency[mode]?.[k]);
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
  const data = d.kpi.byCurrency.map((c: any) => ({ name: c.currency, value: c.uzs ? num(c.uzs.debt) : 0, native: c.debt, has: !!c.uzs })).filter((x: any) => x.value > 0);
  const missing = d.kpi.byCurrency.filter((c: any) => !c.uzs && num(c.debt) > 0).map((c: any) => c.currency);
  return (
    <Panel title="Задолженность по валютам" note="Доля в эквиваленте UZS по подтверждённым курсам.">
      {data.length === 0 ? <p className="muted text-sm">Нужны подтверждённые курсы валют, чтобы сравнить валюты. <Link className="underline" href="/fx">Подтвердить курсы →</Link></p> : (
        <ResponsiveContainer width="100%" height={300}><PieChart>
          <Pie isAnimationActive={false} data={data} dataKey="value" nameKey="name" outerRadius={100} label={(p: any) => `${p.name} ${(p.percent * 100).toFixed(0)}%`}>{data.map((_: any, i: number) => <Cell key={i} fill={PIE[i % PIE.length]} />)}</Pie>
          <Tooltip {...tt('UZS экв.')} /><Legend /></PieChart></ResponsiveContainer>)}
      {missing.length > 0 && data.length > 0 && <p className="text-xs b-warn">Не показаны (нет курса): {missing.join(', ')}</p>}
    </Panel>
  );
}

function DebtBySupplierChart({ d, mode, unit }: any) {
  const data = d.charts.suppliers.map((s: any) => ({ name: s.name.replace(/\s+/g, ' ').slice(0, 26), debt: pick(s, 'debt', mode) })).filter((x: any) => x.debt !== null && x.debt > 0).sort((a: any, b: any) => b.debt - a.debt).slice(0, 7);
  return (
    <Panel title="Задолженность по контрагентам" note={`Топ-7, ${unit}.`}>
      {data.length === 0 ? <p className="muted text-sm">Долгов в выбранной валюте нет.</p> : (
        <ResponsiveContainer width="100%" height={300}><BarChart data={data} layout="vertical" margin={{ left: 16, right: 16 }}>
          <CartesianGrid stroke="var(--border)" horizontal={false} /><XAxis type="number" {...axis} tickFormatter={compact} /><YAxis type="category" dataKey="name" {...axis} width={150} />
          <Tooltip {...tt(unit)} /><Bar isAnimationActive={false} dataKey="debt" name="Долг" fill={C.debt} /></BarChart></ResponsiveContainer>)}
    </Panel>
  );
}

function PlanFactChart({ d, mode, unit }: any) {
  const data = d.charts.months.map((m: any) => {
    const v = mode === 'UZS_EQ' ? m.uzs : mode === 'USD_EQ' ? m.usd : m.byCurrency[mode];
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
  const data = d.charts.dynamics.map((p: any) => ({ date: p.date.slice(5), value: mode === 'UZS_EQ' ? (p.uzsComplete ? num(p.totalUzs) : null) : mode === 'USD_EQ' ? (p.usdComplete ? num(p.totalUsd) : null) : num(p.byCurrency[mode]) }));
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
  const item = (x: any, extra?: string) => (
    <li key={x.contractId + (x.year ?? '') + (x.week ?? '')} className="flex items-baseline justify-between gap-3 py-2 border-b last:border-b-0" style={{ borderColor: 'var(--border)' }}>
      <div className="min-w-0"><Link className="block truncate underline" href={`/contracts/${x.contractId}`}>{x.number ?? '—'}</Link><div className="text-xs muted truncate">{x.supplier.name}</div></div>
      <div className="text-right shrink-0"><div className="font-medium whitespace-nowrap tabular-nums">{money(x.amount)} {x.currency}</div>{extra !== undefined && <div className="text-xs muted whitespace-nowrap">{extra}</div>}</div>
    </li>);
  const list = (items: any[], empty: string, extra?: (x: any) => string) => items.length
    ? <ul>{items.slice(0, 5).map((x) => item(x, extra?.(x)))}</ul> : <p className="muted text-sm py-1">{empty}</p>;
  return (
    <Panel title="Требуют внимания">
      <div className="space-y-3">
        <div><h3 className="text-sm font-semibold b-err">Просрочено</h3>{list(d.overdue.items, 'Просроченных обязательств нет')}</div>
        <div><h3 className="text-sm font-semibold b-info">Ближайшие платежи</h3>{list(d.upcoming.items, 'На ближайшие недели плана нет', (x) => `${x.from.slice(5)}…${x.to.slice(5)}`)}</div>
        {d.overpaid.items.length > 0 && <div><h3 className="text-sm font-semibold b-info">Переплаты</h3>{list(d.overpaid.items, '')}</div>}
        <p className="text-xs"><Link className="underline" href="/calendar">Календарь платежей →</Link> · <Link className="underline" href="/reports">Отчёты →</Link></p>
      </div>
    </Panel>
  );
}
