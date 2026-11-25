import test from 'node:test';
import assert from 'node:assert/strict';
import { overlaps } from '../src/overlaps.ts';
import type { Slot } from '../src/overlaps.ts';

test('LP-002: overlap boundaries report conflicts and separated slots remain conflict-free', () => {
  // Times are minutes after midnight, matching the production Slot interface.
  const existing: Slot = { start: 540, end: 600 }; // 09:00-10:00
  const scenarios: { name: string; candidate: Slot; expected: boolean }[] = [
    { name: '08:01-09:01 overlaps by one minute', candidate: { start: 481, end: 541 }, expected: true },
    { name: '09:59-10:59 overlaps by one minute', candidate: { start: 599, end: 659 }, expected: true },
    { name: '09:15-09:45 is fully contained', candidate: { start: 555, end: 585 }, expected: true },
    { name: '09:00-10:00 is identical', candidate: { start: 540, end: 600 }, expected: true },
    { name: '07:59-08:59 is separated by one minute', candidate: { start: 479, end: 539 }, expected: false },
    { name: '10:01-11:01 is separated by one minute', candidate: { start: 601, end: 661 }, expected: false },
  ];

  for (const { name, candidate, expected } of scenarios) {
    assert.equal(overlaps(existing, candidate), expected, `09:00-10:00 versus ${name}`);
    assert.equal(overlaps(candidate, existing), expected, `${name} versus 09:00-10:00 (reversed inputs)`);
  }
});
