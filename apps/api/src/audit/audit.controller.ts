import { Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import { RequirePermission } from '../auth/decorators';
import { parse } from '../common/zod';
import { PrismaService } from '../prisma/prisma.service';

@Controller('audit')
export class AuditController {
  constructor(private prisma: PrismaService) {}

  @Get()
  @RequirePermission('audit.view')
  async list(@Query() q: Record<string, string>) {
    const { entity, entityId, take, cursor } = parse(z.object({ entity: z.string().optional(), entityId: z.string().optional(), take: z.coerce.number().int().min(1).max(200).default(50), cursor: z.coerce.bigint().optional() }), q);
    const rows = await this.prisma.auditLog.findMany({
      where: { entity, entityId, ...(cursor ? { id: { lt: cursor } } : {}) }, orderBy: { id: 'desc' }, take,
    });
    return { items: rows.map((r) => ({ ...r, id: r.id.toString() })), next: rows.length === take ? rows[rows.length - 1].id.toString() : null };
  }
}
