import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, NotFoundException, Param, Patch, Post } from '@nestjs/common';
import { ROLES, type Role } from '@pf/shared';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { AuthService, checkPasswordPolicy } from '../auth/auth.service';
import { ClientIp, CurrentUser, RequirePermission } from '../auth/decorators';
import { parse } from '../common/zod';
import type { AuthUser } from '../common/types';
import { PrismaService } from '../prisma/prisma.service';

const roleEnum = z.enum(ROLES);
const select = { id: true, email: true, name: true, role: true, isActive: true, mustChangePassword: true, createdAt: true, lockedUntil: true } as const;

/** ADMIN не может создавать или изменять SUPER_ADMIN (защита от эскалации привилегий). */
function assertCanTouch(actor: AuthUser, targetRole: Role) {
  if (targetRole === 'SUPER_ADMIN' && actor.role !== 'SUPER_ADMIN') throw new ForbiddenException('Только SUPER_ADMIN может управлять учётными записями SUPER_ADMIN');
}

@Controller('users')
export class UsersController {
  constructor(private prisma: PrismaService, private audit: AuditService, private auth: AuthService) {}

  @Get()
  @RequirePermission('users.view')
  list() { return this.prisma.user.findMany({ select, orderBy: { createdAt: 'asc' } }); }

  @Post()
  @RequirePermission('users.manage')
  async create(@CurrentUser() actor: AuthUser, @Body() body: unknown, @ClientIp() ip: string | null) {
    const d = parse(z.object({ email: z.string().email().max(200), name: z.string().min(1).max(120), role: roleEnum, password: z.string().min(1).max(200) }), body);
    assertCanTouch(actor, d.role);
    checkPasswordPolicy(d.password);
    const email = d.email.toLowerCase();
    if (await this.prisma.user.findUnique({ where: { email } })) throw new ConflictException('Пользователь с таким email уже существует');
    const u = await this.prisma.user.create({ data: { email, name: d.name, role: d.role, passwordHash: await this.auth.hashPassword(d.password), mustChangePassword: true }, select });
    await this.audit.log({ userId: actor.id, userEmail: actor.email, action: 'user.create', entity: 'User', entityId: u.id, after: { email, role: d.role }, ip });
    return u;
  }

  @Patch(':id')
  @RequirePermission('users.manage')
  async update(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip: string | null) {
    const d = parse(z.object({ name: z.string().min(1).max(120).optional(), role: roleEnum.optional(), isActive: z.boolean().optional() }), body);
    const before = await this.prisma.user.findUnique({ where: { id }, select });
    if (!before) throw new NotFoundException('Пользователь не найден');
    assertCanTouch(actor, before.role as Role);
    if (d.role) assertCanTouch(actor, d.role);
    if (id === actor.id && (d.isActive === false || (d.role && d.role !== actor.role))) throw new BadRequestException('Нельзя отключить себя или изменить собственную роль');
    const u = await this.prisma.user.update({ where: { id }, data: d, select });
    if (d.isActive === false || d.role) await this.prisma.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
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
