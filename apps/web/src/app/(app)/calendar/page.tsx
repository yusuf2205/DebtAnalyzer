'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { api, money } from '@/lib/api';
import { useSession } from '@/lib/session';
import { CURRENCIES, Modal, compact, qs } from '@/lib/ui';

const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const num = (v: any) => Number(v ?? 0);

export default function Page() { return <Suspense fallback={<p className="muted">Загрузка…</p>}><Calendar /></Suspense>; }

function Calendar() {
  const { can } = useSession();
  const sp = useSearchParams();
  const now = new Date();
  const [view, setView] = useState<'cal' | 'month' | 'year'>('cal');
  const [days, setDays] = useState<any>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [year, setYear] = useState(Number(sp.get('year')) || now.getFullYear());
  const [month, setMonth] = useState(Number(sp.get('month')) || now.getMonth() + 1);
  const [f, setF] = useState({ currency: '', q: '', executor: '', contractId: sp.get('contractId') ?? '' });
  const [data, setData] = useState<any>(null);
  const [unplanned, setUnplanned] = useState<any>(null);
  const [settings, setSettings] = useState<any>(null);
  const [error, setError] = useState('');
  const [modal, setModal] = useState<any>(null);
  const manage = can('plans.manage');

  const query = qs({ ...f, year, ...(view !== 'year' ? { month } : {}) });
  const load = useCallback(() => {
    api('GET', `/calendar/${view === 'year' ? 'year' : 'month'}?${query}`).then(setData).catch((e) => setError(e.message));
    if (view === 'cal') api('GET', `/calendar/days?${qs({ ...f, year, month })}`).then(setDays).catch(() => {});
    api('GET', `/calendar/unplanned?${qs(f)}`).then(setUnplanned).catch(() => {});
  }, [view, query, f]);
  useEffect(() => { const t = setTimeout(load, f.q || f.executor ? 250 : 0); return () => clearTimeout(t); }, [load, f.q, f.executor]);
  useEffect(() => { api('GET', '/calendar/settings').then(setSettings).catch(() => {}); }, []);

  const changeView = (v: 'cal' | 'month' | 'year') => { if ((v === 'year') !== (view === 'year')) setData(null); setView(v); };
  const shift = (d: number) => { if (view === 'year') return setYear(year + d); const m = month + d; if (m < 1) { setMonth(12); setYear(year - 1); } else if (m > 12) { setMonth(1); setYear(year + 1); } else setMonth(m); };
  const done = () => { setModal(null); load(); };

  return (
    <div className="space-y-4 max-w-7xl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div><h1 className="text-xl font-semibold">Календарь платежей</h1>
          <p className="muted">План платежей по неделям и сравнение с фактом. План — это намерение: он <b>не уменьшает долг</b>. Фактом считаются только подтверждённые платежи.</p></div>
        {manage && <button className="btn btn-primary" onClick={() => setModal({ type: 'add', year, month })}>Добавить план</button>}
      </div>
      {error && <p role="alert" className="b-err">{error}</p>}

      <div className="flex gap-2 flex-wrap items-center">
        <div className="flex gap-1"><button className={`btn ${view === 'cal' ? 'btn-primary' : ''}`} onClick={() => changeView('cal')}>Календарь</button><button className={`btn ${view === 'month' ? 'btn-primary' : ''}`} onClick={() => changeView('month')}>Таблица</button><button className={`btn ${view === 'year' ? 'btn-primary' : ''}`} onClick={() => changeView('year')}>Год</button></div>
        <button className="btn" onClick={() => shift(-1)} aria-label="Назад">←</button>
        <b className="min-w-36 text-center">{view !== 'year' ? `${MONTHS[month - 1]} ${year}` : year}</b>
        <button className="btn" onClick={() => shift(1)} aria-label="Вперёд">→</button>
        <button className="btn" onClick={() => { setYear(now.getFullYear()); setMonth(now.getMonth() + 1); }}>Сегодня</button>
        <select className="input" value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })}><option value="">Все валюты</option>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</select>
        <input className="input" placeholder="Поиск: договор, поставщик, проект…" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
        <input className="input w-40" placeholder="Исполнитель" value={f.executor} onChange={(e) => setF({ ...f, executor: e.target.value })} />
        {f.contractId && <button className="btn" onClick={() => setF({ ...f, contractId: '' })}>Сбросить фильтр по договору ✕</button>}
      </div>

      {view === 'cal' && data && data.weeks && <CalendarView year={year} month={month} data={data} days={days} selected={selected} onSelect={setSelected} manage={manage}
        onCell={(row: any, cell: any) => setModal({ type: 'cell', row, cell, year, month })} onAdd={(week: number) => setModal({ type: 'add', year, month, week })} />}
      {view === 'month' && data && data.weeks && <MonthView data={data} manage={manage} onCell={(row: any, cell: any) => setModal({ type: 'cell', row, cell, year, month })} />}
      {view === 'year' && data && data.months && <YearView data={data} onMonth={(m: number) => { setMonth(m); setData(null); setView('cal'); }} />}

      {unplanned?.totals?.length > 0 && (
        <section className="panel p-4 space-y-2">
          <h2 className="font-semibold">Долг без плана <span className="muted text-xs font-normal">— договоры с долгом, по которым нет плана на текущие и будущие недели</span></h2>
          <div className="flex gap-4 flex-wrap text-sm">{unplanned.totals.map((t: any) => <span key={t.currency}><b>{t.currency}</b>: {t.contracts} дог., долг <b className="b-err">{money(t.debt)}</b></span>)}</div>
          <details><summary className="cursor-pointer text-sm">Список (до 200)</summary>
            <div className="panel overflow-auto mt-2" style={{ maxHeight: '40vh' }}><table className="tbl"><thead><tr><th>Договор</th><th>Контрагент</th><th>Вал.</th><th className="num">Долг</th>{manage && <th></th>}</tr></thead>
              <tbody>{unplanned.items.map((i: any) => <tr key={i.contractId}><td><Link className="underline" href={`/contracts/${i.contractId}`}>{i.number}</Link></td><td>{i.supplier.name}</td><td>{i.currency}</td><td className="num b-err">{money(i.debt)}</td>
                {manage && <td><button className="btn" onClick={() => setModal({ type: 'add', year, month, contract: { id: i.contractId, number: i.number, currency: i.currency } })}>Запланировать</button></td>}</tr>)}</tbody></table></div></details>
        </section>)}

      {settings && <Bounds settings={settings} canEdit={can('settings.manage')} onSaved={(s: any) => { setSettings(s); load(); }} setError={setError} />}

      {modal?.type === 'cell' && <CellModal {...modal} manage={manage} onClose={() => setModal(null)} onDone={done} />}
      {modal?.type === 'add' && <AddModal {...modal} onClose={() => setModal(null)} onDone={done} />}
    </div>
  );
}

