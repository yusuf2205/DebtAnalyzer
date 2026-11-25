import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { loadConfig } from '../config';
import { parse } from '../common/zod';
import type { AuthUser } from '../common/types';
import { SESSION_COOKIE } from './access.guard';
import { AuthService } from './auth.service';
import { AllowPasswordChangePending, ClientIp, CurrentUser, Public } from './decorators';

const cfg = loadConfig();
const publicUser = (u: AuthUser) => ({ id: u.id, email: u.email, name: u.name, role: u.role, mustChangePassword: u.mustChangePassword, csrfToken: u.csrfToken });

@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) {}

  @Public()
  @Throttle({ default: { limit: cfg.LOGIN_RATE_LIMIT, ttl: 60_000 } })
  @Post('login')
  @HttpCode(200)
  async login(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { email, password } = parse(z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) }), body);
    const r = await this.auth.login(email, password, req.ip ?? null, req.headers['user-agent'] ?? null);
    res.cookie(SESSION_COOKIE, r.token, { httpOnly: true, secure: cfg.cookieSecure, sameSite: 'lax', path: '/', expires: r.expiresAt });
    return { user: publicUser(r.user) };
  }

  @AllowPasswordChangePending()
  @Get('me')
  me(@CurrentUser() u: AuthUser) { return { user: publicUser(u) }; }

  @AllowPasswordChangePending()
  @Post('logout')
  @HttpCode(204)
  async logout(@CurrentUser() u: AuthUser, @ClientIp() ip: string | null, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(u, ip);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
  }

  @AllowPasswordChangePending()
  @Post('change-password')
  @HttpCode(204)
  async changePassword(@CurrentUser() u: AuthUser, @Body() body: unknown, @ClientIp() ip: string | null) {
    const { current, next } = parse(z.object({ current: z.string().min(1).max(200), next: z.string().min(1).max(200) }), body);
    await this.auth.changePassword(u, current, next, ip);
  }
}
