'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import type { Permission } from '@pf/shared';
import { Icon, type IconName } from '@/lib/icons';
import { useSession } from '@/lib/session';

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
  { href: '/system', label: 'Система', perm: 'settings.manage', icon: 'system' },
];

const ROLE_LABEL: Record<string, string> = { SUPER_ADMIN: 'Администратор', ADMIN: 'Администратор', MANAGER: 'Менеджер', FINANCE: 'Финансы', VIEWER: 'Наблюдатель' };
const initials = (name: string) => name.split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map((s) => s[0]!.toUpperCase()).join('') || '?';

export default function AppLayout({ children }: { children: ReactNode }) {
  const { me, loading, can, logout } = useSession();
  const path = usePathname();
  const [dark, setDark] = useState(false);
  useEffect(() => { try { setDark(localStorage.getItem('pf-theme') === 'dark'); } catch {} }, []);
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    document.documentElement.classList.toggle('light', !dark && localStorage.getItem('pf-theme') === 'light');
  }, [dark]);
  const toggle = () => { const n = !dark; setDark(n); try { localStorage.setItem('pf-theme', n ? 'dark' : 'light'); } catch {} };

  if (loading) return <div className="p-8 muted">Загрузка…</div>;
  if (!me) return null;
  return (
    <div className="min-h-screen md:flex">
      <aside className="md:w-64 md:h-screen md:sticky md:top-0 md:shrink-0 border-b md:border-b-0 md:border-r p-3 md:p-4 flex md:flex-col gap-1 items-center md:items-stretch overflow-x-auto md:overflow-y-auto" style={{ borderColor: 'var(--border)', background: 'var(--panel)' }}>
        <Link href="/dashboard" className="flex items-center gap-2.5 px-1 py-1 md:mb-4 whitespace-nowrap" style={{ color: 'var(--text)', textDecoration: 'none' }}>
          <span className="brand-mark"><Icon name="logo" size={18} /></span>
          <span className="leading-tight"><span className="block font-semibold tracking-tight">Procurement</span><span className="block text-xs muted -mt-0.5">Finance</span></span>
        </Link>
        <nav className="flex md:flex-col gap-1 md:flex-1" aria-label="Разделы">
          {NAV.filter((n) => can(n.perm)).map((n) => (
            <Link key={n.href} href={n.href} className="nav-link" aria-current={path.startsWith(n.href) ? 'page' : undefined}>
              <Icon name={n.icon} /><span>{n.label}</span>
            </Link>
          ))}
        </nav>
        <div className="md:mt-3 md:pt-3 md:border-t flex md:flex-col gap-2 items-center md:items-stretch ml-auto md:ml-0 shrink-0" style={{ borderColor: 'var(--border)' }}>
          <div className="hidden md:flex items-center gap-2.5 px-1">
            <span className="avatar" aria-hidden="true">{initials(me.name || me.email)}</span>
            <span className="min-w-0 leading-tight"><span className="block text-sm font-semibold truncate">{me.name}</span><span className="block text-xs muted">{ROLE_LABEL[me.role] ?? me.role}</span></span>
          </div>
          <span className="md:hidden text-xs muted whitespace-nowrap">{me.name} · {me.role}</span>
          <Link href="/change-password" className="btn whitespace-nowrap"><Icon name="key" size={16} />Сменить пароль</Link>
          <button className="btn whitespace-nowrap" onClick={toggle}><Icon name={dark ? 'sun' : 'moon'} size={16} />{dark ? 'Светлая тема' : 'Тёмная тема'}</button>
          <button className="btn whitespace-nowrap" onClick={logout}><Icon name="logout" size={16} />Выйти</button>
        </div>
      </aside>
      <main className="flex-1 p-4 md:p-8 min-w-0 max-w-[1600px]">{children}</main>
    </div>
  );
}
