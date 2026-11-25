import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const requireTool = createRequire(resolve('.runtime/tools/package.json'));
const { default: EmbeddedPostgres } = await import(pathToFileURL(requireTool.resolve('embedded-postgres')).href);
const { chromium } = requireTool('playwright');
const directory = resolve('.runtime/pgdata');
const keyFile = resolve('.runtime/db-password');
if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(24).toString('hex'), { flag: 'wx' });
const password = readFileSync(keyFile, 'utf8');
const port = 55432;
const pg = new EmbeddedPostgres({
  databaseDir: directory, user: 'planner', password, port, persistent: true,
  authMethod: 'scram-sha-256', postgresFlags: ['-c', 'listen_addresses=127.0.0.1']
});
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.setContent('<title>Planner setup</title>');
  if (await page.title() !== 'Planner setup') throw Error('Chromium verification failed');
} finally { await browser.close(); }

if (!existsSync(resolve(directory, 'PG_VERSION'))) await pg.initialise();
await pg.start();
try {
  const client = pg.getPgClient('postgres');
  await client.connect();
  try {
    const result = await client.query("SELECT 1 FROM pg_database WHERE datname = 'planner_test'");
    if (!result.rowCount) await client.query('CREATE DATABASE planner_test');
  } finally { await client.end(); }
  const test = pg.getPgClient('planner_test');
  await test.connect();
  try { await test.query('SELECT 1'); } finally { await test.end(); }
  console.log('Ready: Node.js, npm, Codex CLI, test PostgreSQL and Chromium.');
  if (process.argv[2] === 'run') {
    const url = 'postgresql://planner:' + password + '@127.0.0.1:' + port + '/planner_test';
    const child = spawn(process.execPath, ['scripts/loop.mjs'], {
      stdio: 'inherit', env: { ...process.env, DATABASE_URL: url, TEST_DATABASE_URL: url }
    });
    process.exitCode = await new Promise((ok, fail) => {
      child.once('error', fail);
      child.once('exit', code => ok(code ?? 1));
    });
  }
} finally { await pg.stop(); }
