import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { z } from 'zod';
import { loadConfig } from '../config';
import { PrismaService } from '../prisma/prisma.service';
import { SystemController } from '../system/system.controller';
import { emailConfigured, sendEmail, sendTelegram, telegramConfigured } from './channels';
import { DEFAULT_INCLUDE, DigestService } from './digest.service';

const KEY = 'notifications', STATE_KEY = 'notificationsState';

export const settingsSchema = z.object({
  enabled: z.boolean(),
  hour: z.number().int().min(0).max(23),
  weekdaysOnly: z.boolean(),
  leadDays: z.number().int().min(1).max(14),
  telegramChatIds: z.array(z.string().trim().regex(/^(-?\d{3,20}|@[A-Za-z0-9_]{4,64})$/, 'Telegram: числовой chat id или @канал')).max(10),
  emails: z.array(z.string().trim().email('Некорректный адрес почты').max(200)).max(10),
  include: z.object({ overdue: z.boolean(), upcoming: z.boolean(), pending: z.boolean(), plant: z.boolean(), fx: z.boolean(), system: z.boolean() }),
  alerts: z.boolean(), // немедленные уведомления о проблемах системы (воркер, копии, диск)
}).strict();
export type NotifySettings = z.infer<typeof settingsSchema>;
export const DEFAULT_SETTINGS: NotifySettings = { enabled: false, hour: 8, weekdaysOnly: false, leadDays: 3, telegramChatIds: [], emails: [], include: DEFAULT_INCLUDE, alerts: true };

interface State { lastDigestDate?: string; lastDigestAt?: string; lastError?: string | null; alertKey?: string; alertAt?: string }

/** Местные дата, час и день недели (1 = пн … 7 = вс) в часовом поясе приложения. */
export function localParts(now: Date, tz: string) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short' });
  const p = Object.fromEntries(f.formatToParts(now).map((x) => [x.type, x.value]));
  const wd = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.weekday!) + 1;
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), weekday: wd };
}

@Injectable()
export class NotificationsService {
  private log = new Logger('Notifications');
  constructor(private prisma: PrismaService, private digest: DigestService, private moduleRef: ModuleRef) {}

  async settings(): Promise<NotifySettings> {
    const s = await this.prisma.appSetting.findUnique({ where: { key: KEY } });
    const parsed = settingsSchema.safeParse({ ...DEFAULT_SETTINGS, ...(s?.value as object | undefined) });
    return parsed.success ? parsed.data : DEFAULT_SETTINGS;
  }
  async saveSettings(v: NotifySettings, userId: string) {
    await this.prisma.appSetting.upsert({ where: { key: KEY }, create: { key: KEY, value: v, updatedById: userId }, update: { value: v, updatedById: userId } });
  }
  async state(): Promise<State> { return ((await this.prisma.appSetting.findUnique({ where: { key: STATE_KEY } }))?.value as State | undefined) ?? {}; }
  private async setState(patch: Partial<State>) {
    const value = { ...(await this.state()), ...patch };
    await this.prisma.appSetting.upsert({ where: { key: STATE_KEY }, create: { key: STATE_KEY, value }, update: { value } });
  }

  channels() { const c = loadConfig(); return { telegram: telegramConfigured(c), email: emailConfigured(c), timezone: c.APP_TIMEZONE }; }

  /** Отправка всем получателям; ошибка одного получателя не мешает остальным. */
  async deliver(s: NotifySettings, subject: string, text: string): Promise<{ sent: number; errors: string[] }> {
    const c = loadConfig();
    let sent = 0; const errors: string[] = [];
    const jobs: Promise<void>[] = [];
    if (telegramConfigured(c)) for (const id of s.telegramChatIds) jobs.push(sendTelegram(c, id, text).then(() => { sent++; }, (e) => { errors.push((e as Error).message); }));
    else if (s.telegramChatIds.length) errors.push('Telegram: не задан TELEGRAM_BOT_TOKEN в окружении сервера');
    if (emailConfigured(c)) for (const to of s.emails) jobs.push(sendEmail(c, to, subject, text).then(() => { sent++; }, (e) => { errors.push((e as Error).message); }));
    else if (s.emails.length) errors.push('Почта: не заданы SMTP_HOST и SMTP_FROM в окружении сервера');
    await Promise.all(jobs);
    if (!s.telegramChatIds.length && !s.emails.length) errors.push('Не указано ни одного получателя');
    return { sent, errors };
  }

  async sendDigest(s?: NotifySettings) {
    const cfg = s ?? (await this.settings());
    const c = loadConfig();
    const d = await this.digest.build(cfg.leadDays);
    const { subject, text } = this.digest.render(d, cfg.include, c.APP_BASE_URL);
    const r = await this.deliver(cfg, subject, text);
    await this.setState({ lastError: r.errors.length ? r.errors.join('; ') : null, ...(r.sent ? { lastDigestAt: new Date().toISOString() } : {}) });
    return { ...r, subject, text };
  }

  /** Вызывается воркером каждые 10 минут: ежедневная сводка в заданный час и немедленные уведомления о проблемах системы. */
  async tick(now = new Date()) {
    const s = await this.settings();
    if (!s.enabled) return { digest: false, alert: false };
    const c = loadConfig();
    const lp = localParts(now, c.APP_TIMEZONE);
    const st = await this.state();
    let digestSent = false, alertSent = false;

    if (lp.hour >= s.hour && st.lastDigestDate !== lp.date && (!s.weekdaysOnly || lp.weekday <= 5)) {
      const r = await this.sendDigest(s);
      if (r.sent > 0) { await this.setState({ lastDigestDate: lp.date }); digestSent = true; }
      else this.log.warn(`Сводка не отправлена: ${r.errors.join('; ')}`);
    }

    if (s.alerts) {
      const sys = await this.moduleRef.get(SystemController, { strict: false }).status();
      const bad = sys.checks.filter((x) => x.status === 'error');
      const key = bad.map((x) => x.id).sort().join(',');
      const st2 = await this.state();
      const stale = !st2.alertAt || now.getTime() - new Date(st2.alertAt).getTime() > 24 * 3600_000; // напоминаем раз в сутки, пока проблема не устранена
      if (key && (key !== (st2.alertKey ?? '') || stale)) {
        const text = `🛠 Procurement Finance: проблемы системы\n${bad.map((x) => `• ${x.title}: ${x.detail}`).join('\n')}${c.APP_BASE_URL ? `\n${c.APP_BASE_URL}` : ''}`;
        const r = await this.deliver(s, 'Procurement Finance: проблемы системы', text);
        if (r.sent > 0) { await this.setState({ alertKey: key, alertAt: now.toISOString() }); alertSent = true; }
      } else if (!key && st2.alertKey) {
        const r = await this.deliver(s, 'Procurement Finance: проблемы устранены', '✓ Procurement Finance: проблемы системы устранены.');
        if (r.sent > 0) await this.setState({ alertKey: '', alertAt: undefined });
      }
    }
    return { digest: digestSent, alert: alertSent };
  }
}
