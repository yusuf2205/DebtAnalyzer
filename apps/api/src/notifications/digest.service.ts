import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { DashboardController } from '../analytics/dashboard.controller';
import { PrismaService } from '../prisma/prisma.service';
import { SystemController } from '../system/system.controller';

export interface DigestInclude { overdue: boolean; upcoming: boolean; pending: boolean; plant: boolean; fx: boolean; system: boolean }
export const DEFAULT_INCLUDE: DigestInclude = { overdue: true, upcoming: true, pending: true, plant: true, fx: true, system: true };

interface Line { number: string | null; supplier: string; amount: string; currency: string; period?: string }
export interface Digest {
  date: string;
  overdue: { count: number; totalUzs: string | null; byCurrency: { currency: string; amount: string }[]; items: Line[] };
  upcoming: { horizonDays: number; count: number; totalUzs: string | null; byCurrency: { currency: string; amount: string }[]; items: Line[] };
  pending: { count: number; oldestDays: number | null };
  plant: { mood: string; stage: number; message: string; daysToNextMood: number | null } | null;
  fx: { pending: number };
  system: { status: 'ok' | 'warn' | 'error'; problems: { title: string; detail: string; status: string }[] };
  uzsNote: string | null;
}

const fmt = (v: string | number | null | undefined) => (v === null || v === undefined ? '—' : Number(v).toLocaleString('ru-RU', { maximumFractionDigits: 2 }));
const byCur = (rows: { currency: string; amount: string }[]) => rows.map((r) => `${fmt(r.amount)} ${r.currency}`).join(', ');
const ruDate = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const MOOD: Record<string, string> = { healthy: 'здоров', thirsty: 'хочет пить', wilting: 'вянет', dead: 'погиб' };

/** Сводка для уведомлений: те же расчёты, что на Dashboard (без дублирования логики), плюс очередь подтверждений и состояние системы. */
@Injectable()
export class DigestService {
  constructor(private prisma: PrismaService, private moduleRef: ModuleRef) {}

  async build(horizonDays = 3): Promise<Digest> {
    const dash = await this.moduleRef.get(DashboardController, { strict: false }).get({ horizon: String(horizonDays), status: 'ACTIVE' });
    const sys = await this.moduleRef.get(SystemController, { strict: false }).status();
    const [pendingCount, oldest, fxPending] = await Promise.all([
      this.prisma.payment.count({ where: { status: 'PENDING' } }),
      this.prisma.payment.findFirst({ where: { status: 'PENDING' }, orderBy: { submittedAt: 'asc' }, select: { submittedAt: true, createdAt: true } }),
      this.prisma.fxRate.count({ where: { status: 'PENDING_CONFIRMATION' } }),
    ]);
    const line = (x: any): Line => ({ number: x.number ?? null, supplier: x.supplier?.name ?? '', amount: x.amount, currency: x.currency, period: x.from ? `${x.from.slice(5)}…${x.to.slice(5)}` : undefined });
    const since = oldest ? (oldest.submittedAt ?? oldest.createdAt) : null;
    return {
      date: dash.asOf,
      overdue: { count: dash.overdue.items.length, totalUzs: (dash.overdue as any).totalUzs ?? null, byCurrency: dash.overdue.byCurrency.map((r: any) => ({ currency: r.currency, amount: r.amount })), items: dash.overdue.items.slice(0, 5).map(line) },
      upcoming: { horizonDays, count: dash.upcoming.items.length, totalUzs: (dash.upcoming as any).totalUzs ?? null, byCurrency: dash.upcoming.byCurrency.map((r: any) => ({ currency: r.currency, amount: r.amount })), items: dash.upcoming.items.slice(0, 5).map(line) },
      pending: { count: pendingCount, oldestDays: since ? Math.floor((Date.now() - since.getTime()) / 86_400_000) : null },
      plant: dash.plant ? { mood: dash.plant.mood, stage: dash.plant.stage, message: dash.plant.message, daysToNextMood: dash.plant.daysToNextMood } : null,
      fx: { pending: fxPending },
      system: { status: sys.status, problems: sys.checks.filter((c) => c.status !== 'ok').map((c) => ({ title: c.title, detail: c.detail, status: c.status })) },
      uzsNote: dash.rates.uzsNote ?? null,
    };
  }

  render(d: Digest, include: DigestInclude = DEFAULT_INCLUDE, baseUrl?: string): { subject: string; text: string } {
    const out: string[] = [`Procurement Finance — сводка на ${ruDate(d.date)}`, ''];
    if (include.overdue) {
      out.push(d.overdue.count ? `⚠ Просрочено: ${d.overdue.count} обязательств${d.overdue.totalUzs ? `, всего ${fmt(d.overdue.totalUzs)} UZS` : `: ${byCur(d.overdue.byCurrency)}`}` : '✓ Просроченных обязательств нет');
      for (const x of d.overdue.items) out.push(`   • ${x.number ?? '—'} (${x.supplier}) — ${fmt(x.amount)} ${x.currency}`);
      if (d.overdue.count > d.overdue.items.length) out.push(`   … и ещё ${d.overdue.count - d.overdue.items.length}`);
      out.push('');
    }
    if (include.upcoming) {
      out.push(d.upcoming.count ? `📅 Ближайшие платежи (${d.upcoming.horizonDays} дн.): ${d.upcoming.count}${d.upcoming.totalUzs ? `, всего ${fmt(d.upcoming.totalUzs)} UZS` : `: ${byCur(d.upcoming.byCurrency)}`}` : `📅 На ближайшие ${d.upcoming.horizonDays} дн. плановых платежей нет`);
      for (const x of d.upcoming.items) out.push(`   • ${x.number ?? '—'} (${x.supplier}) — ${fmt(x.amount)} ${x.currency}${x.period ? `, ${x.period}` : ''}`);
      out.push('');
    }
    if (include.pending) {
      out.push(d.pending.count ? `🕑 Ждут подтверждения: ${d.pending.count} платежей${d.pending.oldestDays !== null ? `, самый старый — ${d.pending.oldestDays} дн.` : ''}` : '✓ Платежей на подтверждение нет');
      out.push('');
    }
    if (include.fx && d.fx.pending) { out.push(`💱 Курсов ждут подтверждения: ${d.fx.pending}${d.uzsNote ? ` (${d.uzsNote})` : ''}`); out.push(''); }
    if (include.plant && d.plant) { out.push(`🌱 Цветок: ${MOOD[d.plant.mood] ?? d.plant.mood}. ${d.plant.message}`); out.push(''); }
    if (include.system && d.system.problems.length) {
      out.push(`🛠 Система: ${d.system.status === 'error' ? 'есть проблемы' : 'есть предупреждения'}`);
      for (const p of d.system.problems) out.push(`   • ${p.title}: ${p.detail}`);
      out.push('');
    }
    if (baseUrl) out.push(baseUrl.replace(/\/$/, ''));
    const flags = [d.overdue.count ? `просрочено ${d.overdue.count}` : null, d.pending.count ? `ждут ${d.pending.count}` : null, d.system.status === 'error' ? 'проблемы системы' : null].filter(Boolean);
    return { subject: `Procurement Finance: сводка ${d.date}${flags.length ? ` (${flags.join(', ')})` : ''}`, text: out.join('\n').trimEnd() };
  }
}
