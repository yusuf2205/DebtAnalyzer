'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ROLE_LABELS, type Permission } from '@pf/shared';
import { Icon, type IconName } from '@/lib/icons';
import { useSession } from '@/lib/session';
import { labelTables } from '@/lib/table-cards';

// Только реально работающие разделы.
const NAV: { href: string; label: string; perm: Permission; icon: IconName }[] = [
  { href: '/dashboard', label: 'Dashboard', perm: 'dashboard.view', icon: 'dashboard' },
  { href: '/suppliers', label: 'Контрагенты', perm: 'suppliers.view', icon: 'suppliers' },
  { href: '/contracts', label: 'Договоры', perm: 'contracts.view', icon: 'contracts' },
  { href: '/payments', label: 'Платежи', perm: 'payments.view', icon: 'payments' },
  { href: '/calendar', label: 'Календарь платежей', perm: 'plans.view', icon: 'calendar' },
  { href: '/reconciliation', label: 'Сверка', perm: 'reconciliation.view', icon: 'check' },
  { href: '/reports', label: 'Отчёты', perm: 'reports.view', icon: 'reports' },
  { href: '/imports', label: 'Импорт', perm: 'import.view', icon: 'import' },
  { href: '/google', label: 'Google Sheets', perm: 'import.view', icon: 'sheet' },
  { href: '/fx', label: 'Курсы валют', perm: 'fx.view', icon: 'fx' },
  { href: '/users', label: 'Пользователи', perm: 'users.view', icon: 'users' },
  { href: '/roles', label: 'Роли и права', perm: 'roles.manage', icon: 'shield' },
  { href: '/system', label: 'Система', perm: 'settings.manage', icon: 'system' },
];

const initials = (name: string) => name.split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map((s) => s[0]!.toUpperCase()).join('') || '?';

function Brand() {
  return (
    <Link href="/dashboard" className="flex items-center gap-2.5 px-1 py-1 whitespace-nowrap" style={{ color: 'var(--text)', textDecoration: 'none' }}>
      <span className="brand-mark"><Icon name="logo" size={18} /></span>
      <span className="leading-tight"><span className="block font-semibold tracking-tight">Procurement</span><span className="block text-xs muted -mt-0.5">Finance</span></span>
    </Link>
  );
}

export default function AppLayout({ children }: { children: ReactNode }) {
  const { me, loading, can, logout } = useSession();
  const path = usePathname();
  const [dark, setDark] = useState(false);
  const [open, setOpen] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const openRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { try { setDark(localStorage.getItem('pf-theme') === 'dark'); } catch {} }, []);
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    document.documentElement.classList.toggle('light', !dark && localStorage.getItem('pf-theme') === 'light');
  }, [dark]);
  const toggle = () => { const n = !dark; setDark(n); try { localStorage.setItem('pf-theme', n ? 'dark' : 'light'); } catch {} };

  // Выдвижное меню (телефон): закрывается при переходе, по Esc и по тапу на затемнение; фон не прокручивается; фокус возвращается на кнопку.
  useEffect(() => { setOpen(false); }, [path]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onKey);
    closeRef.current?.focus();
    const opener = openRef.current;
    return () => { document.body.style.overflow = prev; document.removeEventListener('keydown', onKey); opener?.focus(); };
  }, [open]);

  // Подписи столбцов для карточного вида таблиц на телефоне; пересчитываются при любой смене содержимого страницы.
  useEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    let raf = 0;
    const run = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => labelTables(el)); };
    run();
    const mo = new MutationObserver(run);
    mo.observe(el, { childList: true, subtree: true });
    return () => { mo.disconnect(); cancelAnimationFrame(raf); };
  }, [loading, me]);

  if (loading) return <div className="p-8 muted">Загрузка…</div>;
  if (!me) return null;
  const roleName = me.customRole?.name ?? ROLE_LABELS[me.role] ?? me.role;
  const navLinks = NAV.filter((n) => can(n.perm)).map((n) => (
    <Link key={n.href} href={n.href} className="nav-link" aria-current={path.startsWith(n.href) ? 'page' : undefined}>
      <Icon name={n.icon} /><span>{n.label}</span>
    </Link>
  ));
  const account = (
    <>
      <div className="flex items-center gap-2.5 px-1">
        <span className="avatar" aria-hidden="true">{initials(me.name || me.email)}</span>
        <span className="min-w-0 leading-tight"><span className="block text-sm font-semibold truncate">{me.name}</span><span className="block text-xs muted">{roleName}</span></span>
      </div>
      <Link href="/change-password" className="btn whitespace-nowrap"><Icon name="key" size={16} />Сменить пароль</Link>
      <button className="btn whitespace-nowrap" onClick={toggle}><Icon name={dark ? 'sun' : 'moon'} size={16} />{dark ? 'Светлая тема' : 'Тёмная тема'}</button>
      <button className="btn whitespace-nowrap" onClick={logout}><Icon name="logout" size={16} />Выйти</button>
    </>
  );
  return (
    <div className="min-h-screen md:flex">
      {/* Телефон: верхняя панель с кнопкой меню */}
      <header className="md:hidden sticky top-0 z-30 flex items-center justify-between gap-2 px-3 py-2 border-b" style={{ borderColor: 'var(--border)', background: 'var(--panel)' }}>
        <Brand />
        <button ref={openRef} className="btn" style={{ padding: '7px 10px' }} onClick={() => setOpen(true)} aria-label="Открыть меню" aria-expanded={open} aria-controls="mobile-menu"><Icon name="menu" size={20} /></button>
      </header>

      {open && (
        <div className="md:hidden fixed inset-0 z-40" role="dialog" aria-modal="true" aria-label="Меню" id="mobile-menu">
          <div className="absolute inset-0 drawer-backdrop" onClick={() => setOpen(false)} aria-hidden="true" />
          <div className="drawer absolute left-0 top-0 bottom-0 w-[84%] max-w-80 flex flex-col gap-1 p-4 overflow-y-auto" style={{ background: 'var(--panel)', borderRight: '1px solid var(--border)', boxShadow: 'var(--shadow-md)' }}>
            <div className="flex items-center justify-between mb-3"><Brand /><button ref={closeRef} className="btn" style={{ padding: '7px 10px' }} onClick={() => setOpen(false)} aria-label="Закрыть меню"><Icon name="close" size={18} /></button></div>
            <nav className="flex flex-col gap-1 flex-1" aria-label="Разделы (меню)">{navLinks}</nav>
            <div className="mt-3 pt-3 border-t flex flex-col gap-2" style={{ borderColor: 'var(--border)' }}>{account}</div>
          </div>
        </div>)}

      {/* Компьютер: постоянная боковая панель */}
      <aside className="hidden md:flex md:w-64 md:h-screen md:sticky md:top-0 md:shrink-0 md:border-r p-4 flex-col gap-1 items-stretch overflow-y-auto" style={{ borderColor: 'var(--border)', background: 'var(--panel)' }}>
        <div className="mb-4"><Brand /></div>
        <nav className="flex flex-col gap-1 flex-1" aria-label="Разделы">{navLinks}</nav>
        <div className="mt-3 pt-3 border-t flex flex-col gap-2 items-stretch shrink-0" style={{ borderColor: 'var(--border)' }}>{account}</div>
      </aside>
      <main ref={mainRef} className="flex-1 p-4 md:p-8 min-w-0 max-w-[1600px]">{children}</main>
    </div>
  );
}
