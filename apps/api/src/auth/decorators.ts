import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Permission } from '@pf/shared';
import type { AuthedRequest } from '../common/types';

export const IS_PUBLIC = 'isPublic';
export const PERMISSION = 'permission';
export const ALLOW_PASSWORD_CHANGE_PENDING = 'allowPwPending';

export const Public = () => SetMetadata(IS_PUBLIC, true);
export const RequirePermission = (p: Permission) => SetMetadata(PERMISSION, p);
export const AllowPasswordChangePending = () => SetMetadata(ALLOW_PASSWORD_CHANGE_PENDING, true);
export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<AuthedRequest>().user!);
export const ClientIp = createParamDecorator((_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<AuthedRequest>().ip ?? null);
