import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contextFile, directory, excerpt, pendingFile, read as readRecord, replyPath, writeRecord } from './handoff.mjs';
import { waitForQuota } from './quota.mjs';
import { acceptedTestHash } from './stage-hash.mjs';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const plan = read('acceptance.json');
const phases = ['red', 'green', 'refactor'];
const base = 'evidence';
const lock = join(base, '.loop.lock');
const quotaFile = join(directory, 'quota.json');
let scope = 'workflow';
let failure = '';
const decision = process.env.PLANNER_DECISION ? JSON.parse(process.env.PLANNER_DECISION) : null;

function stage(item) {
  for (const phase of phases) {
    const file = join(base, item.id, phase + '.json');
    if (!existsSync(file)) return phase;
    const record = read(file);
    if (record.file !== item.file || record.id !== item.id || record.phase !== phase ||
        record.hash !== acceptedTestHash(item)) throw Error('Evidence/test mismatch: ' + file);
  }
  return 'done';
}

let checkedManifest;
function ensureDependencies() {
  if (!existsSync('package.json')) return;
  const hash = digest('package.json');
  if (checkedManifest === hash) return;
  const installed = spawnSync('npm ls --depth=0 --include=dev', { shell: true, stdio: 'ignore' });
  if (installed.status !== 0 || !existsSync('package-lock.json')) {
    console.log('Installing dependencies declared by the current package.json...');
    const result = spawnSync('npm install --include=dev --no-audit --no-fund',
      { shell: true, stdio: 'inherit' });
    if (result.status !== 0) throw Error('Dependency installation failed. Resolve the npm error and resume with planner.cmd run.');
  }
  checkedManifest = hash;
}

function node(args) {
  ensureDependencies();
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const output = [r.stdout, r.stderr, r.error?.message].filter(Boolean).join('\n');
  console.log(output);
  failure = r.status === 0 ? '' : excerpt(output || 'Test runner interrupted');
  return r.status === 0;
}

async function checkQuota() {
  return waitForQuota(state => {
    const reason = state.reason || '五小時額度剩餘 ' + state.remaining + '%';
    writeRecord(quotaFile, { scope, reason, paused: Boolean(state.waitMs), checked: new Date().toISOString() });
    if (state.waitMs) console.log(scope, reason, '暫停派工，稍後自動重查。');
  });
}

async function agent(task) {
  const command = process.env.CODEX_BIN || (process.platform === 'win32' ? 'codex.exe' : 'codex');
  mkdirSync(directory, { recursive: true });
  const message = join(directory, 'agent-last.txt');
  if (existsSync(message)) unlinkSync(message);
  const prompt = [readFileSync('TECH_STACK.md', 'utf8'), task,
    '一般錯誤直接修復。若遇到需要決定的規格、破壞性變更、權限或帳戶問題，先停止修改。最後回覆單獨一行以 NEEDS_USER: 開頭，用繁體中文寫一個具體問題與可選做法。請勿用此標記回報一般成功。',
    failure && '以下是外層驗證輸出，僅用於診斷：\n' + failure,
    decision?.scope === scope && '使用者對這個問題的回覆：\n' + decision.question + '\n答覆：' + decision.answer
  ].filter(Boolean).join('\n\n');
  await checkQuota();
  for (;;) {
    const result = spawnSync(command, ['exec', '--sandbox', 'workspace-write', '--skip-git-repo-check', '-o', message, '-'], {
      input: prompt, stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true
    });
    if (result.error) throw result.error;
    if (result.status === 0) break;
    if (!await checkQuota()) throw Error('Codex exec failed. Resume after resolving its error.');
  }
  const question = existsSync(message) && readFileSync(message, 'utf8').match(/^NEEDS_USER[:：]\s*(.+)$/m);
  if (question) throw Error(question[1]);
}

