import test from 'node:test';
import assert from 'node:assert/strict';
import { overlaps } from '../src/overlaps.ts';

test('09:00-10:00 followed by 10:00-11:00 is conflict-free', () => {
  assert.equal(overlaps({ start: 540, end: 600 }, { start: 600, end: 660 }), false);
});
