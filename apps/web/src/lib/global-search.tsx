'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Permission } from '@pf/shared';
import { api, money } from './api';
import { Icon, type IconName } from './icons';
import { useSession } from './session';

export type NavItem = { href: string; label: string; perm: Permission; icon: IconName };
type Hit = { key: string; group: string; title: string; sub?: string; right?: string; href: string; icon: IconName };

/** Быстрый поиск (Ctrl+K или «/»): разделы, договоры и контрагенты; ↑↓ — выбор, Enter — открыть, Esc — закрыть. */
export function GlobalSearch({ nav, onClose }: { nav: NavItem[]; onClose: () => void }) {
  const router = useRouter();
  const { can } = useSession();
  const [q, setQ] = useState('');
  const [remote, setRemote] = useState<Hit[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const sections: Hit[] = useMemo(() => {
    const t = q.trim().toLowerCase();
    return nav.filter((n) => can(n.perm) && (!t || n.label.toLowerCase().includes(t))).slice(0, t ? 4 : 6)
      .map((n) => ({ key: `nav:${n.href}`, group: 'Разделы', title: n.label, href: n.href, icon: n.icon }));
  }, [nav, q, can]);

  useEffect(() => {
    const t = q.trim();
    if (t.length < 2) { setRemote([]); setLoading(false); return; }
    let alive = true;
    setLoading(true);
    const timer = setTimeout(async () => {
      const enc = encodeURIComponent(t);
      const [cs, ss] = await Promise.all([
        can('contracts.view') ? api<any>('GET', `/contracts?q=${enc}&pageSize=6&status=ALL`).catch(() => null) : null,
        can('suppliers.view') ? api<any>('GET', `/suppliers?q=${enc}&pageSize=5&status=ACTIVE`).catch(() => null) : null,
      ]);
      if (!alive) return;
      const hits: Hit[] = [
        ...(cs?.items ?? []).map((c: any): Hit => ({ key: `c:${c.id}`, group: 'Договоры', title: c.number ?? 'Без номера', sub: c.supplier?.name, right: Number(c.debt) ? `долг ${money(c.debt)} ${c.currency}` : c.currency, href: `/contracts/${c.id}`, icon: 'contracts' })),
        ...(ss?.items ?? []).map((s: any): Hit => ({ key: `s:${s.id}`, group: 'Контрагенты', title: s.name, sub: `договоров: ${s.contracts}`, href: `/suppliers/${s.id}`, icon: 'suppliers' })),
      ];
      setRemote(hits); setLoading(false);
    }, 200);
    return () => { alive = false; clearTimeout(timer); };
  }, [q, can]);

  const hits = [...remote, ...sections];
  useEffect(() => { setActive(0); }, [q, remote.length]);
  useEffect(() => { listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [active]);

  const go = (h: Hit) => { onClose(); router.push(h.href); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(hits.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === 'Enter' && hits[active]) { e.preventDefault(); go(hits[active]); }
  };

  let lastGroup = '';
  return (
    <div role="dialog" aria-modal="true" aria-label="Быстрый поиск" className="fixed inset-0 z-[60] flex items-start justify-center p-3 pt-[10vh]" style={{ background: 'rgba(20,24,18,.45)' }}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()} onKeyDown={onKey}>
      <div className="panel w-full max-w-xl overflow-hidden" style={{ boxShadow: 'var(--shadow-md)' }}>
        <div className="flex items-center gap-2 px-4 py-3 border-b" style={{ borderColor: 'var(--border)' }}>
          <Icon name="search" size={18} />
          <input ref={inputRef} className="flex-1 bg-transparent outline-none" style={{ color: 'var(--text)', font: 'inherit' }} placeholder="Номер договора, контрагент или раздел…" value={q} onChange={(e) => setQ(e.target.value)}
            role="combobox" aria-expanded="true" aria-controls="gs-list" aria-activedescendant={hits[active] ? `gs-${hits[active].key}` : undefined} aria-label="Поиск" />
          <kbd className="muted text-xs hidden sm:inline">Esc</kbd>
        </div>
        <ul id="gs-list" ref={listRef} role="listbox" className="max-h-[55vh] overflow-y-auto py-1">
          {hits.map((h, i) => {
            const head = h.group !== lastGroup; lastGroup = h.group;
            return (
              <li key={h.key} role="presentation">
                {head && <div className="px-4 pt-2 pb-1 muted text-xs font-medium uppercase tracking-wide">{h.group}</div>}
                <div id={`gs-${h.key}`} role="option" aria-selected={i === active} onMouseEnter={() => setActive(i)} onClick={() => go(h)}
                  className="flex items-center gap-3 px-4 py-2 cursor-pointer" style={i === active ? { background: 'var(--accent-soft)' } : undefined}>
                  <span className="muted shrink-0"><Icon name={h.icon} size={17} /></span>
                  <span className="min-w-0 flex-1"><span className="block truncate">{h.title}</span>{h.sub && <span className="block truncate text-xs muted">{h.sub}</span>}</span>
                  {h.right && <span className="text-xs muted shrink-0 tabular-nums">{h.right}</span>}
                </div>
              </li>);
          })}
          {hits.length === 0 && <li className="px-4 py-6 text-center muted text-sm">{q.trim().length < 2 ? 'Введите хотя бы 2 символа' : loading ? 'Ищу…' : 'Ничего не найдено'}</li>}
        </ul>
        <div className="px-4 py-2 border-t text-xs muted flex gap-4" style={{ borderColor: 'var(--border)' }}><span>↑↓ выбор</span><span>Enter — открыть</span><span className="ml-auto hidden sm:inline">Ctrl+K — открыть поиск</span></div>
      </div>
    </div>
  );
}