async function work(item, phase, retry) {
  const guidance = {
    red: '先寫能從指定層級驗收需求的整合情境測試，可有多個斷言。第一項已有測試。只建立測試及必要測試環境或介面，不先完成行為。若功能已存在，保留真實通過的測試，由腳本記錄基線。不要故意破壞功能。',
    green: '依原測試及需求實作完整功能，接上正式入口並自行跑測試修正回歸。從第三項起使用 React/TS、Express、PostgreSQL、Vitest。UI 行為使用瀏覽器操作或元件整合測試。可用 npm 安裝專案依賴，提供 package-lock、npm test 及測試資料庫啟動方式，CI 可執行相同測試。',
    refactor: '檢視 diff 及案例，改善必要的重複或命名，確認所有驗收點已覆蓋且能從正常入口使用。有遺漏就補獨立測試及實作，保留已鎖定的測試。如果無須重構，直接說明。'
  };
  await agent(['你是單人 Life Planner 專題的開發助手。讀取 BACKLOG.md、AGENTS.md、README.md。',
    item.id + ' ' + item.title + '；驗收條件：' + item.accept,
    '目前階段 ' + phase + '；本項固定測試檔 ' + item.file, guidance[phase],
    '外層執行器負責執行 tdd、迴圈和寫證據。不要執行這些指令，不可改 scripts/、acceptance.json、既有證據或降低驗收標準。不要推送或部署。',
    retry ? '上次階段驗證失敗。自行重跑目標測試，找出錯誤再修正。' : ''
  ].join('\n'));
}

async function execute() {
  for (const item of plan) {
    let phase;
    scope = item.id;
    while ((phase = stage(item)) !== 'done') {
      scope = item.id + '/' + phase;
      failure = '';
      // An interrupted Green may already have a complete implementation on disk.
      if (phase === 'green' && node(['scripts/tdd.mjs', phase, item.id, item.file])) continue;
      let passed = false;
      for (let attempt = 0; attempt < 3 && !passed; attempt++) {
        console.log(item.id, item.title, phase, 'attempt', attempt + 1);
        if (!(phase === 'red' && existsSync(item.file) && attempt === 0))
          await work(item, phase, attempt > 0);
        passed = node(['scripts/tdd.mjs', phase, item.id, item.file, '--allow-existing']);
      }
      if (!passed) throw Error('三次階段驗證仍失敗。請指定下一步，或修復環境後回覆「重試」。\n' + failure);
    }
  }
  for (let attempt = 1; ; attempt++) {
    scope = 'final';
    failure = '';
    const ready = existsSync('package-lock.json') && existsSync('package.json');
    const failed = ready && plan.find(item => !node(['scripts/tdd.mjs', 'verify', item.id, item.file]));
    if (ready && !failed && node(['scripts/tdd.mjs', 'check'])) break;
    const reason = !ready ? 'Application setup incomplete' : failed ? 'Failed: ' + failed.id : 'Full regression failed';
    if (attempt === 3) throw Error(reason + '\n請確認下一步或回覆修復方式。\n' + failure);
    await agent(reason + '。修正正式專案的環境、實作或回歸問題。保留既有測試與證據。不要執行迴圈或修改外層腳本。');
  }
  console.log('Automated acceptance passed. Complete the physical Windows/Android checks in README.md.');
}

try {
  if (process.argv[2] === '--status') {
    for (const item of plan) console.log(item.id, stage(item), item.title);
    if (existsSync(quotaFile)) {
      const quota = readRecord(quotaFile);
      console.log('最近額度檢查', quota.checked, quota.scope, quota.reason, quota.paused ? '暫停派工' : '可派工');
    }
    if (existsSync(pendingFile)) {
      const issue = readRecord(pendingFile);
      console.log(existsSync(replyPath(issue)) ? '已回覆' : '等待回覆', issue.id, issue.scope, issue.question);
    }
  } else if (process.argv.length === 2) {
    mkdirSync(base, { recursive: true });
    writeFileSync(lock, String(process.pid), { flag: 'wx' });
    try { await execute(); }
    catch (error) {
      if (process.env.PLANNER_SUPERVISED === '1') writeRecord(contextFile, { scope, question: excerpt(error.message) });
      throw error;
    } finally { unlinkSync(lock); }
  } else throw Error('Usage: node scripts/loop.mjs [--status]');
} catch (err) { console.error(err.message); process.exitCode = 1; }
