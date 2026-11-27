import { BadRequestException, Body, ConflictException, Controller, Delete, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PERMISSIONS, ROLES, ROLE_LABELS, ROLE_PERMISSIONS, validateRolePermissions, type Role } from '@pf/shared';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { ClientIp, CurrentUser, RequirePermission } from '../auth/decorators';
import { parse } from '../common/zod';
import type { AuthUser } from '../common/types';
import { PrismaService } from '../prisma/prisma.service';

const RESERVED = new Set<string>([...ROLES, ...Object.values(ROLE_LABELS)].map((s) => s.toLowerCase()));
const bodySchema = z.object({
  name: z.string().trim().min(2, 'Название — не короче 2 символов').max(60, 'Название — не длиннее 60 символов'),
  description: z.string().trim().max(200).optional().nullable(),
  permissions: z.array(z.string().max(60)).max(PERMISSIONS.length + 5),
});

const diff = (before: string[], after: string[]) => ({ added: after.filter((p) => !before.includes(p)), removed: before.filter((p) => !after.includes(p)) });

/** Настраиваемые роли. Управлять ими может только SUPER_ADMIN (право roles.manage); список видят все, кто управляет пользователями. */
@Controller('roles')
export class RolesController {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  @Get()
  @RequirePermission('users.view')
  async list() {
    const custom = await this.prisma.customRole.findMany({ orderBy: { name: 'asc' }, include: { _count: { select: { users: true } } } });
    const overrides = new Map((await this.prisma.roleOverride.findMany()).map((o) => [o.role, o]));
    const counts = await this.prisma.user.groupBy({ by: ['role'], where: { customRoleId: null }, _count: true });
    return {
      builtin: ROLES.map((key) => {
        const o = key === 'SUPER_ADMIN' ? undefined : overrides.get(key);
        return {
          key, label: ROLE_LABELS[key], editable: key !== 'SUPER_ADMIN', customized: !!o,
          permissions: o ? PERMISSIONS.filter((p) => o.permissions.includes(p)) : ROLE_PERMISSIONS[key],
          defaults: ROLE_PERMISSIONS[key], userCount: counts.find((c) => c.role === key)?._count ?? 0,
        };
      }),
      custom: custom.map(({ _count, ...r }) => ({ ...r, userCount: _count.users })),
    };
  }

  private validate(body: unknown) {
    const d = parse(bodySchema, body);
    if (RESERVED.has(d.name.toLowerCase())) throw new BadRequestException('Это название занято встроенной ролью — выберите другое');
    const errors = validateRolePermissions(d.permissions);
    if (errors.length) throw new BadRequestException(errors.join('. '));
    return { name: d.name, description: d.description || null, permissions: PERMISSIONS.filter((p) => d.permissions.includes(p)) as string[] };
  }

  /** Уникальность без учёта регистра проверяется здесь: lower() в PostgreSQL с локалью C не понижает кириллицу (индекс в БД — страховка для латиницы). */
  private async assertNameFree(name: string, exceptId?: string) {
    const key = name.toLocaleLowerCase('ru');
    const all = await this.prisma.customRole.findMany({ select: { id: true, name: true } });
    if (all.some((r) => r.id !== exceptId && r.name.toLocaleLowerCase('ru') === key)) throw new ConflictException('Роль с таким названием уже существует');
  }

  private nameTaken(e: unknown): never {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException('Роль с таким названием уже существует');
    throw e;
  }

  @Post()
  @RequirePermission('roles.manage')
  async create(@CurrentUser() actor: AuthUser, @Body() body: unknown, @ClientIp() ip: string | null) {
    const d = this.validate(body);
    await this.assertNameFree(d.name);
    const r = await this.prisma.customRole.create({ data: { ...d, createdById: actor.id } }).catch((e) => this.nameTaken(e));
    await this.audit.log({ userId: actor.id, userEmail: actor.email, action: 'role.create', entity: 'CustomRole', entityId: r.id, after: { name: r.name, permissions: r.permissions }, ip });
    return { ...r, userCount: 0 };
  }

