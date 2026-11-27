'use client';
import { useEffect, useRef, useState } from 'react';

export type Col = { key: string; label: string; fixed?: boolean };

/** Видимые столбцы таблицы: выбор запоминается в браузере для каждого списка. Столбцы с fixed скрыть нельзя. */
export function useColumns(storeKey: string, cols: Col[]) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  useEffect(() => {
    try { const v = JSON.parse(localStorage.getItem(`pf-cols-${storeKey}`) ?? '[]'); if (Array.isArray(v)) setHidden(new Set(v.filter((k) => cols.some((c) => c.key === k && !c.fixed)))); } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeKey]);
  const save = (n: Set<string>) => { setHidden(n); try { localStorage.setItem(`pf-cols-${storeKey}`, JSON.stringify([...n])); } catch {} };
  return {
    show: (k: string) => !hidden.has(k),
    shown: cols.length - hidden.size,
    toggle: (k: string) => { const n = new Set(hidden); if (n.has(k)) n.delete(k); else n.add(k); save(n); },
    reset: () => save(new Set()),
    hiddenCount: hidden.size,
  };
}

function useClickAway(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('mousedown', down); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, [open, close]);
  return ref;
}

/** Меню «Столбцы»: флажки по столбцам и сброс. */
export function ColumnChooser({ cols, state }: { cols: Col[]; state: ReturnType<typeof useColumns> }) {
  const [open, setOpen] = useState(false);
  const ref = useClickAway(open, () => setOpen(false));
  return (
    <div className="relative" ref={ref}>
      <button type="button" className="chip" aria-expanded={open} aria-haspopup="true" onClick={() => setOpen(!open)}>Столбцы{state.hiddenCount > 0 && <span className="badge b-warn" style={{ padding: '0 8px' }}>−{state.hiddenCount}</span>}</button>
      {open && (
        <div className="panel absolute z-20 mt-1 p-3 space-y-1.5 min-w-52" style={{ boxShadow: 'var(--shadow-md)' }} role="group" aria-label="Видимые столбцы">
          {cols.map((c) => (
            <label key={c.key} className={`flex items-center gap-2 ${c.fixed ? 'muted' : 'cursor-pointer'}`}>
              <input type="checkbox" style={{ accentColor: 'var(--accent)' }} checked={c.fixed ? true : state.show(c.key)} disabled={c.fixed} onChange={() => state.toggle(c.key)} />{c.label}
            </label>))}
          {state.hiddenCount > 0 && <button type="button" className="text-xs underline" onClick={state.reset}>Показать все столбцы</button>}
        </div>)}
    </div>
  );
}

type View<T> = { name: string; value: T };

/** Сохранённые представления (наборы фильтров): хранятся в этом браузере; применяются одним нажатием. */
export function SavedViews<T extends Record<string, any>>({ storeKey, current, onApply }: { storeKey: string; current: T; onApply: (v: T) => void }) {
  const [views, setViews] = useState<View<T>[]>([]);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const ref = useClickAway(open, () => setOpen(false));
  useEffect(() => { try { const v = JSON.parse(localStorage.getItem(`pf-views-${storeKey}`) ?? '[]'); if (Array.isArray(v)) setViews(v); } catch {} }, [storeKey]);
  const save = (n: View<T>[]) => { setViews(n); try { localStorage.setItem(`pf-views-${storeKey}`, JSON.stringify(n)); } catch {} };
  const add = () => {
    const nm = name.trim().slice(0, 40);
    if (!nm) return;
    const { page: _p, ...value } = current as any;
    save([...views.filter((v) => v.name !== nm), { name: nm, value: value as T }]);
    setName('');
  };
  return (
    <div className="relative" ref={ref}>
      <button type="button" className="chip" aria-expanded={open} aria-haspopup="true" onClick={() => setOpen(!open)}>Представления{views.length > 0 && <span className="badge b-info" style={{ padding: '0 8px' }}>{views.length}</span>}</button>
      {open && (
        <div className="panel absolute z-20 mt-1 p-3 space-y-2 w-72 max-w-[85vw]" style={{ boxShadow: 'var(--shadow-md)' }} role="group" aria-label="Сохранённые представления">
          {views.length === 0 ? <p className="muted text-sm">Пока нет. Настройте фильтры и сохраните набор под именем.</p> : (
            <ul className="space-y-1">{views.map((v) => (
              <li key={v.name} className="flex items-center gap-1">
                <button type="button" className="flex-1 text-left truncate rounded-md px-2 py-1 hover:bg-[var(--panel-2)]" onClick={() => { onApply({ ...v.value, page: 1 } as T); setOpen(false); }}>{v.name}</button>
                <button type="button" className="muted px-2" aria-label={`Удалить представление ${v.name}`} onClick={() => save(views.filter((x) => x.name !== v.name))}>✕</button>
              </li>))}</ul>)}
          <form className="flex gap-1.5" onSubmit={(e) => { e.preventDefault(); add(); }}>
            <input className="input flex-1 min-w-0" style={{ padding: '4px 10px' }} placeholder="Имя представления" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} aria-label="Имя нового представления" />
            <button className="btn" style={{ padding: '4px 10px' }} disabled={!name.trim()}>Сохранить</button>
          </form>
          <p className="muted text-xs">Сохраняются текущие фильтры и сортировка. Представления видны только в этом браузере.</p>
        </div>)}
    </div>
  );
}
