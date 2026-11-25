import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { chromium, errors, type Locator, type Page } from 'playwright';
import pg from 'pg';
import { startApp, type RunningApp } from '../server';
import type { PlannerEvent } from '../shared';

// Green integration contract, exercised only through the real product:
// - A 待辦編輯 region contains 待辦名稱, optional 開始時間/結束時間,
//   and 儲存待辦. Both times blank creates an unscheduled task.
// - 未排程待辦 is a separate region. task-<id> rows have an 編輯待辦
//   button and 已完成 checkbox. Scheduled rows join existing 日/週行程清單
//   li rows in chronological order, retaining these task controls.
// - POST/PATCH /api/tasks returns { id, title, start, end, completed };
//   GET /api/tasks lists the authenticated user's tasks. Unscheduled times
//   are null. Production request/response types belong in shared.ts at Green.
// - PostgreSQL tasks(id, user_id, title, starts_at, ends_at, completed)
//   persists the same task across scheduling and completion (no copied event).
// This test declares the boundary, without implementing it or seeding via SQL.
interface TaskSnapshot {
  id: string;
  title: string;
  start: string | null;
  end: string | null;
  completed: boolean;
}

test('LP-007: create an unscheduled task, schedule among events, and persist completion across independent sessions', async () => {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) throw new Error('TEST_DATABASE_URL must point to a disposable PostgreSQL test database');
  const admin = new pg.Pool({ connectionString });
  const schema = `lp007_${randomUUID().replaceAll('-', '')}`;
  const databaseUrl = new URL(connectionString);
  databaseUrl.searchParams.set('options', `-c search_path=${schema}`);
  const database = new pg.Pool({ connectionString: databaseUrl.toString() });
  let createdSchema = false;
  let app: RunningApp | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const email = `lp007-${randomUUID()}@example.test`;
  const password = 'LP007-test-password!42';
  const date = '2026-12-01';
  const title = '整理研究筆記';
  const iso = (hour: string) => new Date(`${date}T${hour}:00+08:00`).toISOString();
  async function visible(locator: Locator) {
    try { await locator.waitFor({ state: 'visible', timeout: 5_000 }); }
    catch (error) { if (!(error instanceof errors.TimeoutError)) throw error; }
    // A missing product control must yield an assertion, not a click timeout.
    expect(await locator.isVisible(), `Expected visible LP-007 UI: ${locator}`).toBe(true);
  }
  try {
    await admin.query('SELECT 1');
    await admin.query(`CREATE SCHEMA "${schema}"`);
    createdSchema = true;
    app = await startApp({ databaseUrl: databaseUrl.toString() });
    browser = await chromium.launch();
    const desktop = await browser.newContext({ timezoneId: 'Asia/Taipei', viewport: { width: 1280, height: 900 } });
    const mobile = await browser.newContext({ timezoneId: 'Asia/Taipei', viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
    const a = await desktop.newPage();
    const b = await mobile.newPage();
    async function authenticate(page: Page, mode: 'register' | 'login') {
      await page.goto(`${app!.url}/${mode}`);
      await page.getByLabel('電子郵件', { exact: true }).fill(email);
      await page.getByLabel('密碼', { exact: true }).fill(password);
      const pending = page.waitForResponse(r => new URL(r.url()).pathname === `/api/auth/${mode}` && r.request().method() === 'POST');
      await page.getByRole('button', { name: mode === 'register' ? '註冊' : '登入', exact: true }).click();
      const response = await pending;
      expect(response.status()).toBe(mode === 'register' ? 201 : 200);
      const { user } = await response.json();
      await page.goto(app!.url);
      return user.id as string;
    }
    const userId = await authenticate(a, 'register');
    expect(await authenticate(b, 'login')).toBe(userId);

    async function createEvent(eventTitle: string, start: string, end: string) {
      await a.getByLabel('行程名稱', { exact: true }).fill(eventTitle);
      // Scope existing event inputs so the task editor can reuse time labels.
      const form = a.locator('form').filter({ has: a.getByLabel('行程名稱', { exact: true }) });
      await form.getByLabel('開始時間', { exact: true }).fill(`${date}T${start}`);
      await form.getByLabel('結束時間', { exact: true }).fill(`${date}T${end}`);
      const pending = a.waitForResponse(r => new URL(r.url()).pathname === '/api/events' && r.request().method() === 'POST');
      await form.getByRole('button', { name: '儲存行程', exact: true }).click();
      const response = await pending;
      expect(response.status()).toBe(201);
      const event: PlannerEvent = await response.json();
      await expect.poll(() => form.getByLabel('行程名稱', { exact: true }).inputValue()).toBe('');
      return event;
    }
    // Reverse insertion order catches lists that append tasks or sort by creation.
    const later = await createEvent('午前討論', '11:00', '12:00');
    const earlier = await createEvent('閱讀論文', '09:00', '10:00');
    const editor = a.getByRole('region', { name: '待辦編輯', exact: true });
    await visible(editor);
    await editor.getByLabel('待辦名稱', { exact: true }).fill(title);
    expect(await editor.getByLabel('開始時間', { exact: true }).inputValue()).toBe('');
    expect(await editor.getByLabel('結束時間', { exact: true }).inputValue()).toBe('');
    const created = a.waitForResponse(r => new URL(r.url()).pathname === '/api/tasks' && r.request().method() === 'POST');
    await editor.getByRole('button', { name: '儲存待辦', exact: true }).click();
    const createResponse = await created;
    expect(createResponse.status()).toBe(201);
    const task: TaskSnapshot = await createResponse.json();
    expect(typeof task.id).toBe('string');
    expect(task.id.length).toBeGreaterThan(0);
    expect(task).toMatchObject({ title, start: null, end: null, completed: false });

    async function verify(scheduled: boolean, completed: boolean) {
      const expected = { id: task.id, title, start: scheduled ? iso('10:00') : null, end: scheduled ? iso('11:00') : null, completed };
      for (const page of [a, b]) {
        const loaded = page.waitForResponse(r => new URL(r.url()).pathname === '/api/tasks' && r.request().method() === 'GET');
        await page.reload();
        expect((await loaded).status()).toBe(200);
        const response = await page.request.get(`${app!.url}/api/tasks`);
        expect(response.status()).toBe(200);
        const tasks = await response.json();
        expect(tasks).toHaveLength(1);
        expect(tasks[0]).toMatchObject(expected);
        const unscheduled = page.getByRole('region', { name: '未排程待辦', exact: true });
        await visible(unscheduled);
        const unscheduledRow = unscheduled.getByTestId(`task-${task.id}`);
        if (!scheduled) {
          await visible(unscheduledRow);
          expect(await unscheduledRow.innerText()).toContain(title);
          expect(await unscheduledRow.getByRole('checkbox', { name: '已完成', exact: true }).isChecked()).toBe(false);
        } else {
          expect(await unscheduledRow.count()).toBe(0);
        }
        for (const view of ['日', '週'] as const) {
          await page.getByRole('button', { name: view, exact: true }).click();
          await page.getByLabel('日期', { exact: true }).fill(date);
          const list = page.getByRole('region', { name: `${view}行程清單`, exact: true });
          await visible(list);
          const group = view === '週' ? list.getByRole('group', { name: date, exact: true }) : list;
          const ids = scheduled ? [`event-${earlier.id}`, `task-${task.id}`, `event-${later.id}`] : [`event-${earlier.id}`, `event-${later.id}`];
          await expect.poll(() => group.locator('li[data-testid]').evaluateAll(rows => rows.map(row => row.getAttribute('data-testid')))).toEqual(ids);
          expect(await list.getByTestId(`task-${task.id}`).count()).toBe(scheduled ? 1 : 0);
          if (scheduled) {
            const row = group.getByTestId(`task-${task.id}`);
            const text = (await row.innerText()).replace(/\s+/g, ' ');
            expect(text).toContain(title);
            expect(text).toContain(`${date} 10:00`);
            expect(text).toContain(`${date} 11:00`);
            expect(await row.getByRole('checkbox', { name: '已完成', exact: true }).isChecked()).toBe(completed);
          }
        }
      }
      const stored = await database.query('SELECT id, user_id, title, starts_at, ends_at, completed FROM tasks WHERE user_id=$1', [userId]);
      expect(stored.rows).toHaveLength(1);
      const row = stored.rows[0];
      expect(row).toMatchObject({ id: task.id, user_id: userId, title, completed });
      expect(row.starts_at === null ? null : new Date(row.starts_at).toISOString()).toBe(expected.start);
      expect(row.ends_at === null ? null : new Date(row.ends_at).toISOString()).toBe(expected.end);
      // Scheduling/completing a task must not duplicate it as an ordinary event.
      const events = await database.query('SELECT id FROM events WHERE user_id=$1 ORDER BY id', [userId]);
      expect(events.rows.map(row => row.id).sort()).toEqual([earlier.id, later.id].sort());
    }
    await verify(false, false);
    await a.getByRole('region', { name: '未排程待辦', exact: true }).getByTestId(`task-${task.id}`)
      .getByRole('button', { name: '編輯待辦', exact: true }).click();
    expect(await editor.getByLabel('待辦名稱', { exact: true }).inputValue()).toBe(title);
    await editor.getByLabel('開始時間', { exact: true }).fill(`${date}T10:00`);
    await editor.getByLabel('結束時間', { exact: true }).fill(`${date}T11:00`);
    const scheduled = a.waitForResponse(r => new URL(r.url()).pathname === `/api/tasks/${task.id}` && r.request().method() === 'PATCH');
    await editor.getByRole('button', { name: '儲存待辦', exact: true }).click();
    const scheduleResponse = await scheduled;
    expect(scheduleResponse.status()).toBe(200);
    expect(await scheduleResponse.json()).toMatchObject({ id: task.id, start: iso('10:00'), end: iso('11:00'), completed: false });
    await verify(true, false);
    // Complete from the second independent session; the first must refresh it.
    const completed = b.waitForResponse(r => new URL(r.url()).pathname === `/api/tasks/${task.id}` && r.request().method() === 'PATCH');
    await b.getByRole('region', { name: '週行程清單', exact: true }).getByTestId(`task-${task.id}`)
      .getByRole('checkbox', { name: '已完成', exact: true }).check();
    const completeResponse = await completed;
    expect(completeResponse.status()).toBe(200);
    expect(await completeResponse.json()).toMatchObject({ id: task.id, completed: true });
    await verify(true, true);
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
