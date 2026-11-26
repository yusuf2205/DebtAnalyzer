import { loadConfig } from '../config';

/**
 * Имя сессионной cookie. В защищённом режиме используется префикс __Host-: браузер принимает такую cookie только
 * с флагом Secure, Path=/ и без Domain — её нельзя подменить с поддомена или по HTTP.
 */
export const sessionCookieName = () => (loadConfig().cookieSecure ? '__Host-pf_session' : 'pf_session');
export const sessionCookieOptions = (expires?: Date) => ({ httpOnly: true, secure: loadConfig().cookieSecure, sameSite: 'lax' as const, path: '/', ...(expires ? { expires } : {}) });
