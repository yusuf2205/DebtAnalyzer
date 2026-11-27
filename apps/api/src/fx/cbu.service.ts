import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { loadConfig } from '../config';
import { PrismaService } from '../prisma/prisma.service';

const CBU_URL = 'https://cbu.uz/ru/arkhiv-kursov-valyut/json/';
const WANT = ['USD', 'EUR', 'RUB'] as const;
interface CbuRow { Ccy: string; Nominal: string; Rate: string; Date: string }

/** «27.11.2026» → «2026-11-27». */
const isoDate = (d: string) => { const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(d); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };

/**
 * Официальные курсы ЦБ Узбекистана. Курс НЕ применяется сам: запись создаётся со статусом «ожидает подтверждения»,
 * подтверждает человек (так же, как курсы из таблицы). Повторная загрузка того же курса на ту же дату ничего не дублирует.
 */
@Injectable()
export class CbuService {
  private log = new Logger('CBU');
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  async fetchRows(): Promise<CbuRow[]> {
    const c = loadConfig();
    const url = (c.NODE_ENV === 'test' && c.CBU_URL) || CBU_URL;
    const r = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`ЦБ вернул HTTP ${r.status}`);
    const j = await r.json();
    if (!Array.isArray(j)) throw new Error('ЦБ вернул неожиданный ответ');
    return j as CbuRow[];
  }

  async sync(by?: { id: string; email: string }, ip?: string | null) {
    const rows = await this.fetchRows();
    const created: { currency: string; uzsPerUnit: string; effectiveDate: string }[] = [];
    const skipped: { currency: string; reason: string }[] = [];
    for (const ccy of WANT) {
      const row = rows.find((x) => x.Ccy === ccy);
      if (!row) { skipped.push({ currency: ccy, reason: 'нет в ответе ЦБ' }); continue; }
      const date = isoDate(row.Date);
      const nominal = Number(row.Nominal || 1), rate = Number(String(row.Rate).replace(',', '.'));
      if (!date || !(nominal > 0) || !(rate > 0)) { skipped.push({ currency: ccy, reason: 'некорректные данные ЦБ' }); continue; }
      const uzsPerUnit = new Prisma.Decimal(rate).div(nominal).toDecimalPlaces(8);
      // та же валюта и дата с тем же значением (в любом статусе, включая отклонённый) — повторно не создаём
      const dup = await this.prisma.fxRate.findFirst({ where: { currency: ccy, effectiveDate: new Date(date), uzsPerUnit } });
      if (dup) { skipped.push({ currency: ccy, reason: dup.status === 'REJECTED' ? 'уже была отклонена вами' : 'уже есть' }); continue; }
      const r = await this.prisma.fxRate.create({ data: { currency: ccy, uzsPerUnit, effectiveDate: new Date(date), source: 'CBU:cbu.uz', status: 'PENDING_CONFIRMATION', setById: by?.id ?? null } });
      created.push({ currency: ccy, uzsPerUnit: uzsPerUnit.toFixed(2), effectiveDate: date });
      await this.audit.log({ userId: by?.id ?? null, userEmail: by?.email ?? 'система', action: 'fx.cbu_fetch', entity: 'FxRate', entityId: r.id, after: { currency: ccy, uzsPerUnit: uzsPerUnit.toFixed(8), effectiveDate: date }, ip: ip ?? null });
    }
    if (created.length) this.log.log(`Курсы ЦБ: создано ${created.length} (ожидают подтверждения)`);
    return { created, skipped };
  }
}
