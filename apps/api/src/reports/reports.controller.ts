import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { ClientIp, CurrentUser, RequirePermission } from '../auth/decorators';
import type { AuthUser } from '../common/types';
import { parse } from '../common/zod';
import { sendCsv, sendPdf, sendXlsx } from './exporters';
import { CATALOG } from './report-types';
import { reportQuery, ReportsService } from './reports.service';

@Controller('reports')
export class ReportsController {
  constructor(private svc: ReportsService, private audit: AuditService) {}

  @Get()
  @RequirePermission('reports.view')
  catalog() { return CATALOG; }

  @Get(':id')
  @RequirePermission('reports.view')
  async get(@Param('id') id: string, @Query() raw: Record<string, string>) {
    return this.svc.build(id, parse(reportQuery, raw));
  }

  @Get(':id/export')
  @RequirePermission('reports.export')
  async export(@Param('id') id: string, @Query() raw: Record<string, string>, @Res() res: Response, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) {
    const { format, ...rest } = parse(reportQuery.extend({ format: z.enum(['xlsx', 'csv', 'pdf']) }), raw);
    const report = await this.svc.build(id, rest);
    await this.audit.log({ userId: u.id, userEmail: u.email, action: 'export.report', entity: 'Report', entityId: id, meta: { format, filters: rest, rows: report.rows.length }, ip });
    if (format === 'csv') return sendCsv(res, report);
    if (format === 'pdf') return sendPdf(res, report);
    return sendXlsx(res, report);
  }
}