const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const pad = (n: number) => String(n).padStart(2, '0');
const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const RU_DATE = (iso: string) => { const t = new Date(`${iso}T00:00:00Z`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', weekday: 'long', timeZone: 'UTC' }); return t.charAt(0).toUpperCase() + t.slice(1); };
const KIND: Record<string, string> = { PAYMENT: 'Оплата', REFUND: 'Возврат', REVERSAL: 'Сторно' };

/** Календарная сетка месяца: факт (подтверждённые платежи) — по дням; план задан по неделям, поэтому показан на первом дне недели. */
function CalendarView({ year, month, data, days, selected, onSelect, manage, onCell, onAdd }: any) {
  const today = localToday();
  const first = new Date(Date.UTC(year, month - 1, 1));
  const lead = (first.getUTCDay() + 6) % 7;
  const dim = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const total = Math.ceil((lead + dim) / 7) * 7;
  const cells = Array.from({ length: total }, (_, i) => { const dt = new Date(Date.UTC(year, month - 1, 1 - lead + i)); return { iso: dt.toISOString().slice(0, 10), day: dt.getUTCDate(), inMonth: dt.getUTCMonth() === month - 1 }; });
  const payments: any[] = days?.payments ?? [];
  const paysBy = new Map<string, any[]>();
  for (const p of payments) paysBy.set(p.date, [...(paysBy.get(p.date) ?? []), p]);
  const weekOfDay = (day: number) => data.weeks.find((w: any) => day >= w.from && day <= w.to);
  const planOn = (c: { iso: string; day: number; inMonth: boolean }) => {
    if (!c.inMonth) return null;
    const wi = data.weeks.findIndex((w: any) => w.from === c.day);
    if (wi < 0) return null;
    const items = data.totals.map((t: any) => ({ cur: t.currency, w: t.weeks[wi] })).filter((x: any) => num(x.w?.planned) > 0 || num(x.w?.overdue) > 0);
    return { week: data.weeks[wi].week, items };
  };
  const sel = selected ?? (today.startsWith(`${year}-${pad(month)}`) ? today : null);
  const selDay = sel && sel.startsWith(`${year}-${pad(month)}`) ? Number(sel.slice(8)) : null;
  const selWeek = selDay ? weekOfDay(selDay) : null;
  const selPays = sel ? paysBy.get(sel) ?? [] : [];
  const selPlans = selWeek ? data.rows.map((r: any) => ({ r, c: r.cells.find((c: any) => c.week === selWeek.week) })).filter((x: any) => x.c && (x.c.planned || num(x.c.actual) !== 0)) : [];

  return (
    <div className="space-y-3">
      {data.totals.length > 0 && (
        <div className="flex gap-3 flex-wrap">
          {data.totals.map((t: any) => (
            <div key={t.currency} className="panel px-4 py-2 text-sm"><b>{t.currency}</b> · <span className="b-info">план {money(t.total.planned)}</span> · <span className="b-ok">факт {money(t.total.actual)}</span>
              {num(t.total.remaining) > 0 && <> · <span className="b-warn">остаток {money(t.total.remaining)}</span></>}</div>))}
        </div>)}
      <div className="panel overflow-hidden">
        <div className="cal-head">{WEEKDAYS.map((w) => <div key={w}>{w}</div>)}</div>
        <div className="cal-grid">
          {cells.map((c) => {
            const ps = paysBy.get(c.iso) ?? [];
            const byCur = new Map<string, number>();
            for (const p of ps) byCur.set(p.currency, (byCur.get(p.currency) ?? 0) + Number(p.amount));
            const pays = [...byCur];
            const plan = planOn(c);
            const late = plan?.items.some((x: any) => num(x.w?.overdue) > 0);
            return (
              <button key={c.iso} type="button" className={`cal-cell ${c.inMonth ? '' : 'out'} ${c.iso === today ? 'today' : ''}`} aria-pressed={c.iso === sel} onClick={() => onSelect(c.iso)}
                aria-label={`${RU_DATE(c.iso)}${ps.length ? `, платежей: ${ps.length}` : ''}${plan?.items.length ? ', есть план недели' : ''}`}>
                <span className="cal-day">{c.day}</span>
                {plan && <span className="cal-wk">W{plan.week}</span>}
                {pays.slice(0, 2).map(([cur, sum]) => <span key={cur} className={`cal-chip ${sum < 0 ? 'late' : 'paid'}`}>{sum > 0 ? '+' : ''}{compact(sum)} {cur}</span>)}
                {pays.length > 2 && <span className="cal-chip paid">+{pays.length - 2} вал.</span>}
                {plan?.items.slice(0, 2).map((x: any) => num(x.w.planned) > 0 && <span key={x.cur} className="cal-chip plan">план {compact(x.w.planned)} {x.cur}</span>)}
                {late && <span className="cal-chip late">просрочено</span>}
                <span className="cal-dots">{ps.length > 0 && <i style={{ background: 'var(--paid)' }} />}{plan && plan.items.length > 0 && <i style={{ background: 'var(--plan)' }} />}{late && <i style={{ background: 'var(--debt)' }} />}</span>
              </button>);
          })}
        </div>
      </div>
      <p className="muted text-xs flex gap-4 flex-wrap"><span><i className="inline-block w-2.5 h-2.5 rounded-full align-middle mr-1" style={{ background: 'var(--paid)' }} />факт — подтверждённые платежи в день оплаты</span>
        <span><i className="inline-block w-2.5 h-2.5 rounded-full align-middle mr-1" style={{ background: 'var(--plan)' }} />план — задан по неделям, показан на первом дне недели (W1–W4)</span>
        <span><i className="inline-block w-2.5 h-2.5 rounded-full align-middle mr-1" style={{ background: 'var(--debt)' }} />просрочено — невыполненный план прошедших недель</span></p>

      <section className="panel p-4 space-y-3" aria-live="polite">
        {!sel || !selDay ? <p className="muted">Выберите день в календаре, чтобы увидеть платежи и план недели.</p> : (<>
          <div className="flex items-center justify-between gap-2 flex-wrap"><h2 className="font-semibold">{RU_DATE(sel)}{selWeek ? <span className="muted font-normal"> · неделя W{selWeek.week} ({selWeek.from}–{selWeek.to})</span> : null}</h2>
            {manage && selWeek && <button className="btn" onClick={() => onAdd(selWeek.week)}>Добавить план на W{selWeek.week}</button>}</div>
          <div><h3 className="text-sm font-semibold b-ok">Платежи в этот день</h3>
            {selPays.length === 0 ? <p className="muted text-sm">Подтверждённых платежей нет.</p> : (
              <table className="tbl"><tbody>{selPays.map((p: any) => <tr key={p.id}><td><Link className="underline" href={`/contracts/${p.contractId}`}>{p.number ?? '—'}</Link><div className="text-xs muted">{p.supplier}</div></td><td className="text-xs muted">{KIND[p.kind] ?? p.kind}</td><td className={`num ${Number(p.amount) < 0 ? 'b-err' : 'b-ok'}`}>{money(p.amount)} {p.currency}</td></tr>)}</tbody></table>)}</div>
          <div><h3 className="text-sm font-semibold b-info">План недели W{selWeek?.week}</h3>
            {selPlans.length === 0 ? <p className="muted text-sm">На эту неделю плана и платежей нет.</p> : (
              <div className="overflow-x-auto"><table className="tbl"><thead><tr><th>Договор</th><th className="num">План</th><th className="num">Факт недели</th><th className="num">Остаток / просрочено</th>{manage && <th></th>}</tr></thead>
                <tbody>{selPlans.map(({ r, c }: any) => <tr key={r.contract.id}>
                  <td><Link className="underline" href={`/contracts/${r.contract.id}`}>{r.contract.number ?? '—'}</Link><div className="text-xs muted">{r.supplier.name}</div></td>
                  <td className="num b-info">{c.planned ? `${money(c.planned)} ${r.currency}` : '—'}</td><td className="num b-ok">{num(c.actual) ? `${money(c.actual)} ${r.currency}` : '—'}</td>
                  <td className={`num ${num(c.overdue) > 0 ? 'b-err' : num(c.remaining) > 0 ? 'b-warn' : 'muted'}`}>{num(c.overdue) > 0 ? `просрочено ${money(c.overdue)}` : num(c.remaining) > 0 ? money(c.remaining) : '—'}</td>
                  {manage && <td><button className="btn" onClick={() => onCell(r, c)}>{c.planId ? 'Изменить' : 'Запланировать'}</button></td>}</tr>)}</tbody></table></div>)}</div>
        </>)}
      </section>
    </div>
  );
}

function MonthView({ data, manage, onCell }: { data: any; manage: boolean; onCell: (row: any, cell: any) => void }) {
  return (
    <div className="space-y-3">
      {data.totals.length > 0 && (
        <div className="panel overflow-x-auto"><table className="tbl"><thead><tr><th>Итого по валюте</th>
          {data.weeks.map((w: any) => <th key={w.week} className="num">W{w.week} <span className="font-normal">({w.from}–{w.to}){w.past ? ' · прошла' : ''}</span></th>)}<th className="num">Месяц</th></tr></thead>
          <tbody>{data.totals.map((t: any) => (
            <tr key={t.currency}><td><b>{t.currency}</b><div className="text-xs muted">план / факт / остаток плана / сверх плана</div></td>
              {[...t.weeks, { ...t.total, total: true }].map((w: any, i: number) => (
                <td key={i} className="num text-xs align-top">
                  <div className="b-info">{money(w.planned)}</div><div className="b-ok">{money(w.actual)}</div>
                  <div className={num(w.remaining) ? (w.overdue && num(w.overdue) ? 'b-err' : 'b-warn') : 'muted'}>{money(w.remaining)}</div>
                  <div className={num(w.over) ? 'b-info' : 'muted'}>{money(w.over)}</div></td>))}</tr>))}</tbody></table></div>)}
      <p className="muted text-xs">Остаток плана — невыполненная часть по каждому договору и неделе. Просрочено — невыполненный план прошедших недель, но не больше текущего долга по договору (красным). {data.note}</p>
      <div className="panel overflow-auto" style={{ maxHeight: '60vh' }}>
        <table className="tbl"><thead><tr><th>Контрагент / договор</th><th>Вал.</th><th className="num">Долг</th>
          {data.weeks.map((w: any) => <th key={w.week} className="num">W{w.week} <span className="font-normal">{w.from}–{w.to}</span></th>)}<th className="num">План / факт</th></tr></thead>
          <tbody>{data.rows.map((r: any) => (
            <tr key={r.contract.id}>
              <td className="max-w-72"><Link className="underline" href={`/contracts/${r.contract.id}`}>{r.contract.number ?? '—'}</Link><div className="text-xs muted truncate">{r.supplier.name}</div>
                {r.planExceedsDebt && <div className="text-xs b-warn" title="Сумма плана по договору превышает остаток долга — возможно, это история платежей">план &gt; долга</div>}</td>
              <td>{r.currency}</td><td className="num b-err">{num(r.debt) ? money(r.debt) : '—'}</td>
              {r.cells.map((c: any) => (
                <td key={c.week} className="num align-top" style={{ minWidth: 110 }}>
                  <button className="w-full text-right" style={{ cursor: manage || c.planId ? 'pointer' : 'default' }} disabled={!manage && !c.planId} onClick={() => onCell(r, c)}
                    aria-label={`W${c.week}: ${c.planned ? (manage ? 'изменить план' : 'план задан') : (manage ? 'добавить план' : 'плана нет')}`}>
                    {c.planned ? <div className="b-info">{money(c.planned)}{c.source === 'IMPORT' && <span className="muted text-xs" title="из импортированной таблицы"> ⇩</span>}</div> : <div className="muted">{manage ? '＋' : '—'}</div>}
                    {num(c.actual) !== 0 && <div className="b-ok text-xs">факт {money(c.actual)}</div>}
                    {num(c.overdue) > 0 ? <div className="b-err text-xs">просрочено {money(c.overdue)}</div> : num(c.remaining) > 0 ? <div className="b-warn text-xs">остаток {money(c.remaining)}</div> : null}
                    {num(c.over) > 0 && <div className="text-xs b-info">сверх {money(c.over)}</div>}
                  </button></td>))}
              <td className="num text-xs"><div className="b-info">{money(r.plannedTotal)}</div><div className="b-ok">{money(r.actualTotal)}</div></td></tr>))}
            {data.rows.length === 0 && <tr><td colSpan={8} className="muted">В этом месяце нет плана и фактических платежей{manage ? ' — нажмите «Добавить план»' : ''}.</td></tr>}</tbody></table>
      </div>
    </div>
  );
}

function YearView({ data, onMonth }: { data: any; onMonth: (m: number) => void }) {
  return (
    <div className="space-y-3">
      <div className="panel overflow-auto"><table className="tbl"><thead><tr><th>Месяц</th><th>Валюта</th><th className="num">План</th><th className="num">Факт</th><th className="num">Остаток плана</th><th className="num">Сверх плана</th><th className="num">Просрочено</th></tr></thead>
        <tbody>{data.months.flatMap((m: any) => m.currencies.length === 0 ? [] : m.currencies.map((c: any, i: number) => (
          <tr key={`${m.month}${c.currency}`}><td>{i === 0 ? <button className="underline" onClick={() => onMonth(m.month)}>{MONTHS[m.month - 1]}</button> : ''}</td><td>{c.currency}</td>
            <td className="num b-info">{money(c.planned)}</td><td className="num b-ok">{money(c.actual)}</td><td className="num b-warn">{num(c.remaining) ? money(c.remaining) : '—'}</td>
            <td className="num b-info">{num(c.over) ? money(c.over) : '—'}</td><td className="num b-err">{num(c.overdue) ? money(c.overdue) : '—'}</td></tr>)))}
          {data.totals.length === 0 && <tr><td colSpan={7} className="muted">За этот год нет плана и платежей</td></tr>}
          {data.totals.map((t: any) => <tr key={`t${t.currency}`} style={{ fontWeight: 600 }}><td>Итого за год</td><td>{t.currency}</td><td className="num">{money(t.planned)}</td><td className="num">{money(t.actual)}</td><td className="num">{money(t.remaining)}</td><td className="num">{money(t.over)}</td><td></td></tr>)}</tbody></table></div>
    </div>
  );
}

function CellModal({ row, cell, year, month, manage, onClose, onDone }: any) {
  const [mode, setMode] = useState<'edit' | 'move' | 'split'>('edit');
  const [amount, setAmount] = useState(cell.planned ?? '');
  const [note, setNote] = useState(cell.note ?? '');
  const [to, setTo] = useState({ year, month, week: cell.week === 4 ? 1 : cell.week + 1 });
  const nextOf = (w: number) => (w === 4 ? { year: month === 12 ? year + 1 : year, month: month === 12 ? 1 : month + 1, week: 1 } : { year, month, week: w + 1 });
  const [parts, setParts] = useState(() => { const half = (Number(cell.planned ?? 0) / 2).toFixed(2); const n = nextOf(cell.week); return [{ year, month, week: cell.week, amount: half }, { ...n, amount: (Number(cell.planned ?? 0) - Number(half)).toFixed(2) }]; });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<any>) => { setBusy(true); setError(''); try { await fn(); onDone(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  const sum = parts.reduce((a, p) => a + Number(p.amount || 0), 0);
  const splitOk = Math.abs(sum - Number(cell.planned ?? 0)) < 0.005 && parts.every((p) => Number(p.amount) > 0);
  const cellSel = (v: any, set: (x: any) => void) => (
    <span className="flex gap-1"><input className="input w-20" type="number" value={v.year} onChange={(e) => set({ ...v, year: Number(e.target.value) })} aria-label="Год" />
      <select className="input" value={v.month} onChange={(e) => set({ ...v, month: Number(e.target.value) })} aria-label="Месяц">{MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</select>
      <select className="input" value={v.week} onChange={(e) => set({ ...v, week: Number(e.target.value) })} aria-label="Неделя">{[1, 2, 3, 4].map((w) => <option key={w} value={w}>W{w}</option>)}</select></span>);

  return (
    <Modal title={`${row.contract.number ?? 'Договор'} — ${MONTHS[month - 1]} ${year}, W${cell.week}`} onClose={onClose}>
      <p className="text-sm muted">{row.supplier.name} · {row.currency}{cell.planned ? ` · источник плана: ${cell.source === 'IMPORT' ? 'импорт' : 'вручную'}` : ''}</p>
      {num(cell.actual) !== 0 && <p className="text-sm b-ok">Факт за неделю: {money(cell.actual, row.currency)}</p>}
      {error && <p role="alert" className="b-err text-sm">{error}</p>}
      {!cell.planId ? (
        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); run(() => api('POST', '/calendar/plans', { contractId: row.contract.id, year, month, week: cell.week, amount, note: note || undefined })); }}>
          <label className="block space-y-1"><span className="muted text-xs">Плановая сумма, {row.currency}</span><input className="input w-full" required inputMode="decimal" pattern="\d+(\.\d{1,2})?" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus /></label>
          <label className="block space-y-1"><span className="muted text-xs">Комментарий</span><input className="input w-full" value={note} onChange={(e) => setNote(e.target.value)} /></label>
          <button className="btn btn-primary" disabled={busy || !manage}>Запланировать</button>
        </form>
      ) : (<>
        <div className="flex gap-1">{(['edit', 'move', 'split'] as const).map((m) => <button key={m} className={`btn ${mode === m ? 'btn-primary' : ''}`} onClick={() => setMode(m)}>{{ edit: 'Изменить', move: 'Перенести', split: 'Разделить' }[m]}</button>)}</div>
        {mode === 'edit' && (
          <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); run(() => api('PATCH', `/calendar/plans/${cell.planId}`, { amount, note: note || null })); }}>
            <label className="block space-y-1"><span className="muted text-xs">Плановая сумма, {row.currency}</span><input className="input w-full" required inputMode="decimal" pattern="\d+(\.\d{1,2})?" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
            <label className="block space-y-1"><span className="muted text-xs">Комментарий</span><input className="input w-full" value={note} onChange={(e) => setNote(e.target.value)} /></label>
            {cell.source === 'IMPORT' && <p className="text-xs muted">Запись пришла из таблицы. После правки она станет ручной и не будет перезаписана повторным импортом.</p>}
            <div className="flex gap-2"><button className="btn btn-primary" disabled={busy}>Сохранить</button>
              <button type="button" className="btn" disabled={busy} onClick={() => confirm('Удалить плановую запись?') && run(() => api('DELETE', `/calendar/plans/${cell.planId}`))}>Удалить</button></div>
          </form>)}
        {mode === 'move' && (
          <div className="space-y-2"><p className="text-sm">Перенести {money(cell.planned, row.currency)} на:</p>{cellSel(to, setTo)}
            <p className="text-xs muted">Если на той неделе по договору уже есть план, суммы сложатся.</p>
            <button className="btn btn-primary" disabled={busy || (to.year === year && to.month === month && to.week === cell.week)} onClick={() => run(() => api('POST', `/calendar/plans/${cell.planId}/move`, to))}>Перенести</button></div>)}
        {mode === 'split' && (
          <div className="space-y-2"><p className="text-sm">Разделить {money(cell.planned, row.currency)} между неделями:</p>
            {parts.map((p, i) => (<div key={i} className="flex gap-1 items-center flex-wrap">{cellSel(p, (v: any) => setParts(parts.map((x, j) => (j === i ? { ...x, ...v } : x))))}
              <input className="input w-28" inputMode="decimal" value={p.amount} onChange={(e) => setParts(parts.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} aria-label="Сумма части" />
              {parts.length > 2 && <button className="btn" onClick={() => setParts(parts.filter((_, j) => j !== i))} aria-label="Убрать часть">✕</button>}</div>))}
            <div className="flex gap-2 items-center flex-wrap"><button className="btn" disabled={parts.length >= 12} onClick={() => setParts([...parts, { ...nextOf(parts[parts.length - 1].week), amount: '0' }])}>＋ часть</button>
              <span className={`text-sm ${splitOk ? 'b-ok' : 'b-err'}`}>Сумма частей: {money(sum)} из {money(cell.planned)}</span></div>
            <button className="btn btn-primary" disabled={busy || !splitOk} onClick={() => run(() => api('POST', `/calendar/plans/${cell.planId}/split`, { parts }))}>Разделить</button></div>)}
      </>)}
    </Modal>
  );
}

