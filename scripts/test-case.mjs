import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cases = JSON.parse(readFileSync(new URL('../acceptance.json', import.meta.url), 'utf8'));
const item = cases.find(({ id }) => id === process.argv[2]);
if (!item) {
  console.error('Usage: npm run test:case -- LP-009');
  process.exitCode = 2;
} else {
  const runner = new URL('./tdd.mjs', import.meta.url);
  const result = spawnSync(process.execPath, [fileURLToPath(runner), 'verify', item.id, item.file], { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
