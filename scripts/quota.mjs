import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

const reserve = 10;
const pollInterval = 60000;

export function readQuota() {
  return new Promise((resolve, reject) => {
    const command = process.env.CODEX_BIN || (process.platform === 'win32' ? 'codex.exe' : 'codex');
    const child = spawn(command, ['app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true
    });
    const lines = createInterface({ input: child.stdout });
    const timeout = setTimeout(() => finish(new Error('查詢 Codex 額度逾時')), 20000);
    let done = false;
    function finish(error, result) {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      lines.close();
      child.stdin.end();
      child.kill();
      if (error) reject(error);
      else resolve(result);
    }
    const send = value => child.stdin.write(JSON.stringify(value) + '\n');
    child.once('error', error => finish(error));
    child.stdin.on('error', error => finish(error));
    child.once('close', () => finish(new Error('Codex 額度查詢程序提前結束')));
    lines.on('line', line => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.id !== 1 && msg.id !== 2) return;
      if (msg.error) return finish(new Error('Codex 額度服務查詢失敗（' + msg.error.code + '）'));
      if (msg.id === 1) {
        send({ method: 'initialized' });
        send({ id: 2, method: 'account/rateLimits/read', params: {} });
      } else finish(null, msg.result);
    });
    send({ id: 1, method: 'initialize', params: {
      clientInfo: { name: 'lifeplanner', version: '1.0' }, capabilities: {}
    } });
  });
}

export function quotaState(result, now = Date.now()) {
  const bucket = result?.rateLimitsByLimitId?.codex ?? result?.rateLimits;
  const window = [bucket?.primary, bucket?.secondary].find(w => w?.windowDurationMins === 300);
  if ((bucket?.limitId && bucket.limitId !== 'codex') || !window ||
      !Number.isFinite(window.usedPercent) || window.usedPercent < 0 || window.usedPercent > 100)
    throw new Error('無法取得 Codex 的五小時額度');
  const remaining = 100 - window.usedPercent;
  const resetMs = window.resetsAt * 1000;
  const waitMs = remaining > reserve ? 0 :
    Math.min(pollInterval, resetMs > now ? Math.max(1000, resetMs - now) : pollInterval);
  return { remaining, waitMs };
}

export async function waitForQuota(report, query = readQuota, sleep = delay) {
  let waited = false;
  for (;;) {
    let state;
    try { state = quotaState(await query()); }
    catch (error) { state = { waitMs: pollInterval, reason: error.message }; }
    report(state);
    if (!state.waitMs) return waited;
    waited = true;
    await sleep(state.waitMs);
  }
}
