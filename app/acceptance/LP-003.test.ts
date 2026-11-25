import { randomUUID } from 'node:crypto';
import { test, expect } from 'vitest';
import { chromium, type Page, type Response } from 'playwright';
import pg from 'pg';
import { startApp, type RunningApp } from '../server';

test('LP-003: UI accounts persist in PostgreSQL across sessions and deny another account access', async () => {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) throw new Error('TEST_DATABASE_URL must point to a disposable PostgreSQL test database');
  const admin = new pg.Pool({ connectionString });
  const schema = `lp003_${randomUUID().replaceAll('-', '')}`;
  const databaseUrl = new URL(connectionString);
  databaseUrl.searchParams.set('options', `-c search_path=${schema}`);
  const database = new pg.Pool({ connectionString: databaseUrl.toString() });
  let app: RunningApp | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let createdSchema = false;
  const password = 'LP003-test-password!42';
  const accountA = `a-${randomUUID()}@example.test`;
  const accountB = `b-${randomUUID()}@example.test`;
  const event = { title: 'LP-003 私人研究行程', start: '2026-12-01T09:00:00+08:00', end: '2026-12-01T10:00:00+08:00' };

  const apiResponse = (page: Page, path: string, method: string) => page.waitForResponse(
    response => new URL(response.url()).pathname === path && response.request().method() === method,
  );
  const jsonBody = async (response: Response, status: number) => {
    expect(response.status(), `${response.request().method()} ${response.url()}`).toBe(status);
    return response.json();
  };
  async function authenticate(page: Page, mode: 'register' | 'login', email: string) {
    await page.goto(`${app!.url}/${mode}`);
    await page.getByLabel('電子郵件', { exact: true }).fill(email);
    await page.getByLabel('密碼', { exact: true }).fill(password);
    const response = apiResponse(page, `/api/auth/${mode}`, 'POST');
    await page.getByRole('button', { name: mode === 'register' ? '註冊' : '登入', exact: true }).click();
    const body = await jsonBody(await response, mode === 'register' ? 201 : 200);
    expect(body.user.email).toBe(email);
    return body.user;
  }

  try {
    // Fail environment setup as an error, never misreport it as the product red.
    await admin.query('SELECT 1');
    await admin.query(`CREATE SCHEMA "${schema}"`);
    createdSchema = true;
    app = await startApp({ databaseUrl: databaseUrl.toString() });
    browser = await chromium.launch();
    const firstContext = await browser.newContext({ timezoneId: 'Asia/Taipei' });
    const first = await firstContext.newPage();
    const landing = await first.goto(`${app.url}/register`);
    expect(landing?.status(), 'The real account UI must be served').toBe(200);

    const userA = await authenticate(first, 'register', accountA);
    await firstContext.clearCookies();
    const loggedInA = await authenticate(first, 'login', accountA);
    expect(loggedInA.id).toBe(userA.id);
    await first.goto(app.url);
    await first.getByLabel('行程名稱', { exact: true }).fill(event.title);
    await first.getByLabel('開始時間', { exact: true }).fill('2026-12-01T09:00');
    await first.getByLabel('結束時間', { exact: true }).fill('2026-12-01T10:00');
    const create = apiResponse(first, '/api/events', 'POST');
    await first.getByRole('button', { name: '儲存行程', exact: true }).click();
    const saved = await jsonBody(await create, 201);
    expect(saved.id).toBeTruthy();
    expect(saved.title).toBe(event.title);
    await expect.poll(() => first.getByTestId(`event-${saved.id}`).textContent()).toContain(event.title);

    // Inspect real PostgreSQL rows, independent of UI/API representations.
    const persistedUsers = await database.query('SELECT id, email FROM users WHERE email = $1', [accountA]);
    expect(persistedUsers.rows).toEqual([{ id: userA.id, email: accountA }]);
    async function assertStoredEvent() {
      const result = await database.query(
        'SELECT id, user_id, title, starts_at, ends_at FROM events WHERE id = $1', [saved.id],
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toMatchObject({ id: saved.id, user_id: userA.id, title: event.title });
      expect(new Date(result.rows[0].starts_at).toISOString()).toBe(new Date(event.start).toISOString());
      expect(new Date(result.rows[0].ends_at).toISOString()).toBe(new Date(event.end).toISOString());
    }
    await assertStoredEvent();
    await firstContext.close();
    await app.close();
    app = undefined;
    app = await startApp({ databaseUrl: databaseUrl.toString() });

    // New browser context and restarted server exclude shared local state/cache.
    const secondContext = await browser.newContext({ timezoneId: 'Asia/Taipei' });
    const second = await secondContext.newPage();
    expect((await authenticate(second, 'login', accountA)).id).toBe(userA.id);
    await second.goto(app.url);
    await second.reload();
    await expect.poll(() => second.getByTestId(`event-${saved.id}`).textContent()).toContain(event.title);
    const ownRead = await secondContext.request.get(`${app.url}/api/events/${saved.id}`);
    expect(ownRead.status()).toBe(200);
    expect(await ownRead.json()).toMatchObject({ id: saved.id, title: event.title });

    const otherContext = await browser.newContext({ timezoneId: 'Asia/Taipei' });
    const other = await otherContext.newPage();
    const userB = await authenticate(other, 'register', accountB);
    expect(userB.id).not.toBe(userA.id);
    await otherContext.clearCookies();
    expect((await authenticate(other, 'login', accountB)).id).toBe(userB.id);
    const storedB = await database.query('SELECT id FROM users WHERE email = $1', [accountB]);
    expect(storedB.rows).toEqual([{ id: userB.id }]);
    await other.goto(app.url);
    const otherUiList = apiResponse(other, '/api/events', 'GET');
    await other.reload();
    expect(await jsonBody(await otherUiList, 200)).toEqual([]);
    expect(await other.getByTestId(`event-${saved.id}`).count()).toBe(0);
    const list = await otherContext.request.get(`${app.url}/api/events`);
    expect(list.status()).toBe(200);
    expect(await list.json()).toEqual([]);
    const forgedList = await otherContext.request.get(`${app.url}/api/events?userId=${encodeURIComponent(userA.id)}`);
    expect(forgedList.status()).toBe(200);
    expect(await forgedList.json()).toEqual([]);

    const target = `${app.url}/api/events/${encodeURIComponent(saved.id)}`;
    const deniedRead = await otherContext.request.get(target);
    expect([403, 404]).toContain(deniedRead.status());
    expect(await deniedRead.text()).not.toContain(event.title);
    const deniedUpdate = await otherContext.request.patch(target, {
      data: { ...event, title: 'B 不得修改', userId: userA.id },
    });
    expect([403, 404]).toContain(deniedUpdate.status());
    await assertStoredEvent();
    const deniedDelete = await otherContext.request.delete(target);
    expect([403, 404]).toContain(deniedDelete.status());
    await assertStoredEvent();
    await second.reload();
    await expect.poll(() => second.getByTestId(`event-${saved.id}`).textContent()).toContain(event.title);

    // Unauthenticated requests must not inherit either account's privileges.
    const anonymous = await browser.newContext();
    expect((await anonymous.request.get(target)).status()).toBe(401);
    expect((await anonymous.request.post(`${app.url}/api/events`, { data: event })).status()).toBe(401);
  } finally {
    try { await browser?.close(); }
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
