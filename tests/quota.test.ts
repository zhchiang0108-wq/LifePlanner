import assert from 'node:assert/strict';
import test from 'node:test';
import { quotaState, waitForQuota } from '../scripts/quota.mjs';

const snapshot = (usedPercent: number, resetsAt = 0) => ({
  rateLimits: { limitId: 'codex', primary: { usedPercent, resetsAt, windowDurationMins: 300 } }
});

test('quota pauses at or below 10% remaining and wakes early at reset', () => {
  assert.equal(quotaState(snapshot(89)).waitMs, 0);
  assert.equal(quotaState(snapshot(90)).waitMs, 60000);
  assert.equal(quotaState(snapshot(99, 31), 1000).waitMs, 30000);
});

test('quota uses the Codex five-hour window even when it is secondary', () => {
  const primary = { windowDurationMins: 10080, usedPercent: 100 };
  const secondary = snapshot(12).rateLimits.primary;
  const result = { ...snapshot(99), rateLimitsByLimitId: { codex: { primary, secondary } } };
  assert.equal(quotaState(result).remaining, 88);
  assert.throws(() => quotaState({ rateLimits: { primary } }));
  assert.throws(() => quotaState(snapshot(NaN)));
  assert.throws(() => quotaState({ rateLimits: { limitId: 'other', primary: secondary } }));
});

test('an unavailable service and a low balance both hold the same job until recovery', async () => {
  let reads = 0;
  const waits: number[] = [];
  const paused: boolean[] = [];
  const waited = await waitForQuota(state => paused.push(Boolean(state.waitMs)), async () => {
    reads++;
    if (reads === 1) throw new Error('offline');
    return snapshot(reads === 2 ? 95 : 85);
  }, async ms => { waits.push(ms); });
  assert.equal(waited, true);
  assert.deepEqual(paused, [true, true, false]);
  assert.deepEqual(waits, [60000, 60000]);
});
