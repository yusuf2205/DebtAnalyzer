// Локальная БД для разработки/тестов без Docker: встраиваемый PostgreSQL.
// Использование: node scripts/dev-db.mjs [port] [dataDir]
import EmbeddedPostgres from 'embedded-postgres';
import { existsSync } from 'node:fs';

const port = Number(process.argv[2] ?? 54329);
const dataDir = process.argv[3] ?? './.pgdata';
const pg = new EmbeddedPostgres({ databaseDir: dataDir, user: 'pf', password: 'pf_dev_password', port, persistent: true, initdbFlags: ['--encoding=UTF8', '--locale=C'] });
if (!existsSync(`${dataDir}/PG_VERSION`)) await pg.initialise();
await pg.start();
try { await pg.createDatabase('pf'); } catch { /* уже существует */ }
console.log(`READY postgresql://pf:pf_dev_password@localhost:${port}/pf`);
const stop = async () => { await pg.stop(); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
setInterval(() => {}, 1 << 30);
