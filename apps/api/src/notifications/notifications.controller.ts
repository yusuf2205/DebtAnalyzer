import { Body, Controller, Get, Post, Put, Query } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { ClientIp, CurrentUser, RequirePermission } from '../auth/decorators';
import type { AuthUser } from '../common/types';
import { parse } from '../common/zod';
import { loadConfig } from '../config';
import { DigestService } from './digest.service';
import { NotificationsService, settingsSchema } from './notifications.service';

/** Настройки уведомлений: только администраторы (право settings.manage). */
@Controller('notifications')
export class NotificationsController {
  constructor(private svc: NotificationsService, private digest: DigestService, private audit: AuditService) {}

  @Get('settings')
  @RequirePermission('settings.manage')
  async get() { return { settings: await this.svc.settings(), channels: this.svc.channels(), state: await this.svc.state() }; }

  @Put('settings')
  @RequirePermission('settings.manage')
  async put(@CurrentUser() u: AuthUser, @Body() body: unknown, @ClientIp() ip: string | null) {
    const v = parse(settingsSchema, body);
    const before = await this.svc.settings();
    await this.svc.saveSettings(v, u.id);
    await this.audit.log({ userId: u.id, userEmail: u.email, action: 'notifications.settings', entity: 'AppSetting', entityId: 'notifications', before, after: v, ip });
    return { settings: v };
  }

  /** Предпросмотр: что будет в сообщении сейчас (ничего не отправляется). */
  @Get('preview')
  @RequirePermission('settings.manage')
  async preview(@Query('lead') lead?: string) {
    const s = await this.svc.settings();
    const d = await this.digest.build(Math.min(14, Math.max(1, Number(lead) || s.leadDays)));
    return { digest: d, ...this.digest.render(d, s.include, loadConfig().APP_BASE_URL) };
  }

  /** Пробное сообщение во все каналы — проверить настройку. */
  @Post('test')
  @RequirePermission('settings.manage')
  async test(@CurrentUser() u: AuthUser, @ClientIp() ip: string | null) {
    const s = await this.svc.settings();
    const r = await this.svc.deliver(s, 'Procurement Finance: проверка уведомлений', '✓ Проверка связи: уведомления Procurement Finance настроены.');
    await this.audit.log({ userId: u.id, userEmail: u.email, action: 'notifications.test', entity: 'AppSetting', entityId: 'notifications', meta: { sent: r.sent, errors: r.errors }, ip });
    return r;
  }

  /** Отправить сводку сейчас (вне расписания). */
  @Post('send-digest')
  @RequirePermission('settings.manage')
  async sendNow(@CurrentUser() u: AuthUser, @ClientIp() ip: string | null) {
    const { sent, errors } = await this.svc.sendDigest();
    await this.audit.log({ userId: u.id, userEmail: u.email, action: 'notifications.send_digest', entity: 'AppSetting', entityId: 'notifications', meta: { sent, errors }, ip });
    return { sent, errors };
  }
}
