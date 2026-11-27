'use client';
import { useEffect, useRef, type ReactNode } from 'react';
import { Icon } from './icons';

/**
 * Общая оболочка краткой панели справа (договор, контрагент, платёж).
 * Не модальная на компьютере (список остаётся доступен), на телефоне — на весь экран с затемнением.
 * Esc и крестик закрывают; на широком экране основное содержимое сдвигается, чтобы панель не закрывала таблицу.
 */
export function PeekShell({ label, title, subtitle, onClose, focusKey, children }: { label: string; title: ReactNode; subtitle?: ReactNode; onClose: () => void; focusKey?: string; children: ReactNode }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    document.body.classList.add('peek-open');
    return () => { document.removeEventListener('keydown', onKey); document.body.classList.remove('peek-open'); };
  }, [onClose]);
  useEffect(() => { closeRef.current?.focus(); }, [focusKey]);
  return (
    <div className="peek-wrap">
      <div className="peek-backdrop md:hidden" onClick={onClose} aria-hidden="true" />
      <div role="dialog" aria-modal="false" aria-label={label} className="peek">
        <div className="flex items-start justify-between gap-3 p-4 pb-2">
          <div className="min-w-0">
            <h2 className="font-semibold text-lg leading-snug break-words">{title}</h2>
            {subtitle && <p className="muted text-sm">{subtitle}</p>}
          </div>
          <button ref={closeRef} className="btn shrink-0" style={{ padding: '7px 10px' }} onClick={onClose} aria-label="Закрыть панель"><Icon name="close" size={18} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Tile({ label, value, unit, tone }: { label: string; value: string; unit?: string; tone?: string }) {
  return <div className="panel px-3 py-2"><div className="muted text-xs">{label}</div><div className={`font-semibold tabular-nums ${tone ?? ''}`}>{value} <span className="text-xs font-normal muted">{unit}</span></div></div>;
}
export function Row({ k, v }: { k: string; v?: string | null }) {
  return <div className="flex gap-2"><dt className="muted shrink-0">{k}:</dt><dd className="min-w-0 break-words whitespace-pre-line">{v || '—'}</dd></div>;
}
