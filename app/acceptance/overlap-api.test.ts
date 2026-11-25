import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { request, type APIRequestContext } from 'playwright';
import pg from 'pg';
import { overlaps } from '../../src/overlaps';
import { startApp, type RunningApp } from '../server';

test('API disclosure and writes agree with the half-open interval rule', async () => {
  if (!process.env.TEST_DATABASE_URL) throw Error('Set TEST_DATABASE_URL to a disposable PostgreSQL database');
  const db = new URL(process.env.TEST_DATABASE_URL);
  const admin = new pg.Pool({ connectionString: db.href });
  const schema = 'slot_' + randomUUID().replaceAll('-', '');
  let created = false;
  let app: RunningApp | undefined;
  let api: APIRequestContext | undefined;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    db.searchParams.set('options', '-c search_path=' + schema);
    app = await startApp({ databaseUrl: db.href });
    api = await request.newContext({ baseURL: app.url });
    expect((await api.post('/api/auth/register', { data: {
      email: randomUUID() + '@example.test', password: 'overlap-boundaries!',
    } })).status()).toBe(201);
    let index = 0;
    // Separate days keep successful candidates from affecting subsequent pairs.
    for (const [start, end] of [[8, 10], [20, 30], [9, 11], [19, 21], [10, 20], [11, 19], [21, 30]]) {
      const base = Date.UTC(2026, 0, ++index);
      const input = (a: number, b: number) => ({ title: 'slot',
        start: new Date(base + a * 60_000).toISOString(), end: new Date(base + b * 60_000).toISOString() });
      expect((await api.post('/api/events', { data: input(10, 20) })).status()).toBe(201);
      const expected = overlaps({ start: 10, end: 20 }, { start, end });
      const candidate = input(start, end);
      const preview = await api.post('/api/conflicts', { data: { kind: 'tasks', input: candidate } });
      expect(preview.status()).toBe(200);
      expect((await preview.json()).conflicts.length).toBe(expected ? 1 : 0);
      const write = await api.post('/api/tasks', { data: candidate });
      expect(write.status()).toBe(expected ? 409 : 201);
    }
  } finally {
    try { await api?.dispose(); }
    finally {
      try { await app?.close(); }
      finally {
        try { if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`); }
        finally { await admin.end(); }
      }
    }
  }
});
