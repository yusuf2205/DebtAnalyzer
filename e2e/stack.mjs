// Изолированный стек для E2E: встраиваемый PostgreSQL + API + web на отдельных портах (не мешает рабочим серверам).
// web собирается и запускается ТАК ЖЕ, как в Docker-образе: `next build` (адрес API зашивается в сборку) -> артефакт standalone -> `node server.js`.
// Запускается Playwright (webServer). Требует собранных shared и api: npm run build:shared && npm run build -w @pf/api
import EmbeddedPostgres from 'embedded-postgres';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PG_PORT = 54500, API_PORT = 4100, WEB_PORT = 3100;
const DIST = '.next-e2e';
const work = mkdtempSync(join(tmpdir(), 'pf-e2e-'));
const children = [];
let pg;

async function cleanup() {
  for (const c of children) { try { c.kill(); } catch {} }
  try { await pg?.stop(); } catch {}
  try { rmSync(work, { recursive: true, force: true }); } catch {}
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await cleanup(); process.exit(0); });
process.on('exit', () => { for (const c of children) { try { c.kill(); } catch {} } });

const newest = (dir) => {
  let m = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    m = Math.max(m, e.isDirectory() ? newest(p) : statSync(p).mtimeMs);
  }
  return m;
};

try {
  pg = new EmbeddedPostgres({ databaseDir: join(work, 'pg'), user: 'pf', password: 'pf_e2e_password', port: PG_PORT, persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'] });
  await pg.initialise(); await pg.start(); await pg.createDatabase('pf');
  const DATABASE_URL = `postgresql://pf:pf_e2e_password@localhost:${PG_PORT}/pf`;

  const apiDir = join(root, 'apps/api');
  const prismaCli = createRequire(join(apiDir, 'package.json')).resolve('prisma/build/index.js');
  const mig = spawnSync(process.execPath, [prismaCli, 'migrate', 'deploy'], { cwd: apiDir, env: { ...process.env, DATABASE_URL }, encoding: 'utf8' });
  if (mig.status !== 0) throw new Error('migrate deploy failed: ' + mig.stdout + mig.stderr);

  const env = {
    ...process.env, NODE_ENV: 'production', DATABASE_URL, PORT: String(API_PORT), UPLOAD_DIR: join(work, 'uploads'), COOKIE_SECURE: 'false',
    TRUST_PROXY_HOPS: '2', LOGIN_RATE_LIMIT: '1000', INITIAL_ADMIN_EMAIL: 'e2e-admin@example.test', INITIAL_ADMIN_PASSWORD: 'E2eInitialPassw0rd!',
  };
  const api = spawn(process.execPath, ['dist/main.js'], { cwd: apiDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(api);
  api.stdout.on('data', () => {}); api.stderr.on('data', (d) => process.stderr.write(`[api] ${d}`));
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://localhost:${API_PORT}/api/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 1000)); if (i === 59) throw new Error('API не поднялся'); }

  // --- web: сборка (если исходники новее прошлой сборки) с адресом ЭТОГО API ---
  const webDir = join(root, 'apps/web');
  const buildId = join(webDir, DIST, 'BUILD_ID');
  const srcNewest = Math.max(newest(join(webDir, 'src')), statSync(join(webDir, 'next.config.mjs')).mtimeMs);
  if (!existsSync(buildId) || statSync(buildId).mtimeMs < srcNewest) {
    console.log('E2E: сборка web (standalone) …');
    const nextBin = createRequire(join(webDir, 'package.json')).resolve('next/dist/bin/next');
    const b = spawnSync(process.execPath, [nextBin, 'build'], { cwd: webDir, env: { ...process.env, NODE_ENV: 'production', NEXT_DIST_DIR: DIST, API_INTERNAL_URL: `http://localhost:${API_PORT}` }, encoding: 'utf8' });
    if (b.status !== 0) throw new Error('next build failed: ' + (b.stdout ?? '').slice(-2000) + (b.stderr ?? '').slice(-2000));
  }
  // --- как в deploy/Dockerfile.web: standalone + static рядом ---
  const run = join(work, 'web');
  cpSync(join(webDir, DIST, 'standalone'), run, { recursive: true, dereference: true });
  mkdirSync(join(run, 'apps/web', DIST), { recursive: true });
  cpSync(join(webDir, DIST, 'static'), join(run, 'apps/web', DIST, 'static'), { recursive: true });
  const web = spawn(process.execPath, ['apps/web/server.js'], { cwd: run, env: { ...env, PORT: String(WEB_PORT), HOSTNAME: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(web);
  web.stdout.on('data', () => {}); web.stderr.on('data', (d) => process.stderr.write(`[web] ${d}`));
  console.log('E2E stack started');
  setInterval(() => {}, 1 << 30);
} catch (e) {
  console.error('E2E stack failed:', e);
  await cleanup(); process.exit(1);
}
