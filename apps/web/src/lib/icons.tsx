export type IconName = 'dashboard' | 'suppliers' | 'contracts' | 'payments' | 'calendar' | 'check' | 'reports' | 'import' | 'sheet' | 'fx' | 'users' | 'system' | 'key' | 'shield' | 'moon' | 'sun' | 'logout' | 'logo';

const PATHS: Record<IconName, string> = {
  dashboard: 'M4 4h6v8H4z M14 4h6v5h-6z M14 13h6v7h-6z M4 16h6v4H4z',
  suppliers: 'M3 21h18 M5 21V8l7-5 7 5v13 M9 10h.01 M9 14h.01 M15 10h.01 M15 14h.01 M10 21v-3h4v3',
  contracts: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z M14 3v5h5 M9 13h6 M9 17h6',
  payments: 'M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M3 10h18 M7 15h3',
  calendar: 'M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z M3 10h18 M8 3v4 M16 3v4',
  check: 'M20 6 9 17l-5-5',
  reports: 'M4 20V10 M10 20V4 M16 20v-8 M22 20H2',
  import: 'M12 16V4 M7 9l5-5 5 5 M4 20h16',
  sheet: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z M3 9h18 M3 15h18 M9 3v18',
  fx: 'M7 4 3 8l4 4 M3 8h14 M17 20l4-4-4-4 M21 16H7',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M22 21v-2a4 4 0 0 0-3-3.9 M16 3.1a4 4 0 0 1 0 7.8',
  system: 'M22 12h-4l-3 9L9 3l-3 9H2',
  key: 'M15.5 7.5a4 4 0 1 1-5.2 5.2L3 20v-3l2-2h3v-3l2.3-2.3 M17 7h.01',
  shield: 'M12 3l8 3v6c0 4.5-3.2 8.2-8 9-4.8-.8-8-4.5-8-9V6z M9 12l2 2 4-4',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M12 2v2 M12 20v2 M4.9 4.9l1.4 1.4 M17.7 17.7l1.4 1.4 M2 12h2 M20 12h2 M4.9 19.1l1.4-1.4 M17.7 6.3l1.4-1.4',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4 M16 17l5-5-5-5 M21 12H9',
  logo: 'M4 19V9 M10 19V5 M16 19v-7 M22 19H2 M3 7l6-4 5 4 7-4',
};

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      {PATHS[name].split(' M').map((d, i) => <path key={i} d={(i ? 'M' : '') + d} />)}
    </svg>
  );
}
