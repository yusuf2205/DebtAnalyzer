import { describe, expect, it } from 'vitest';
import { PERMISSIONS, PERMISSION_GROUPS, PERMISSION_REQUIRES, ROLES, ROLE_LABELS, ROLE_PERMISSIONS, validateRolePermissions, withRequirements, type Permission } from '../src/rbac';

describe('каталог прав и встроенные роли', () => {
  it('каждое право есть в экране настройки ролей ровно один раз и имеет подпись', () => {
    const listed = PERMISSION_GROUPS.flatMap((g) => g.items.map((i) => i.perm));
    expect([...listed].sort()).toEqual([...PERMISSIONS].filter((p) => p !== 'roles.manage').sort()); // roles.manage не выдаётся настраиваемым ролям
    for (const g of PERMISSION_GROUPS) for (const i of g.items) expect(i.label.length).toBeGreaterThan(3);
  });

  it('roles.manage есть только у SUPER_ADMIN', () => {
    for (const r of ROLES) expect(ROLE_PERMISSIONS[r].includes('roles.manage'), r).toBe(r === 'SUPER_ADMIN');
  });

  it('встроенные роли согласованы с зависимостями прав, у каждой есть подпись', () => {
    for (const r of ROLES) {
      expect(ROLE_LABELS[r]).toBeTruthy();
      expect(validateRolePermissions(ROLE_PERMISSIONS[r].filter((p) => p !== 'roles.manage')), r).toEqual([]);
    }
  });

  it('зависимости ссылаются на существующие права и не образуют циклов', () => {
    for (const [p, reqs] of Object.entries(PERMISSION_REQUIRES)) {
      expect(PERMISSIONS).toContain(p);
      for (const r of reqs!) { expect(PERMISSIONS).toContain(r); expect(PERMISSION_REQUIRES[r as Permission] ?? []).not.toContain(p); }
    }
  });
});

describe('проверка набора прав настраиваемой роли', () => {
  it('допустимый набор — без ошибок', () => {
    expect(validateRolePermissions(['dashboard.view', 'payments.view', 'payments.create'])).toEqual([]);
  });
  it('пустой набор, неизвестное право, повтор, roles.manage', () => {
    expect(validateRolePermissions([]).join()).toMatch(/хотя бы одно/);
    expect(validateRolePermissions(['x.y']).join()).toMatch(/Неизвестные/);
    expect(validateRolePermissions(['dashboard.view', 'dashboard.view']).join()).toMatch(/повторяться/);
    expect(validateRolePermissions(['roles.manage']).join()).toMatch(/SUPER_ADMIN/);
  });
  it('действие без права просмотра раздела отклоняется с понятным текстом', () => {
    const e = validateRolePermissions(['payments.approve']);
    expect(e).toHaveLength(1); expect(e[0]).toMatch(/Подтверждение.*требует права.*Просмотр платежей/);
  });
  it('withRequirements добавляет недостающие права и сохраняет порядок каталога', () => {
    expect(withRequirements(['payments.approve', 'fx.manage'])).toEqual(['payments.view', 'payments.approve', 'fx.view', 'fx.manage']);
    expect(validateRolePermissions(withRequirements(['import.commit', 'users.manage']))).toEqual([]);
  });
});
