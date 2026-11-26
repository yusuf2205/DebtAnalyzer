'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import type { Permission } from '@pf/shared';
import { useSession } from '@/lib/session';

// Только реально работающие разделы. Модули следующих этапов (Dashboard, Договоры, Платежи …) появятся в меню вместе с реализацией.
const NAV: { href: string; label: string; perm: Permission }[] = [
  { href: '/dashboard', label: 'Dashboard', perm: 'dashboard.view' },
  { href: '/suppliers', label: 'Контрагенты', perm: 'suppliers.view' },
  { href: '/contracts', label: 'Договоры', perm: 'contracts.view' },
  { href: '/payments', label: 'Платежи', perm: 'payments.view' },
  { href: '/calendar', label: 'Календарь платежей', perm: 'plans.view' },
  { href: '/reconciliation', label: 'Сверка', perm: 'reconciliation.view' },
  { href: '/reports', label: 'Отчёты', perm: 'reports.view' },
  { href: '/imports', label: 'Импорт', perm: 'import.view' },
  { href: '/google', label: 'Google Sheets', perm: 'import.view' },
  { href: '/fx', label: 'Курсы валют', perm: 'fx.view' },
  { href: '/users', label: 'Пользователи', perm: 'users.view' },
  { href: '/system', label: 'Система', perm: 'settings.manage' },
];

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
      <aside className="md:w-56 md:min-h-screen border-b md:border-b-0 md:border-r p-3 flex md:flex-col gap-1 items-center md:items-stretch overflow-x-auto" style={{ borderColor: 'var(--border)', background: 'var(--panel)' }}>
        <div className="font-semibold px-2 py-1 md:mb-3 whitespace-nowrap">Procurement Finance</div>
        {NAV.filter((n) => can(n.perm)).map((n) => (
          <Link key={n.href} href={n.href} className="px-2 py-1.5 rounded-md whitespace-nowrap" style={path.startsWith(n.href) ? { background: 'var(--border)', fontWeight: 600 } : undefined}>{n.label}</Link>
        ))}
        <div className="md:mt-auto flex md:flex-col gap-2 text-xs muted px-2 ml-auto md:ml-0">
          <span className="whitespace-nowrap">{me.name} · {me.role}</span>
          <button className="btn" onClick={toggle}>{dark ? 'Светлая тема' : 'Тёмная тема'}</button>
          <button className="btn" onClick={logout}>Выйти</button>
        </div>
      </aside>
      <main className="flex-1 p-4 md:p-6 min-w-0">{children}</main>
    </div>
  );
}
