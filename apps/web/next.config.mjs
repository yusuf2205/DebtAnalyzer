import path from 'node:path';
import { fileURLToPath } from 'node:url';
// ВАЖНО: адрес API для rewrites вычисляется при `next build` и сохраняется в сборке (во время запуска не читается).
// В Docker он задаётся аргументом сборки (deploy/Dockerfile.web, по умолчанию http://api:4000 — сервис Compose).
const API = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';

/** @type {import('next').NextConfig} */
export default {
  output: 'standalone',
  distDir: process.env.NEXT_DIST_DIR || '.next',
  outputFileTracingRoot: path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'),
  poweredByHeader: false,
  // Браузер ходит только на свой origin; /api проксируется на backend — cookie same-site, CORS не нужен.
  async rewrites() { return [{ source: '/api/:path*', destination: `${API}/api/:path*` }]; },
  async headers() {
    return [{ source: '/(.*)', headers: [
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'same-origin' },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
      { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
      ...(process.env.NODE_ENV === 'production' ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' }] : []),
    ] }];
  },
};
