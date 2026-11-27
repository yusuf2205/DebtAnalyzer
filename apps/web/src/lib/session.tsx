'use client';
import type { Permission } from '@pf/shared';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError, setCsrf, type Me } from './api';

interface Ctx { me: Me | null; loading: boolean; can: (p: Permission) => boolean; logout: () => Promise<void>; refresh: () => Promise<void> }
const SessionCtx = createContext<Ctx>(null as unknown as Ctx);
export const useSession = () => useContext(SessionCtx);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const path = usePathname();

  const refresh = useCallback(async () => {
    try {
      const r = await api<{ user: Me }>('GET', '/auth/me');
      setCsrf(r.user.csrfToken); setMe(r.user);
      if (r.user.mustChangePassword && path !== '/change-password') router.replace('/change-password');
    } catch (e) {
      setMe(null);
      if (e instanceof ApiError && e.status === 401 && path !== '/login') router.replace('/login');
    } finally { setLoading(false); }
  }, [path, router]);

  useEffect(() => { if (path === '/login') { setLoading(false); return; } refresh(); }, [refresh, path]);

  const logout = useCallback(async () => { try { await api('POST', '/auth/logout'); } catch {} setMe(null); router.replace('/login'); }, [router]);
  const value: Ctx = { me, loading, can: (p) => !!me && me.permissions.includes(p), logout, refresh };
  return <SessionCtx.Provider value={value}>{children}</SessionCtx.Provider>;
}
