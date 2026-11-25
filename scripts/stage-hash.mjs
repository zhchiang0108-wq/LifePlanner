import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex');

// A completed cycle may retain its exact acceptance file when a later
// regression-test correction is pinned. In-progress cycles keep the original lock.
export function acceptedTestHash(item) {
  const current = digest(item.file);
  if (!item.testRevision) return current;
  const { acceptedFile, currentHash } = item.testRevision;
  const completed = ['red', 'green', 'refactor'].every(phase =>
    existsSync(join('evidence', item.id, phase + '.json')));
  if (!completed || current !== currentHash) throw Error('Unverified test revision: ' + item.id);
  return digest(acceptedFile);
}
