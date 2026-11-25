import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
const [phase, id, input] = process.argv.slice(2);
const allowed = ['red', 'green', 'refactor'];

function run(args) {
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status === null) throw result.error ?? Error('Test runner interrupted');
  return result;
}

function check() {
  if (existsSync('evidence/LP-003/green.json') || (id === 'LP-003' && ['green', 'refactor'].includes(phase))) {
    const stack = run(['scripts/check-stack.mjs']);
    process.stdout.write(stack.stdout + stack.stderr);
    if (stack.status) throw Error('Product stack or TypeScript check failed. See TECH_STACK.md.');
  }
  if (existsSync('package.json')) {
    const result = spawnSync('npm test', { stdio: 'inherit', shell: true });
    if (result.error || result.status !== 0) throw Error('npm test failed or could not start');
  } else {
    const unit = run(['--test', 'tests/*.test.ts']);
    process.stdout.write(unit.stdout + unit.stderr);
    if (unit.status) throw Error('Node regression tests failed');
  }
}

function focus(file) {
  if (file.startsWith('tests/')) {
    const r = run(['--test', '--test-reporter=./scripts/result-reporter.mjs', file]);
    const cases = r.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    return { exit: r.status, cases, stderr: r.stderr };
  }
  const vitest = 'node_modules/vitest/vitest.mjs';
  if (!existsSync(vitest)) {
    throw Error('Project Vitest is missing. Run npm install --include=dev in LifePlanner-TDD, then restart planner.cmd run.');
  }
  const out = mkdtempSync(join(tmpdir(), 'planner-vitest-'));
  try {
    const report = join(out, 'report.json');
    const r = run([vitest, 'run', file, '--reporter=json', '--outputFile', report]);
    if (!existsSync(report)) throw Error('Vitest did not produce results.\n' + r.stderr + r.stdout);
    const data = JSON.parse(readFileSync(report, 'utf8'));
    const suites = data.testResults ?? [];
    const loadErrors = suites.filter(s => s.status === 'failed' && !s.assertionResults?.length);
    if (loadErrors.length || !suites.length) {
      const details = loadErrors.map(s => s.message || s.name).concat(r.stderr, r.stdout).filter(Boolean);
      throw Error('Vitest did not execute the test cases.\n' + details.join('\n'));
    }
    const cases = suites.flatMap(s => s.assertionResults.map(a => ({
      name: a.fullName, passed: a.status === 'passed', code: a.failureMessages?.some(m => /AssertionError/.test(m)) ? 'ERR_ASSERTION' : null,
      message: a.failureMessages?.join('\n')
    })));
    return { exit: r.status, cases, stderr: r.stderr };
  } finally { rmSync(out, { recursive: true, force: true }); }
}

function cycle() {
  if (!allowed.includes(phase) || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id ?? '') || !input)
    throw Error('Usage: node scripts/tdd.mjs red|green|refactor CASE-ID test-file');
  const file = relative(process.cwd(), resolve(input)).replaceAll('\\', '/');
  if (file.startsWith('../') || isAbsolute(file) || !file.endsWith('.test.ts')) throw Error('Use a project .test.ts file');
  const dir = join('evidence', id);
  mkdirSync(dir, { recursive: true });
  const destination = join(dir, phase + '.json');
  if (existsSync(destination)) throw Error('This phase already has evidence. Use a new ID for a new cycle.');
  const hash = createHash('sha256').update(readFileSync(file)).digest('hex');
  const previous = allowed[allowed.indexOf(phase) - 1];
  let expected;
  if (previous) {
    const prior = JSON.parse(readFileSync(join(dir, previous + '.json'), 'utf8'));
    if (prior.file !== file || prior.hash !== hash) throw Error('The acceptance test changed. Review the change and start a new cycle.');
    expected = prior.expected;
  }
  const result = focus(file);
  console.log(JSON.stringify(result, null, 2));
  const failures = result.cases.filter(c => !c.passed);
  const baseline = phase === 'red' && process.argv.includes('--allow-existing') &&
    result.exit === 0 && failures.length === 0 && result.cases.length > 0;
  if (phase === 'red') {
    if (!baseline && (result.exit !== 1 || failures.length !== 1 || failures[0].code !== 'ERR_ASSERTION'))
      throw Error('RED needs exactly one failing assertion. Review the output.');
    expected = (baseline ? result.cases[0] : failures[0]).name;
  } else {
    if (result.exit !== 0 || failures.length || !result.cases.some(c => c.name === expected && c.passed))
      throw Error('The original failing case must run and pass.');
    check();
  }
  writeFileSync(destination, JSON.stringify({ phase, baseline, id, time: new Date().toISOString(), file, hash, expected, result }, null, 2) + '\n', { flag: 'wx' });
  console.log('Saved ' + destination);
}
try {
  if (phase === 'check') check();
  else if (phase === 'verify') {
    const result = focus(input);
    if (result.exit || !result.cases.length || result.cases.some(c => !c.passed))
      throw Error('Final acceptance failed: ' + input + '\n' + JSON.stringify(result));
    console.log(id + ': ' + result.cases.length + ' passed (' + input + ')');
  } else cycle();
}
catch (error) { console.error(error.message); process.exitCode = 1; }
