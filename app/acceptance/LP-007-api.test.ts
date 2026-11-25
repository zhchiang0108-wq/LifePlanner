import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { request, type APIRequestContext } from 'playwright';
import pg from 'pg';
import { startApp, type RunningApp } from '../server';

test('LP-007: task API validates data and isolates authenticated owners', async () => {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) throw new Error('TEST_DATABASE_URL must point to a disposable PostgreSQL test database');
  const admin = new pg.Pool({ connectionString });
  const schema = `lp007_api_${randomUUID().replaceAll('-', '')}`;
  const databaseUrl = new URL(connectionString);
  databaseUrl.searchParams.set('options', `-c search_path=${schema}`);
  const contexts: APIRequestContext[] = [];
  let createdSchema = false;
  let app: RunningApp | undefined;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    createdSchema = true;
    app = await startApp({ databaseUrl: databaseUrl.toString() });
    for (let i = 0; i < 3; i++) contexts.push(await request.newContext({ baseURL: app.url }));
    const [owner, other, anonymous] = contexts;
    for (const context of [owner, other]) {
      expect((await context.post('/api/auth/register', { data: {
        email: `${randomUUID()}@example.test`, password: 'LP007-api-password!42',
      } })).status()).toBe(201);
    }
    const input = { title: '未排程研究待辦', start: null, end: null };
    expect((await anonymous.get('/api/tasks')).status()).toBe(401);
    expect((await anonymous.post('/api/tasks', { data: input })).status()).toBe(401);
    for (const data of [
      { ...input, title: ' ' }, { ...input, completed: 'yes' },
      { ...input, start: '2026-12-01T10:00:00+08:00' },
      { ...input, start: '2026-12-01T11:00:00+08:00', end: '2026-12-01T10:00:00+08:00' },
      { ...input, start: 'invalid', end: 'invalid' },
    ]) expect((await owner.post('/api/tasks', { data })).status()).toBe(400);
    expect(await (await owner.get('/api/tasks')).json()).toEqual([]);
    const created = await owner.post('/api/tasks', { data: input });
    expect(created.status()).toBe(201);
    const task = await created.json();
    expect(task).toEqual({ ...input, id: expect.any(String), completed: false });
    expect(await (await other.get('/api/tasks')).json()).toEqual([]);
    expect((await other.patch(`/api/tasks/${task.id}`, { data: { completed: true } })).status()).toBe(404);
    expect((await anonymous.patch(`/api/tasks/${task.id}`, { data: { completed: true } })).status()).toBe(401);
    expect((await owner.patch('/api/tasks/not-a-uuid', { data: { completed: true } })).status()).toBe(404);
    expect((await owner.patch(`/api/tasks/${task.id}`, { data: { end: '2026-12-01T11:00:00+08:00' } })).status()).toBe(400);
    expect(await (await owner.get('/api/tasks')).json()).toEqual([task]);
    const completed = await owner.patch(`/api/tasks/${task.id}`, { data: { completed: true } });
    expect(completed.status()).toBe(200);
    expect(await completed.json()).toEqual({ ...task, completed: true });
    expect(await (await owner.get('/api/tasks')).json()).toEqual([{ ...task, completed: true }]);
  } finally {
    try { await Promise.all(contexts.map(context => context.dispose())); }
    finally {
      try { await app?.close(); }
      finally {
        try { if (createdSchema) await admin.query(`DROP SCHEMA "${schema}" CASCADE`); }
        finally { await admin.end(); }
      }
    }
  }
});
