import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, NotFoundException, Param, Patch, Post } from '@nestjs/common';
import { ROLES, ROLE_PERMISSIONS, type Role } from '@pf/shared';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { AuthService, checkPasswordPolicy } from '../auth/auth.service';
import { ClientIp, CurrentUser, RequirePermission } from '../auth/decorators';
import { parse } from '../common/zod';
import type { AuthUser } from '../common/types';
import { PrismaService } from '../prisma/prisma.service';

const roleEnum = z.enum(ROLES);
const select = { id: true, email: true, name: true, role: true, customRoleId: true, customRole: { select: { id: true, name: true } }, isActive: true, mustChangePassword: true, createdAt: true, lockedUntil: true } as const;

/** ADMIN не может создавать или изменять SUPER_ADMIN (защита от эскалации привилегий). */
function assertCanTouch(actor: AuthUser, targetRole: Role) {
  if (targetRole === 'SUPER_ADMIN' && actor.role !== 'SUPER_ADMIN') throw new ForbiddenException('Только SUPER_ADMIN может управлять учётными записями SUPER_ADMIN');
}

@Controller('users')
export class UsersController {
  constructor(private prisma: PrismaService, private audit: AuditService, private auth: AuthService) {}

  /**
   * Роль для записи пользователя: встроенная (role) или настраиваемая (customRoleId) — одно из двух.
   * У пользователя с настраиваемой ролью поле role = VIEWER (запасное значение), действующие права берутся из роли.
   * Не-SUPER_ADMIN может назначить настраиваемую роль, только если все её права есть у него самого.
   */
  private async resolveRole(actor: AuthUser, d: { role?: Role; customRoleId?: string }) {
    if (d.role && d.customRoleId) throw new BadRequestException('Укажите одну роль: встроенную или настраиваемую');
    if (d.customRoleId) {
      const r = await this.prisma.customRole.findUnique({ where: { id: d.customRoleId } });
      if (!r) throw new BadRequestException('Такой роли не существует');
      if (actor.role !== 'SUPER_ADMIN') {
        const extra = r.permissions.filter((p) => !(actor.permissions as readonly string[]).includes(p));
        if (extra.length) throw new ForbiddenException('Нельзя назначить роль с правами, которых нет у вас');
      }
      return { role: 'VIEWER' as Role, customRoleId: r.id, key: `custom:${r.id}` };
    }
    if (!d.role) return null;
    assertCanTouch(actor, d.role);
    if (actor.role !== 'SUPER_ADMIN') {
      // Стандартные роли назначаются как раньше. Но SUPER_ADMIN мог добавить встроенной роли права сверх стандартных — их нельзя выдать, если их нет у вас.
      const std = ROLE_PERMISSIONS[d.role] as readonly string[];
      const extra = (await this.auth.rolePermissions(d.role)).filter((p) => !std.includes(p) && !(actor.permissions as readonly string[]).includes(p));
      if (extra.length) throw new ForbiddenException('Нельзя назначить роль с правами, которых нет у вас');
    }
    return { role: d.role, customRoleId: null as string | null, key: d.role };
  }

  @Get()
  @RequirePermission('users.view')
  list() { return this.prisma.user.findMany({ select, orderBy: { createdAt: 'asc' } }); }

  @Post()
  @RequirePermission('users.manage')
  async create(@CurrentUser() actor: AuthUser, @Body() body: unknown, @ClientIp() ip: string | null) {
    const d = parse(z.object({ email: z.string().email().max(200), name: z.string().min(1).max(120), role: roleEnum.optional(), customRoleId: z.string().uuid().optional(), password: z.string().min(1).max(200) }), body);
    const r = await this.resolveRole(actor, d);
    if (!r) throw new BadRequestException('Выберите роль');
    checkPasswordPolicy(d.password);
    const email = d.email.toLowerCase();
    if (await this.prisma.user.findUnique({ where: { email } })) throw new ConflictException('Пользователь с таким email уже существует');
    const u = await this.prisma.user.create({ data: { email, name: d.name, role: r.role, customRoleId: r.customRoleId, passwordHash: await this.auth.hashPassword(d.password), mustChangePassword: true }, select });
    await this.audit.log({ userId: actor.id, userEmail: actor.email, action: 'user.create', entity: 'User', entityId: u.id, after: { email, role: u.customRole ? `custom:${u.customRole.name}` : u.role }, ip });
    return u;
  }

  @Patch(':id')
  @RequirePermission('users.manage')
  async update(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip: string | null) {
    const d = parse(z.object({ name: z.string().min(1).max(120).optional(), role: roleEnum.optional(), customRoleId: z.string().uuid().optional(), isActive: z.boolean().optional() }), body);
    const before = await this.prisma.user.findUnique({ where: { id }, select });
    if (!before) throw new NotFoundException('Пользователь не найден');
    assertCanTouch(actor, before.role as Role);
    const r = await this.resolveRole(actor, d);
    const currentKey = before.customRoleId ? `custom:${before.customRoleId}` : before.role;
    if (id === actor.id && (d.isActive === false || (r && r.key !== currentKey))) throw new BadRequestException('Нельзя отключить себя или изменить собственную роль');
    const data: Record<string, unknown> = {};
    if (d.name !== undefined) data.name = d.name;
    if (d.isActive !== undefined) data.isActive = d.isActive;
    if (r) { data.role = r.role; data.customRoleId = r.customRoleId; }
    const u = await this.prisma.user.update({ where: { id }, data, select });
    if (d.isActive === false || (r && r.key !== currentKey)) await this.prisma.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    await this.audit.log({ userId: actor.id, userEmail: actor.email, action: 'user.update', entity: 'User', entityId: id, before, after: u, ip });
    return u;
  }

  @Post(':id/reset-password')
  @RequirePermission('users.manage')
  async reset(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip: string | null) {
    const { password } = parse(z.object({ password: z.string().min(1).max(200) }), body);
    checkPasswordPolicy(password);
    const t = await this.prisma.user.findUnique({ where: { id } });
    if (!t) throw new NotFoundException('Пользователь не найден');
    assertCanTouch(actor, t.role as Role);
    await this.prisma.user.update({ where: { id }, data: { passwordHash: await this.auth.hashPassword(password), mustChangePassword: true, failedLogins: 0, lockedUntil: null } });
    await this.prisma.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    await this.audit.log({ userId: actor.id, userEmail: actor.email, action: 'user.reset_password', entity: 'User', entityId: id, ip });
    return { ok: true };
  }
}
