import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acceptedTestHash } from './stage-hash.mjs';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const lock = 'evidence/.loop.lock';

function nextStage() {
  for (const item of read('acceptance.json')) {
    for (const phase of ['red', 'green', 'refactor']) {
      const path = join('evidence', item.id, phase + '.json');
      if (!existsSync(path)) return { ...item, phase, path };
      const record = read(path);
      const hash = acceptedTestHash(item);
      if (record.hash !== hash || record.file !== item.file || record.id !== item.id || record.phase !== phase) {
        throw Error('Evidence/test mismatch: ' + path);
      }
    }
  }
}

function main() {
  let [action = 'status', requestedId, requestedPhase, baseline] = process.argv.slice(2);
  if (action === 'ci') {
    if (process.env.GITHUB_EVENT_NAME === 'push') {
      const ref = /^tdd\/(LP-[0-9]{3})\/(red|green|refactor)$/.exec(process.env.GITHUB_REF_NAME ?? '');
      if (!ref) throw Error('Invalid stage branch');
      [, requestedId, requestedPhase] = ref;
    } else if (process.env.GITHUB_EVENT_NAME === 'workflow_dispatch') {
      requestedId = process.env.CASE_ID;
      requestedPhase = process.env.PHASE;
      if (process.env.ALLOW_EXISTING === 'true') baseline = '--allow-existing';
    } else throw Error('Unsupported stage event');
    action = 'run';
  }
  const next = nextStage();
  if (action === 'status') {
    console.log(JSON.stringify({ next: next ?? null, checkoutLocked: existsSync(lock) }, null, 2));
    return;
  }
  if (action === 'import') {
    if (!next) throw Error('All stages already have evidence');
    // The caller supplies a downloaded artifact from the successful Actions run
    // it verified. Bind it to this exact, clean checkout before adding evidence.
    const [directory, repository, runId, attempt] = process.argv.slice(3);
    if (!directory || !repository || !runId || !attempt) throw Error('Expected artifact directory, repository, run ID and attempt');
    if (existsSync(lock)) throw Error('Checkout already has a writer');
    const git = (...args) => {
      const result = spawnSync('git', args, { encoding: 'utf8' });
      if (result.status !== 0) throw Error('A Git checkout of the verified commit is required');
      return result.stdout.trim();
    };
    if (git('status', '--porcelain', '--untracked-files=all')) throw Error('Import requires a clean checkout');
    const source = read(join(directory, 'source.json'));
    const record = read(join(directory, 'evidence.json'));
    const hash = createHash('sha256').update(readFileSync(next.file)).digest('hex');
    if (source.repository !== repository || source.commit !== git('rev-parse', 'HEAD') ||
        source.runId !== runId || source.attempt !== attempt ||
        [source, record].some(r => r.id !== next.id || r.phase !== next.phase || r.file !== next.file || r.hash !== hash)) {
      throw Error('Artifact does not match the verified run, checkout, or next acceptance stage');
    }
    mkdirSync(dirname(next.path), { recursive: true });
    writeFileSync(lock, String(process.pid), { flag: 'wx' });
    try {
      writeFileSync(next.path, JSON.stringify({ ...record, source }, null, 2) + '\n', { flag: 'wx' });
    } finally { unlinkSync(lock); }
    console.log('Imported ' + next.path);
    return;
  }
  if (action !== 'run' || !next || next.id !== requestedId || next.phase !== requestedPhase) {
    throw Error('Requested stage does not match current evidence. Next: ' + (next ? next.id + '/' + next.phase : 'none'));
  }
  mkdirSync('evidence', { recursive: true });
  writeFileSync(lock, String(process.pid), { flag: 'wx' });
  try {
    const args = ['scripts/tdd.mjs', next.phase, next.id, next.file];
    if (next.phase === 'red' && baseline === '--allow-existing') args.push('--allow-existing');
    const child = spawnSync(process.execPath, args, { stdio: 'inherit' });
    if (child.error) throw child.error;
    if (child.status !== 0) throw Error('Stage verification failed');
    if (process.env.GITHUB_ACTIONS === 'true') {
      const record = read(next.path);
      const dir = 'test-results/stage';
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'evidence.json'), JSON.stringify(record, null, 2) + '\n');
      writeFileSync(join(dir, 'source.json'), JSON.stringify({
        repository: process.env.GITHUB_REPOSITORY, commit: process.env.GITHUB_SHA,
        runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT,
        id: next.id, phase: next.phase, file: next.file, hash: record.hash,
      }, null, 2) + '\n');
    }
  } finally { unlinkSync(lock); }
}

try { main(); }
catch (error) {
  console.error(error.code === 'EEXIST' && error.path === lock ? 'Checkout already has a writer' : error.message);
  process.exitCode = 1;
}