  @Patch(':id')
  @RequirePermission('roles.manage')
  async update(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @ClientIp() ip: string | null) {
    const before = await this.prisma.customRole.findUnique({ where: { id }, include: { _count: { select: { users: true } } } });
    if (!before) throw new NotFoundException('Роль не найдена');
    const d = this.validate(body);
    await this.assertNameFree(d.name, id);
    const r = await this.prisma.customRole.update({ where: { id }, data: d }).catch((e) => this.nameTaken(e));
    await this.audit.log({
      userId: actor.id, userEmail: actor.email, action: 'role.update', entity: 'CustomRole', entityId: id,
      before: { name: before.name, permissions: before.permissions }, after: { name: r.name, permissions: r.permissions },
      meta: { ...diff(before.permissions, r.permissions), affectedUsers: before._count.users }, ip,
    });
    return { ...r, userCount: before._count.users };
  }

  /** Права встроенной роли (кроме SUPER_ADMIN, он всегда имеет всё — иначе можно потерять доступ). */
  @Patch('builtin/:key')
  @RequirePermission('roles.manage')
  async updateBuiltin(@CurrentUser() actor: AuthUser, @Param('key') key: string, @Body() body: unknown, @ClientIp() ip: string | null) {
    const role = this.builtinKey(key);
    const d = parse(z.object({ permissions: bodySchema.shape.permissions }), body);
    const errors = validateRolePermissions(d.permissions);
    if (errors.length) throw new BadRequestException(errors.join('. '));
    const permissions = PERMISSIONS.filter((p) => d.permissions.includes(p)) as string[];
    const before = await this.prisma.roleOverride.findUnique({ where: { role } });
    const beforePerms = before?.permissions ?? [...ROLE_PERMISSIONS[role]];
    const r = await this.prisma.roleOverride.upsert({ where: { role }, create: { role, permissions, updatedById: actor.id }, update: { permissions, updatedById: actor.id } });
    await this.audit.log({ userId: actor.id, userEmail: actor.email, action: 'role.builtin_update', entity: 'RoleOverride', entityId: role, before: { permissions: beforePerms }, after: { permissions: r.permissions }, meta: diff(beforePerms, r.permissions), ip });
    return { key: role, permissions: r.permissions, customized: true };
  }

  /** Вернуть встроенной роли стандартные права. */
  @Delete('builtin/:key')
  @RequirePermission('roles.manage')
  async resetBuiltin(@CurrentUser() actor: AuthUser, @Param('key') key: string, @ClientIp() ip: string | null) {
    const role = this.builtinKey(key);
    const before = await this.prisma.roleOverride.findUnique({ where: { role } });
    if (before) {
      await this.prisma.roleOverride.delete({ where: { role } });
      await this.audit.log({ userId: actor.id, userEmail: actor.email, action: 'role.builtin_reset', entity: 'RoleOverride', entityId: role, before: { permissions: before.permissions }, after: { permissions: [...ROLE_PERMISSIONS[role]] }, meta: diff(before.permissions, [...ROLE_PERMISSIONS[role]]), ip });
    }
    return { key: role, permissions: ROLE_PERMISSIONS[role], customized: false };
  }

  private builtinKey(key: string): Role {
    if (!(ROLES as readonly string[]).includes(key)) throw new NotFoundException('Роль не найдена');
    if (key === 'SUPER_ADMIN') throw new BadRequestException('Права SUPER_ADMIN изменить нельзя: у него всегда есть всё, иначе можно потерять доступ к управлению');
    return key as Role;
  }

  @Delete(':id')
  @RequirePermission('roles.manage')
  async remove(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip: string | null) {
    const r = await this.prisma.customRole.findUnique({ where: { id }, include: { _count: { select: { users: true } } } });
    if (!r) throw new NotFoundException('Роль не найдена');
    if (r._count.users > 0) throw new ConflictException(`Роль назначена пользователям (${r._count.users}). Сначала назначьте им другую роль`);
    await this.prisma.customRole.delete({ where: { id } });
    await this.audit.log({ userId: actor.id, userEmail: actor.email, action: 'role.delete', entity: 'CustomRole', entityId: id, before: { name: r.name, permissions: r.permissions }, ip });
    return { ok: true };
  }
}
