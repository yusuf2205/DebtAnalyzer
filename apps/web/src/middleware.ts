import { NextResponse, type NextRequest } from 'next/server';

/**
 * Content-Security-Policy с одноразовым nonce на каждый запрос: исполняются только скрипты самого Next с этим nonce.
 * Внедрённый в страницу <script> (XSS) не выполнится. Стили допускают inline (атрибуты style у React/Recharts).
 */
export function middleware(req: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const dev = process.env.NODE_ENV !== 'production';
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self'",   // служебный скрипт sw.js (запасная страница без связи)
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(dev ? [] : ['upgrade-insecure-requests']),
  ].join('; ');

  const headers = new Headers(req.headers);
  headers.set('x-nonce', nonce);
  headers.set('content-security-policy', csp);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set('Content-Security-Policy', csp);
  return res;
}

// API (/api/*) проксируется на backend и защищается его заголовками; статические ресурсы CSP не нужны.
export const config = { matcher: ['/((?!api/|_next/static|_next/image|favicon.ico).*)'] };
