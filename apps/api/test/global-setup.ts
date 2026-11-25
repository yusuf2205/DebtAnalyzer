import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

let pg: EmbeddedPostgres;
let dir: string;
let uploads: string;

export async function setup() {
  dir = mkdtempSync(join(tmpdir(), 'pf-test-pg-'));
  uploads = mkdtempSync(join(tmpdir(), 'pf-test-up-'));
  const port = 54400 + Math.floor(Math.random() * 400);
  pg = new EmbeddedPostgres({ databaseDir: join(dir, 'data'), user: 'pf', password: 'pf_test_password', port, persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'] });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('pf_test');
  const url = `postgresql://pf:pf_test_password@localhost:${port}/pf_test`;
  process.env.DATABASE_URL = url;
  process.env.NODE_ENV = 'test';
  process.env.UPLOAD_DIR = uploads;
  process.env.INITIAL_ADMIN_EMAIL = 'root@example.test';
  process.env.INITIAL_ADMIN_PASSWORD = 'InitialPassw0rd!';
  process.env.LOGIN_RATE_LIMIT = '1000';
  execSync('npx prisma migrate deploy', { cwd: join(__dirname, '..'), env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' });
}

export async function teardown() {
  await pg?.stop();
  rmSync(dir, { recursive: true, force: true });
  rmSync(uploads, { recursive: true, force: true });
}