function AddModal({ year, month, week, contract: preset, onClose, onDone }: any) {
  const [contract, setContract] = useState<any>(preset ?? null);
  const [search, setSearch] = useState('');
  const [found, setFound] = useState<any[]>([]);
  const [w, setW] = useState({ year, month, week: week ?? 1 });
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    if (search.trim().length < 2) { setFound([]); return; }
    const t = setTimeout(() => api('GET', `/contracts?q=${encodeURIComponent(search)}&status=ACTIVE&pageSize=8`).then((r) => setFound(r.items)).catch(() => {}), 200);
    return () => clearTimeout(t);
  }, [search]);
  return (
    <Modal title="Новый плановый платёж" onClose={onClose}>
      {error && <p role="alert" className="b-err text-sm">{error}</p>}
      {contract ? <div className="flex gap-2 items-center"><b>{contract.number}</b><span className="muted text-sm">{contract.currency}</span><button className="btn" onClick={() => setContract(null)}>Изменить</button></div> : (<>
        <input className="input w-full" placeholder="Договор: номер, поставщик…" value={search} onChange={(e) => setSearch(e.target.value)} autoFocus />
        <ul>{found.map((c) => <li key={c.id}><button className="underline py-1 text-left" onClick={() => setContract({ id: c.id, number: c.number, currency: c.currency })}>{c.number} — {c.supplier.name} ({c.currency}, долг {money(c.debt)})</button></li>)}</ul></>)}
      <div className="flex gap-1 flex-wrap items-center">
        <input className="input w-20" type="number" value={w.year} onChange={(e) => setW({ ...w, year: Number(e.target.value) })} aria-label="Год" />
        <select className="input" value={w.month} onChange={(e) => setW({ ...w, month: Number(e.target.value) })} aria-label="Месяц">{MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</select>
        <select className="input" value={w.week} onChange={(e) => setW({ ...w, week: Number(e.target.value) })} aria-label="Неделя">{[1, 2, 3, 4].map((x) => <option key={x} value={x}>W{x}</option>)}</select>
      </div>
      <input className="input w-full" placeholder={`Сумма${contract ? `, ${contract.currency}` : ''}`} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
      <input className="input w-full" placeholder="Комментарий (необязательно)" value={note} onChange={(e) => setNote(e.target.value)} />
      <button className="btn btn-primary" disabled={!contract || !/^\d+(\.\d{1,2})?$/.test(amount) || Number(amount) <= 0}
        onClick={async () => { setError(''); try { await api('POST', '/calendar/plans', { contractId: contract.id, ...w, amount, note: note || undefined }); onDone(); } catch (e) { setError((e as Error).message); } }}>Запланировать</button>
    </Modal>
  );
}

