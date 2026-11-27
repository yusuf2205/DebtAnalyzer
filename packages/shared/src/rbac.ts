export const ROLES = ['SUPER_ADMIN', 'ADMIN', 'FINANCE', 'MANAGER', 'VIEWER'] as const;
export type Role = (typeof ROLES)[number];
export const ROLE_LABELS: Record<Role, string> = { SUPER_ADMIN: 'Суперадмин', ADMIN: 'Администратор', FINANCE: 'Финансы', MANAGER: 'Менеджер', VIEWER: 'Просмотр' };

export const PERMISSIONS = [
  'dashboard.view', 'reports.view', 'reports.export',
  'suppliers.view', 'suppliers.manage', 'suppliers.merge',
  'contracts.view', 'contracts.manage', 'contracts.archive',
  'payments.view', 'payments.create', 'payments.approve', 'payments.reverse',
  'plans.view', 'plans.manage',
  'fx.view', 'fx.manage',
  'import.view', 'import.run', 'import.commit',
  'reconciliation.view', 'reconciliation.resolve',
  'users.view', 'users.manage',
  'audit.view', 'settings.manage', 'integrations.manage',
  'roles.manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Право, которое нельзя выдать настраиваемой роли: управление ролями принадлежит только SUPER_ADMIN. */
export const NON_ASSIGNABLE_PERMISSIONS: readonly Permission[] = ['roles.manage'];

const VIEW: Permission[] = [
  'dashboard.view', 'reports.view', 'reports.export', 'suppliers.view', 'contracts.view',
  'payments.view', 'plans.view', 'fx.view', 'import.view', 'reconciliation.view',
];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  SUPER_ADMIN: PERMISSIONS,
  // ADMIN управляет системой и пользователями, но не подтверждает платежи (разделение обязанностей) и не управляет ролями.
  ADMIN: PERMISSIONS.filter((p) => p !== 'payments.approve' && p !== 'payments.reverse' && p !== 'roles.manage'),
  FINANCE: [...VIEW, 'payments.create', 'payments.approve', 'payments.reverse', 'fx.manage', 'import.run', 'import.commit', 'reconciliation.resolve', 'plans.manage', 'audit.view'],
  MANAGER: [...VIEW, 'suppliers.manage', 'suppliers.merge', 'contracts.manage', 'contracts.archive', 'plans.manage', 'payments.create', 'import.run'],
  VIEWER: VIEW,
};

export function can(role: Role, perm: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(perm) ?? false;
}

/** Права по разделам для экрана настройки ролей: подписи на русском. */
export const PERMISSION_GROUPS: { key: string; title: string; items: { perm: Permission; label: string; hint?: string }[] }[] = [
  { key: 'dashboard', title: 'Dashboard и отчёты', items: [
    { perm: 'dashboard.view', label: 'Просмотр Dashboard' },
    { perm: 'reports.view', label: 'Просмотр отчётов' },
    { perm: 'reports.export', label: 'Выгрузка отчётов (Excel, CSV, PDF)' },
  ] },
  { key: 'suppliers', title: 'Контрагенты', items: [
    { perm: 'suppliers.view', label: 'Просмотр контрагентов' },
    { perm: 'suppliers.manage', label: 'Создание и изменение контрагентов' },
    { perm: 'suppliers.merge', label: 'Объединение дублей контрагентов' },
  ] },
  { key: 'contracts', title: 'Договоры', items: [
    { perm: 'contracts.view', label: 'Просмотр договоров' },
    { perm: 'contracts.manage', label: 'Создание и изменение договоров' },
    { perm: 'contracts.archive', label: 'Архивирование договоров' },
  ] },
  { key: 'payments', title: 'Платежи', items: [
    { perm: 'payments.view', label: 'Просмотр платежей' },
    { perm: 'payments.create', label: 'Создание платежей и передача на подтверждение' },
    { perm: 'payments.approve', label: 'Подтверждение и отклонение платежей', hint: 'Подтверждённый платёж меняет задолженность' },
    { perm: 'payments.reverse', label: 'Сторно подтверждённых платежей' },
  ] },
  { key: 'plans', title: 'Календарь платежей', items: [
    { perm: 'plans.view', label: 'Просмотр календаря' },
    { perm: 'plans.manage', label: 'Планирование, перенос и разделение платежей' },
  ] },
  { key: 'fx', title: 'Курсы валют', items: [
    { perm: 'fx.view', label: 'Просмотр курсов' },
    { perm: 'fx.manage', label: 'Ввод и подтверждение курсов', hint: 'Курсы определяют итоги в USD' },
  ] },
  { key: 'import', title: 'Импорт и Google Sheets', items: [
    { perm: 'import.view', label: 'Просмотр импортов' },
    { perm: 'import.run', label: 'Загрузка и анализ файлов' },
    { perm: 'import.commit', label: 'Сохранение импорта в базу', hint: 'Создаёт и меняет договоры' },
  ] },
  { key: 'reconciliation', title: 'Сверка', items: [
    { perm: 'reconciliation.view', label: 'Просмотр сверки' },
    { perm: 'reconciliation.resolve', label: 'Подтверждение и отклонение сверки' },
  ] },
  { key: 'admin', title: 'Администрирование', items: [
    { perm: 'users.view', label: 'Просмотр пользователей' },
    { perm: 'users.manage', label: 'Управление пользователями', hint: 'Создание, отключение, сброс пароля' },
    { perm: 'audit.view', label: 'Журнал аудита' },
    { perm: 'settings.manage', label: 'Страница «Система» и настройки' },
    { perm: 'integrations.manage', label: 'Интеграции (Google)' },
  ] },
];

