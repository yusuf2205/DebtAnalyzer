import type { Request } from 'express';
import type { Permission, Role } from '@pf/shared';

/** permissions — действующие права: из настраиваемой роли, если она назначена, иначе из встроенной роли. Загружаются из БД на каждый запрос, поэтому изменения роли действуют сразу. */
export interface AuthUser { id: string; email: string; name: string; role: Role; customRole: { id: string; name: string } | null; permissions: readonly Permission[]; mustChangePassword: boolean; sessionId: string; csrfToken: string; }
export type AuthedRequest = Request & { user?: AuthUser };
