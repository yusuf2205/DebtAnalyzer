import path from 'node:path';
import { fileURLToPath } from 'node:url';
const API = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';

/** @type {import('next').NextConfig} */
export default {
  output: 'standalone',
  outputFileTracingRoot: path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'),
  poweredByHeader: false,
  // Браузер ходит только на свой origin; /api проксируется на backend — cookie same-site, CORS не нужен.
  async rewrites() { return [{ source: '/api/:path*', destination: `${API}/api/:path*` }]; },
  async headers() {
    return [{ source: '/(.*)', headers: [
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'same-origin' },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
    ] }];
  },
};
