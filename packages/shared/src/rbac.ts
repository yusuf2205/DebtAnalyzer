export const ROLES = ['SUPER_ADMIN', 'ADMIN', 'FINANCE', 'MANAGER', 'VIEWER'] as const;
export type Role = (typeof ROLES)[number];

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
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const VIEW: Permission[] = [
  'dashboard.view', 'reports.view', 'reports.export', 'suppliers.view', 'contracts.view',
  'payments.view', 'plans.view', 'fx.view', 'import.view', 'reconciliation.view',
];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  SUPER_ADMIN: PERMISSIONS,
  // ADMIN управляет системой и пользователями, но не подтверждает платежи (разделение обязанностей).
  ADMIN: PERMISSIONS.filter((p) => p !== 'payments.approve' && p !== 'payments.reverse'),
  FINANCE: [...VIEW, 'payments.create', 'payments.approve', 'payments.reverse', 'fx.manage', 'import.run', 'import.commit', 'reconciliation.resolve', 'plans.manage', 'audit.view'],
  MANAGER: [...VIEW, 'suppliers.manage', 'suppliers.merge', 'contracts.manage', 'contracts.archive', 'plans.manage', 'payments.create', 'import.run'],
  VIEWER: VIEW,
};

export function can(role: Role, perm: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(perm) ?? false;
}