function Bounds({ settings, canEdit, onSaved, setError }: any) {
  const [b, setB] = useState(settings.bounds);
  const [open, setOpen] = useState(false);
  return (
    <section className="panel p-4 space-y-2">
      <div className="flex justify-between items-center gap-2 flex-wrap"><h2 className="font-semibold">Границы недель</h2><button className="btn" onClick={() => setOpen(!open)}>{open ? 'Скрыть' : 'Показать'}</button></div>
      {open && (<>
        <p className="text-sm">W1: 1–{settings.bounds.w1End} · W2: {settings.bounds.w1End + 1}–{settings.bounds.w2End} · W3: {settings.bounds.w2End + 1}–{settings.bounds.w3End} · W4: {settings.bounds.w3End + 1}–конец месяца{settings.isDefault ? ' (значения по умолчанию)' : ''}</p>
        <p className="muted text-xs">В исходной таблице у недель нет дат, поэтому границы задаёт организация. Они определяют, к какой неделе относится дата фактического платежа. Изменение пересчитывает отнесение фактов к неделям в календаре (суммы платежей и долги не меняются).</p>
        {canEdit ? (
          <form className="flex gap-2 items-end flex-wrap" onSubmit={async (e) => { e.preventDefault(); try { onSaved(await api('PUT', '/calendar/settings', b).then((r) => ({ ...r, note: settings.note }))); } catch (err) { setError((err as Error).message); } }}>
            {([['w1End', 'W1 до'], ['w2End', 'W2 до'], ['w3End', 'W3 до']] as const).map(([k, l]) => <label key={k} className="block space-y-1"><span className="muted text-xs">{l} (число месяца)</span><input className="input w-24" type="number" min={1} max={27} value={b[k]} onChange={(e) => setB({ ...b, [k]: Number(e.target.value) })} /></label>)}
            <button className="btn">Сохранить границы</button>
          </form>) : <p className="muted text-xs">Менять границы могут администраторы.</p>}
      </>)}
    </section>
  );
}
