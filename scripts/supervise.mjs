import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { contextFile, directory, excerpt, openQuestion, pendingFile, read, reply, replyPath, writeRecord } from './handoff.mjs';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));

async function runWorker(issue, answer) {
  const env = { ...process.env, PLANNER_SUPERVISED: '1' };
  if (issue) env.PLANNER_DECISION = JSON.stringify({ scope: issue.scope, answer, question: issue.question });
  else delete env.PLANNER_DECISION;
  const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'planner.cmd --worker'], {
    env, stdio: ['inherit', 'pipe', 'pipe'], windowsHide: true
  });
  let tail = '';
  for (const [stream, output] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    stream.setEncoding('utf8');
    stream.on('data', chunk => { output.write(chunk); tail = (tail + chunk).slice(-12000); });
  }
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  return { passed: code === 0, detail: excerpt(tail.trim() || '啟動程序結束，代碼 ' + code) };
}

async function supervise() {
  // A Windows named pipe gives one supervisor per checkout and releases on exit.
  const key = createHash('sha256').update(realpathSync('.').toLowerCase()).digest('hex').slice(0, 24);
  const lock = createServer(socket => socket.end());
  await new Promise((resolve, reject) => {
    lock.once('error', reject);
    lock.listen('\\\\.\\pipe\\lifeplanner-' + key, resolve);
  });
  try {
    if (existsSync('evidence/.loop.lock')) throw Error('已有迴圈執行鎖，請檢查 planner.cmd status 及原本視窗。');
    const completion = directory + '/completed.json';
    rmSync(completion, { force: true });
    let issue = existsSync(pendingFile) ? read(pendingFile) : null;
    for (;;) {
      let answer;
      if (issue) {
        console.log('\n等待回覆 ' + issue.id + ' [' + issue.scope + ']\n' + issue.question);
        while (!existsSync(replyPath(issue))) await delay(1500);
        answer = read(replyPath(issue)).answer;
      }
      rmSync(contextFile, { force: true });
      const result = await runWorker(issue, answer).catch(e => ({ passed: false, detail: e.message }));
      if (result.passed) {
        writeRecord(completion, { verified: new Date().toISOString() });
        rmSync(pendingFile, { force: true });
        if (issue) rmSync(replyPath(issue), { force: true });
        return;
      }
      const failure = existsSync(contextFile) ? read(contextFile) : {
        scope: 'setup', question: '啟動流程中斷。請確認如何處理後再重試。\n' + result.detail
      };
      const previous = issue;
      issue = openQuestion(failure.scope, failure.question);
      if (previous) rmSync(replyPath(previous), { force: true });
    }
  } finally { lock.close(); }
}

try {
  if (process.argv[2] === '--reply') reply(process.argv[3], readFileSync(0, 'utf8').replace(/^\uFEFF/, ''));
  else if (process.argv.length === 2) await supervise();
  else throw Error('Usage: supervise.mjs [--reply ISSUE_ID < answer.txt]');
} catch (error) { console.error(error.message); process.exitCode = 1; }
