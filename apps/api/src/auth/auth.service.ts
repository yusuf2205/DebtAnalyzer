import { BadRequestException, ForbiddenException, HttpException, HttpStatus, Injectable, Logger, OnApplicationBootstrap, UnauthorizedException } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';
import { createHash, randomBytes } from 'node:crypto';
import type { Role } from '@pf/shared';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../common/types';
import { loadConfig } from '../config';
import { PrismaService } from '../prisma/prisma.service';

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
export const MIN_PASSWORD = 12;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function checkPasswordPolicy(pw: string) {
  if (pw.length < MIN_PASSWORD) throw new BadRequestException(`Пароль должен содержать не менее ${MIN_PASSWORD} символов`);
  if (!/[a-zA-Zа-яА-Я]/.test(pw) || !/\d/.test(pw)) throw new BadRequestException('Пароль должен содержать буквы и цифры');
}

@Injectable()
export class AuthService implements OnApplicationBootstrap {
  private log = new Logger('Auth');
  private cfg = loadConfig();
  // Хеш для выравнивания времени ответа, когда пользователь не найден (защита от перебора email по таймингу).
  private dummyHash?: Promise<string>;

  constructor(private prisma: PrismaService, private audit: AuditService) {}

  hashPassword(pw: string) { return hash(pw); }

  async onApplicationBootstrap() {
    if ((await this.prisma.user.count()) > 0) return;
    const { INITIAL_ADMIN_EMAIL: email, INITIAL_ADMIN_PASSWORD: pw } = this.cfg;
    if (!email || !pw) { this.log.warn('Пользователей нет, а INITIAL_ADMIN_EMAIL/INITIAL_ADMIN_PASSWORD не заданы — вход невозможен.'); return; }
    const u = await this.prisma.user.create({ data: { email: email.toLowerCase(), name: 'Администратор', role: 'SUPER_ADMIN', passwordHash: await this.hashPassword(pw), mustChangePassword: true } });
    await this.audit.log({ userId: u.id, userEmail: u.email, action: 'user.bootstrap', entity: 'User', entityId: u.id, after: { email: u.email, role: u.role } });
    this.log.log(`Создан начальный SUPER_ADMIN ${u.email} (смена пароля обязательна при первом входе)`);
  }

  async login(emailRaw: string, password: string, ip: string | null, userAgent: string | null) {
    const email = emailRaw.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || !user.isActive) {
      this.dummyHash ??= hash('dummy-password-for-timing');
      await verify(await this.dummyHash, password).catch(() => false);
      await this.audit.log({ userEmail: email, action: 'auth.login_failed', entity: 'User', meta: { reason: user ? 'inactive' : 'unknown' }, ip });
      throw new UnauthorizedException('Неверный email или пароль');
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new HttpException('Учётная запись временно заблокирована из-за неудачных попыток входа. Повторите позже.', HttpStatus.LOCKED);
    }
    const ok = await verify(user.passwordHash, password).catch(() => false);
    if (!ok) {
      const failed = user.failedLogins + 1;
      await this.prisma.user.update({ where: { id: user.id }, data: { failedLogins: failed, lockedUntil: failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null } });
      await this.audit.log({ userId: user.id, userEmail: email, action: 'auth.login_failed', entity: 'User', entityId: user.id, meta: { failed }, ip });
      throw new UnauthorizedException('Неверный email или пароль');
    }
    await this.prisma.user.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: null } });
    const token = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(24).toString('base64url');
    const session = await this.prisma.session.create({
      data: { userId: user.id, tokenHash: sha256(token), csrfToken, ip, userAgent: userAgent?.slice(0, 300), expiresAt: new Date(Date.now() + this.cfg.SESSION_TTL_HOURS * 3600_000) },
    });
    await this.audit.log({ userId: user.id, userEmail: email, action: 'auth.login', entity: 'Session', entityId: session.id, ip });
    return { token, expiresAt: session.expiresAt, user: this.toAuthUser(user, session.id, csrfToken) };
  }

  private toAuthUser(u: { id: string; email: string; name: string; role: string; mustChangePassword: boolean }, sessionId: string, csrfToken: string): AuthUser {
    return { id: u.id, email: u.email, name: u.name, role: u.role as Role, mustChangePassword: u.mustChangePassword, sessionId, csrfToken };
  }

  async validate(token: string): Promise<AuthUser | null> {
    const s = await this.prisma.session.findUnique({ where: { tokenHash: sha256(token) }, include: { user: true } });
    if (!s || s.revokedAt || s.expiresAt < new Date() || !s.user.isActive) return null;
    return this.toAuthUser(s.user, s.id, s.csrfToken);
  }

  async logout(user: AuthUser, ip: string | null) {
    await this.prisma.session.update({ where: { id: user.sessionId }, data: { revokedAt: new Date() } });
    await this.audit.log({ userId: user.id, userEmail: user.email, action: 'auth.logout', entity: 'Session', entityId: user.sessionId, ip });
  }

  async changePassword(user: AuthUser, current: string, next: string, ip: string | null) {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    if (!(await verify(u.passwordHash, current).catch(() => false))) throw new ForbiddenException('Текущий пароль указан неверно');
    checkPasswordPolicy(next);
    if (current === next) throw new BadRequestException('Новый пароль должен отличаться от текущего');
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: u.id }, data: { passwordHash: await this.hashPassword(next), mustChangePassword: false } }),
      this.prisma.session.updateMany({ where: { userId: u.id, id: { not: user.sessionId }, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
    await this.audit.log({ userId: u.id, userEmail: u.email, action: 'auth.password_changed', entity: 'User', entityId: u.id, ip });
  }

  async purgeExpired() {
    const r = await this.prisma.session.deleteMany({ where: { OR: [{ expiresAt: { lt: new Date() } }, { revokedAt: { lt: new Date(Date.now() - 7 * 86400_000) } }] } });
    return r.count;
  }
}
