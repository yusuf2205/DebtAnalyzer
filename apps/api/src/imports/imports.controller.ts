import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { z } from 'zod';
import { ClientIp, CurrentUser, RequirePermission } from '../auth/decorators';
import { parse } from '../common/zod';
import type { AuthUser } from '../common/types';
import { loadConfig } from '../config';
import { ImportsService } from './imports.service';

const cfg = loadConfig();
const cur = z.enum(['USD', 'UZS', 'RUB', 'EUR']);
const overrideSchema = z.record(z.coerce.number().int().positive(), z.object({ currency: cur.optional(), include: z.boolean().optional() }));
const mappingSchema = z.object({
  headerRow: z.number().int().positive(),
  fields: z.record(z.string(), z.number().int().positive()),
  weekColumns: z.array(z.object({ col: z.number().int().positive(), month: z.number().int().min(1).max(12), week: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]) })),
  missing: z.array(z.string()).default([]),
});

@Controller('imports')
export class ImportsController {
  constructor(private svc: ImportsService) {}

  @Post()
  @RequirePermission('import.run')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: cfg.MAX_UPLOAD_MB * 1024 * 1024, files: 1 } }))
  upload(@UploadedFile() file: Express.Multer.File, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) {
    return this.svc.upload(file, u, ip);
  }

  @Get() @RequirePermission('import.view')
  list() { return this.svc.list(); }

  @Get(':id') @RequirePermission('import.view')
  get(@Param('id', ParseUUIDPipe) id: string) { return this.svc.get(id); }

  @Post(':id/analyze') @RequirePermission('import.run')
  analyze(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) {
    const d = parse(z.object({ sheetName: z.string().min(1).max(200).optional(), mapping: mappingSchema.optional(), overrides: overrideSchema.optional(), planYear: z.number().int().min(2000).max(2100).optional() }), body ?? {});
    return this.svc.analyze(id, d as any, u, ip);
  }

  @Patch(':id/overrides') @RequirePermission('import.run')
  overrides(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) {
    return this.svc.setOverrides(id, parse(overrideSchema, body), u, ip);
  }

  @Get(':id/rows') @RequirePermission('import.view')
  rows(@Param('id', ParseUUIDPipe) id: string, @Query() q: Record<string, string>) {
    const d = parse(z.object({
      status: z.enum(['OK', 'WARNING', 'BLOCKED', 'DUPLICATE', 'EXCLUDED']).optional(), search: z.string().max(100).optional(), code: z.string().max(50).optional(),
      page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(200).default(50),
    }), q);
    return this.svc.rows(id, d);
  }

  @Get(':id/issues') @RequirePermission('import.view')
  issues(@Param('id', ParseUUIDPipe) id: string, @Query('severity') severity?: string) { return this.svc.issues(id, severity); }

  @Post(':id/commit') @RequirePermission('import.commit')
  commit(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentUser() u: AuthUser, @ClientIp() ip: string | null) {
    const d = parse(z.object({ planYear: z.number().int().min(2000).max(2100).optional(), confirm: z.literal(true) }), body ?? {});
    return this.svc.commit(id, d.planYear, u, ip);
  }
}
