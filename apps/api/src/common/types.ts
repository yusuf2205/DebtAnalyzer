import type { Request } from 'express';
import type { Role } from '@pf/shared';

export interface AuthUser { id: string; email: string; name: string; role: Role; mustChangePassword: boolean; sessionId: string; csrfToken: string; }
export type AuthedRequest = Request & { user?: AuthUser };
