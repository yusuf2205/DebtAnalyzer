import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** Деньги в журнале — только строками: JSON-число теряет точность на больших суммах. */
function plain(v: unknown): Prisma.InputJsonValue | undefined {
  if (v === undefined || v === null) return undefined;
  return JSON.parse(JSON.stringify(v, (_k, val) => (Prisma.Decimal.isDecimal(val) ? (val as Prisma.Decimal).toString() : typeof val === 'bigint' ? val.toString() : val)));
}

export interface AuditEntry {
  userId?: string | null; userEmail?: string | null; action: string; entity: string; entityId?: string | null;
  before?: unknown; after?: unknown; meta?: unknown; ip?: string | null;
}

@Injectable()
export class AuditService {
  constructor(private prisma: PrismaService) {}
  async log(e: AuditEntry, tx?: Prisma.TransactionClient) {
    const db = tx ?? this.prisma;
    await db.auditLog.create({
      data: {
        userId: e.userId ?? null, userEmail: e.userEmail ?? null, action: e.action, entity: e.entity, entityId: e.entityId ?? null,
        before: plain(e.before), after: plain(e.after),
        meta: plain(e.meta), ip: e.ip ?? null,
      },
    });
  }
}
