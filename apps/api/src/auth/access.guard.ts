import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { timingSafeEqual } from 'node:crypto';
import { can, type Permission } from '@pf/shared';
import type { AuthedRequest } from '../common/types';
import { AuthService } from './auth.service';
import { sessionCookieName } from './cookie';
import { ALLOW_PASSWORD_CHANGE_PENDING, IS_PUBLIC, PERMISSION } from './decorators';

export const CSRF_HEADER = 'x-csrf-token';
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

const eq = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

/**
 * Единственная точка контроля доступа на backend: сессия -> CSRF -> обязательная смена пароля -> разрешение.
 * По умолчанию всё закрыто: маршрут без @Public требует входа.
 */
@Injectable()
export class AccessGuard implements CanActivate {
  constructor(private reflector: Reflector, private auth: AuthService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const handlers = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, handlers)) return true;
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const token = (req as any).cookies?.[sessionCookieName()] as string | undefined;
    const user = token ? await this.auth.validate(token) : null;
    if (!user) throw new UnauthorizedException('Требуется вход в систему');
    if (!SAFE.has(req.method)) {
      const sent = req.headers[CSRF_HEADER];
      if (typeof sent !== 'string' || !eq(sent, user.csrfToken)) throw new ForbiddenException('Недействительный CSRF-токен');
    }
    if (user.mustChangePassword && !this.reflector.getAllAndOverride<boolean>(ALLOW_PASSWORD_CHANGE_PENDING, handlers)) {
      throw new ForbiddenException({ message: 'Необходимо сменить пароль', code: 'PASSWORD_CHANGE_REQUIRED' });
    }
    const perm = this.reflector.getAllAndOverride<Permission | undefined>(PERMISSION, handlers);
    if (perm && !can(user.role, perm)) throw new ForbiddenException('Недостаточно прав для этого действия');
    req.user = user;
    return true;
  }
}
