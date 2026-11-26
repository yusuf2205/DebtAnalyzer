import { PW, USERS } from './helpers';

const API = 'http://localhost:4100/api';

async function call(method: string, path: string, body: unknown, cookie: string, csrf: string) {
  const r = await fetch(API + path, { method, headers: { 'content-type': 'application/json', cookie, ...(csrf && method !== 'GET' ? { 'x-csrf-token': csrf } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const setCookie = r.headers.getSetCookie?.() ?? [];
  return { status: r.status, json: await r.json().catch(() => null), cookie: setCookie.length ? setCookie.map((c) => c.split(';')[0]).join('; ') : cookie };
}
async function login(email: string, password: string) {
  const r = await call('POST', '/auth/login', { email, password }, '', '');
  return { ...r, csrf: r.json?.user?.csrfToken as string };
}

/** Один раз перед всеми сценариями: смена начального пароля администратора и создание пользователей всех ролей. */
export default async function globalSetup() {
  let s = await login(USERS.admin.email, 'E2eInitialPassw0rd!');
  if (s.status !== 200) throw new Error(`Не удалось войти начальным администратором: ${s.status}`);
  const ch0 = await call('POST', '/auth/change-password', { current: 'E2eInitialPassw0rd!', next: USERS.admin.password }, s.cookie, s.csrf);
  if (ch0.status !== 204) throw new Error(`Смена пароля администратора: ${ch0.status} ${JSON.stringify(ch0.json)}`);
  s = await login(USERS.admin.email, USERS.admin.password);
  for (const u of [USERS.manager, USERS.finance, USERS.viewer]) {
    const c = await call('POST', '/users', { email: u.email, name: u.email.split('@')[0], role: u.role, password: PW + 'tmp', }, s.cookie, s.csrf);
    if (c.status !== 201) throw new Error(`Не удалось создать ${u.email}: ${c.status} ${JSON.stringify(c.json)}`);
    const first = await login(u.email, PW + 'tmp');
    if (first.status !== 200) throw new Error(`Первый вход ${u.email}: ${first.status} ${JSON.stringify(first.json)}`);
    const ch = await call('POST', '/auth/change-password', { current: PW + 'tmp', next: u.password }, first.cookie, first.csrf);
    if (ch.status !== 204) throw new Error(`Смена пароля ${u.email}: ${ch.status} ${JSON.stringify(ch.json)}`);
  }
}
