import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

if (process.versions.node.split('.')[0] !== '24') throw Error('Use Node.js 24.');
const { dependencies = {}, devDependencies = {} } = JSON.parse(readFileSync('package.json', 'utf8'));
const installed = { ...dependencies, ...devDependencies };
for (const name of ['react', 'react-dom', 'express']) {
  if (!dependencies[name]) throw Error('Missing application dependency: ' + name);
}
for (const name of ['typescript', 'vitest']) {
  if (!installed[name]) throw Error('Missing development tool: ' + name);
}
if (!installed.playwright && !installed['@playwright/test']) throw Error('Missing Playwright.');
const result = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '--project', 'tsconfig.json', '--noEmit'], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
