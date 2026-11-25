import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { overlaps } from '../../src/overlaps.ts';

const minute = fc.integer({ min: -1440, max: 2880 });
const duration = fc.integer({ min: 1, max: 1440 });
const slot = fc.tuple(minute, duration).map(([start, length]) => ({ start, end: start + length }));
const runs = { numRuns: 500, ...(process.env.FC_SEED && { seed: Number(process.env.FC_SEED) }),
  ...(process.env.FC_PATH && { path: process.env.FC_PATH }) };

test('overlap is symmetric and agrees with the intersection length', () => {
  fc.assert(fc.property(slot, slot, (a, b) => {
    const intersection = Math.min(a.end, b.end) - Math.max(a.start, b.start);
    assert.equal(overlaps(a, b), intersection > 0);
    assert.equal(overlaps(a, b), overlaps(b, a));
  }), runs);
});

test('adjacent slots are conflict-free in either input order', () => {
  fc.assert(fc.property(slot, duration, (a, length) => {
    const b = { start: a.end, end: a.end + length };
    assert.equal(overlaps(a, b), false);
    assert.equal(overlaps(b, a), false);
  }), runs);
});