export const PERMISSION_LABEL: Record<string, string> = Object.fromEntries(PERMISSION_GROUPS.flatMap((g) => g.items.map((i) => [i.perm, i.label])));

/** Какие права обязательны для других: действие без права просмотра раздела бессмысленно (кнопки без данных). */
export const PERMISSION_REQUIRES: Partial<Record<Permission, readonly Permission[]>> = {
  'reports.export': ['reports.view'],
  'suppliers.manage': ['suppliers.view'], 'suppliers.merge': ['suppliers.view'],
  'contracts.manage': ['contracts.view'], 'contracts.archive': ['contracts.view'],
  'payments.create': ['payments.view'], 'payments.approve': ['payments.view'], 'payments.reverse': ['payments.view'],
  'plans.manage': ['plans.view'], 'fx.manage': ['fx.view'],
  'import.run': ['import.view'], 'import.commit': ['import.view'],
  'reconciliation.resolve': ['reconciliation.view'], 'users.manage': ['users.view'],
};

/** Право вместе со всем, что оно требует (транзитивно). */
export function withRequirements(perms: readonly Permission[]): Permission[] {
  const out = new Set<Permission>(perms);
  for (const p of perms) for (const r of PERMISSION_REQUIRES[p] ?? []) out.add(r);
  return PERMISSIONS.filter((p) => out.has(p));
}

/** Проверка набора прав настраиваемой роли. Возвращает список ошибок (пусто — набор допустим). */
export function validateRolePermissions(perms: readonly string[]): string[] {
  const errors: string[] = [];
  const known = new Set<string>(PERMISSIONS);
  const unknown = perms.filter((p) => !known.has(p));
  if (unknown.length) errors.push(`Неизвестные права: ${unknown.join(', ')}`);
  if (new Set(perms).size !== perms.length) errors.push('Права не должны повторяться');
  const banned = perms.filter((p) => (NON_ASSIGNABLE_PERMISSIONS as readonly string[]).includes(p));
  if (banned.length) errors.push('Право «Управление ролями» нельзя выдать настраиваемой роли — оно принадлежит только SUPER_ADMIN');
  if (!perms.length) errors.push('Отметьте хотя бы одно право');
  const have = new Set(perms);
  for (const p of perms) for (const r of PERMISSION_REQUIRES[p as Permission] ?? []) {
    if (!have.has(r)) errors.push(`«${PERMISSION_LABEL[p] ?? p}» требует права «${PERMISSION_LABEL[r] ?? r}»`);
  }
  return errors;
}
