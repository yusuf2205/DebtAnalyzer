import { BadRequestException, Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { ClientIp, CurrentUser, RequirePermission } from '../auth/decorators';
import { parse } from '../common/zod';
import type { AuthUser } from '../common/types';
import { PrismaService } from '../prisma/prisma.service';

const cur = z.enum(['USD', 'UZS', 'RUB', 'EUR']);

/** Курсы: UZS за 1 единицу. Исторические записи неизменяемы — меняется только статус кандидата, значения не правятся. */
@Controller('fx')
export class FxController {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  @Get('rates') @RequirePermission('fx.view')
  list(@Query('status') raw?: string) {
    const status = raw === undefined ? undefined : parse(z.enum(['PENDING_CONFIRMATION', 'CONFIRMED', 'REJECTED']), raw);
    return this.prisma.fxRate.findMany({ where: status ? { status } : {}, orderBy: [{ currency: 'asc' }, { effectiveDate: 'desc' }, { createdAt: 'desc' }] });
  }

  /** Ручная установка курса уполномоченным пользователем — сразу подтверждённая запись с автором и источником. */
  @Post('rates') @RequirePermission('fx.manage')
  async create(@CurrentUser() u: AuthUser, @Body() body: unknown, @ClientIp() ip: string | null) {
    const d = parse(z.object({ currency: cur.exclude(['UZS']), uzsPerUnit: z.string().regex(/^\d+(\.\d{1,8})?$/), effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), source: z.string().min(2).max(200) }), body);
    if (Number(d.uzsPerUnit) <= 0) throw new BadRequestException('Курс должен быть положительным');
    const r = await this.prisma.fxRate.create({ data: { currency: d.currency, uzsPerUnit: d.uzsPerUnit, effectiveDate: new Date(d.effectiveDate), source: `MANUAL:${d.source}`, status: 'CONFIRMED', setById: u.id, confirmedById: u.id, confirmedAt: new Date() } });
    await this.audit.log({ userId: u.id, userEmail: u.email, action: 'fx.create', entity: 'FxRate', entityId: r.id, after: r, ip });
    return r;
  }

  @Post('rates/:id/confirm') @RequirePermission('fx.manage')
  async confirm(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @ClientIp() ip: string | null) {
    const d = parse(z.object({ effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }), body ?? {});
    const r = await this.prisma.fxRate.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('Курс не найден');
    if (r.status !== 'PENDING_CONFIRMATION') throw new BadRequestException('Курс уже обработан');
    const effectiveDate = r.effectiveDate ?? (d.effectiveDate ? new Date(d.effectiveDate) : null);
    if (!effectiveDate) throw new BadRequestException('У курса нет даты действия — укажите effectiveDate');
    const upd = await this.prisma.fxRate.update({ where: { id }, data: { status: 'CONFIRMED', effectiveDate, confirmedById: u.id, confirmedAt: new Date() } });
    await this.audit.log({ userId: u.id, userEmail: u.email, action: 'fx.confirm', entity: 'FxRate', entityId: id, before: r, after: upd, ip });
    return upd;
  }

  @Post('rates/:id/reject') @RequirePermission('fx.manage')
  async reject(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip: string | null) {
    const r = await this.prisma.fxRate.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('Курс не найден');
    if (r.status !== 'PENDING_CONFIRMATION') throw new BadRequestException('Курс уже обработан');
    const upd = await this.prisma.fxRate.update({ where: { id }, data: { status: 'REJECTED', confirmedById: u.id, confirmedAt: new Date() } });
    await this.audit.log({ userId: u.id, userEmail: u.email, action: 'fx.reject', entity: 'FxRate', entityId: id, before: r, after: upd, ip });
    return upd;
  }
}
