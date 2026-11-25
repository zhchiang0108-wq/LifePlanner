import { randomUUID } from 'node:crypto';
import { test, expect } from 'vitest';
import { request, type APIRequestContext } from 'playwright';
import pg from 'pg';
import { startApp, type RunningApp } from '../server';

test('LP-003: API validates credentials, binds new events to the session, and revokes logout', async () => {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) throw new Error('TEST_DATABASE_URL must point to a disposable PostgreSQL test database');
  const admin = new pg.Pool({ connectionString });
  const schema = `lp003_auth_${randomUUID().replaceAll('-', '')}`;
  const databaseUrl = new URL(connectionString);
  databaseUrl.searchParams.set('options', `-c search_path=${schema}`);
  const database = new pg.Pool({ connectionString: databaseUrl.toString() });
  const contexts: APIRequestContext[] = [];
  let app: RunningApp | undefined;
  let createdSchema = false;
  const credentials = { email: `a-${randomUUID()}@example.test`, password: 'LP003-test-password!42' };
  const event = { title: 'Session-owned event', start: '2026-12-02T09:00:00+08:00', end: '2026-12-02T10:00:00+08:00' };
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    createdSchema = true;
    app = await startApp({ databaseUrl: databaseUrl.toString() });
    for (let index = 0; index < 3; index++) contexts.push(await request.newContext({ baseURL: app.url }));
    const [accountA, accountB, anonymous] = contexts;

    for (const data of [{ ...credentials, email: 'invalid' }, { ...credentials, password: 'short' }]) {
      expect((await anonymous.post('/api/auth/register', { data })).status()).toBe(400);
    }
    expect((await database.query('SELECT id FROM users')).rows).toEqual([]);
    const registeredA = await accountA.post('/api/auth/register', { data: credentials });
    expect(registeredA.status()).toBe(201);
    const userA = (await registeredA.json()).user;
    expect((await anonymous.post('/api/auth/register', { data: credentials })).status()).toBe(409);
    expect((await anonymous.post('/api/auth/login', { data: { ...credentials, password: 'incorrect-password' } })).status()).toBe(401);
    expect((await anonymous.get('/api/auth/me')).status()).toBe(401);

    const registeredB = await accountB.post('/api/auth/register', { data: { ...credentials, email: `b-${randomUUID()}@example.test` } });
    expect(registeredB.status()).toBe(201);
    const userB = (await registeredB.json()).user;
    expect(userB.id).not.toBe(userA.id);
    const created = await accountB.post('/api/events', { data: { ...event, userId: userA.id } });
    expect(created.status()).toBe(201);
    const saved = await created.json();
    expect((await database.query('SELECT user_id FROM events WHERE id=$1', [saved.id])).rows).toEqual([{ user_id: userB.id }]);
    const listA = await accountA.get('/api/events');
    expect(listA.status()).toBe(200);
    expect(await listA.json()).toEqual([]);
    expect((await accountA.get(`/api/events/${saved.id}`)).status()).toBe(404);
    const listB = await accountB.get('/api/events');
    expect(listB.status()).toBe(200);
    expect(await listB.json()).toEqual([saved]);

    // Replay the original cookie after logout to prove server-side revocation.
    const cookie = (await accountB.storageState()).cookies.find(value => value.name === 'lp_session');
    expect(cookie).toBeDefined();
    expect((await accountB.post('/api/auth/logout')).status()).toBe(200);
    const headers = { Cookie: `lp_session=${cookie!.value}` };
    expect((await anonymous.get('/api/auth/me', { headers })).status()).toBe(401);
    expect((await anonymous.post('/api/events', { headers, data: event })).status()).toBe(401);
    expect((await accountA.get('/api/auth/me')).status()).toBe(200);
    expect((await database.query('SELECT id FROM events')).rows).toEqual([{ id: saved.id }]);
  } finally {
    try { await Promise.all(contexts.map(context => context.dispose())); }
    finally {
      try { await app?.close(); }
      finally {
        await database.end();
        try { if (createdSchema) await admin.query(`DROP SCHEMA "${schema}" CASCADE`); }
        finally { await admin.end(); }
      }
    }
  }
});
