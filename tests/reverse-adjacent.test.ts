import test from 'node:test';
import assert from 'node:assert/strict';
import { overlaps } from '../src/overlaps.ts';

test('a candidate ending exactly when the existing slot starts is conflict-free', () => {
  assert.equal(overlaps({ start: 600, end: 660 }, { start: 540, end: 600 }), false);
});
