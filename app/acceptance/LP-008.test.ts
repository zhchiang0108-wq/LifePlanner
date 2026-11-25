import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { chromium, errors, type Locator } from 'playwright';
import pg from 'pg';
import { startApp, type RunningApp } from '../server';
import type { PlannerEvent, PlannerTask } from '../shared';

// Exercise real UI -> authenticated Express -> isolated PostgreSQL.
// Cancellation contract: the active editor offers a button beginning with 取消,
// discards the draft, and does not persist it. Conflict messages must show ALL
// intersecting names and both endpoints (Taipei display or explicit ISO instants).
// No product routes, responses, time checks, or database writes are mocked.
test('LP-008: event/task creation and rescheduling disclose conflicts, cancel, revise or explicitly confirm; exclude self and touching intervals', async () => {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) throw new Error('TEST_DATABASE_URL must point to a disposable PostgreSQL test database');
  const admin = new pg.Pool({ connectionString });
  const schema = `lp008_${randomUUID().replaceAll('-', '')}`;
  const databaseUrl = new URL(connectionString);
  databaseUrl.searchParams.set('options', `-c search_path=${schema}`);
  const database = new pg.Pool({ connectionString: databaseUrl.toString() });
  let createdSchema = false;
  let app: RunningApp | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  async function visible(locator: Locator) {
    try { await locator.waitFor({ state: 'visible', timeout: 5_000 }); }
    catch (error) { if (!(error instanceof errors.TimeoutError)) throw error; }
    expect(await locator.isVisible(), `Expected LP-008 UI control: ${locator}`).toBe(true);
  }
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    createdSchema = true;
    app = await startApp({ databaseUrl: databaseUrl.toString() });
    browser = await chromium.launch();
    const context = await browser.newContext({ timezoneId: 'Asia/Taipei', viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const registered = await context.request.post(`${app.url}/api/auth/register`, { data: {
      email: `lp008-${randomUUID()}@example.test`, password: 'LP008-test-password!42',
    } });
    expect(registered.status()).toBe(201);
    const { user } = await registered.json();
    await page.goto(app.url);

    // Read both authenticated APIs and SQL after every rejected/cancelled write.
    // Comparing complete snapshots also catches duplicates and unrelated changes.
    async function snapshot() {
      const events = await context.request.get(`${app!.url}/api/events`);
      const tasks = await context.request.get(`${app!.url}/api/tasks`);
      expect(events.status()).toBe(200);
      expect(tasks.status()).toBe(200);
      const storedEvents = await database.query('SELECT * FROM events WHERE user_id=$1 ORDER BY id', [user.id]);
      const storedTasks = await database.query('SELECT * FROM tasks WHERE user_id=$1 ORDER BY id', [user.id]);
      return { events: await events.json(), tasks: await tasks.json(), sqlEvents: storedEvents.rows, sqlTasks: storedTasks.rows };
    }
    async function reload() {
      const events = page.waitForResponse(r => new URL(r.url()).pathname === '/api/events' && r.request().method() === 'GET');
      const tasks = page.waitForResponse(r => new URL(r.url()).pathname === '/api/tasks' && r.request().method() === 'GET');
      await page.reload();
      expect((await events).status()).toBe(200);
      expect((await tasks).status()).toBe(200);
    }

    let caseIndex = 0;
    for (const kind of ['events', 'tasks'] as const) {
      for (const operation of ['create', 'reschedule'] as const) {
        const date = `2026-12-0${++caseIndex}`;
        const iso = (time: string) => new Date(`${date}T${time}:00+08:00`).toISOString();
        const input = (title: string, start: string, end: string) => ({ title, start: iso(start), end: iso(end) });
        const title = `${kind}-${operation}-候選項目`;
        async function seed(resource: 'events' | 'tasks', name: string, start: string, end: string, hidden = false) {
          const response = await context.request.post(`${app!.url}/api/${resource}`, { data: {
            ...input(name, start, end), ...(resource === 'events' ? { hidden } : {}),
          } });
          expect(response.status(), `Seed ${name} through the real API`).toBe(201);
          return await response.json() as PlannerEvent | PlannerTask;
        }
        const blockers = [
          await seed('events', `${date}-一般行程`, '09:00', '10:00'),
          await seed('events', `${date}-隱藏行程`, '10:00', '11:00', true),
          await seed('tasks', `${date}-已排程待辦`, '11:00', '12:00'),
        ];
        // A similarly named unscheduled task must not be treated as a conflict.
        const unscheduledTitle = `${date}-未排程不衝突`;
        expect((await context.request.post(`${app.url}/api/tasks`, { data: {
          title: unscheduledTitle, start: null, end: null,
        } })).status()).toBe(201);
        const original = operation === 'reschedule' ? await seed(kind, title, '14:00', '15:00') : undefined;
        const editor = kind === 'events'
          ? page.locator('form').filter({ has: page.getByLabel('行程名稱', { exact: true }) })
          : page.getByRole('region', { name: '待辦編輯', exact: true });
        const titleLabel = kind === 'events' ? '行程名稱' : '待辦名稱';
        const saveName = kind === 'events' ? '儲存行程' : '儲存待辦';
        const confirmName = kind === 'events' ? '確認允許時段重疊' : '確認允許待辦時段重疊';
        async function open(id?: string) {
          await reload();
          await page.getByLabel('日期', { exact: true }).fill(date);
          if (id) {
            const row = page.getByRole('region', { name: '日行程清單', exact: true })
              .getByTestId(`${kind === 'events' ? 'event' : 'task'}-${id}`);
            await visible(row);
            await row.getByRole('button').first().click();
          }
          await editor.getByLabel(titleLabel, { exact: true }).fill(title);
          // Focusing the task name expands its time controls.
          expect(await editor.getByRole('checkbox', { name: confirmName, exact: true }).isChecked()).toBe(false);
        }
        async function times(start: string, end: string) {
          await editor.getByLabel('開始時間', { exact: true }).fill(`${date}T${start}`);
          await editor.getByLabel('結束時間', { exact: true }).fill(`${date}T${end}`);
        }
        async function submit(id?: string) {
          const path = `/api/${kind}${id ? `/${id}` : ''}`;
          const pending = page.waitForResponse(r => new URL(r.url()).pathname === path && r.request().method() === (id ? 'PATCH' : 'POST'));
          await editor.getByRole('button', { name: saveName, exact: true }).click();
          return await pending;
        }
        async function reject(id?: string) {
          const before = await snapshot();
          const response = await submit(id);
          expect(response.status(), `${kind} ${operation}: overlapping write requires confirmation`).toBe(409);
          expect(await snapshot()).toEqual(before);
          const alert = page.getByRole('alert');
          await visible(alert);
          const message = await alert.innerText();
          for (const blocker of blockers) {
            expect(message, `Conflict message must include ${blocker.title}`).toContain(blocker.title);
            for (const endpoint of [blocker.start!, blocker.end!]) {
              const local = new Date(Date.parse(endpoint) + 8 * 3600_000).toISOString().slice(0, 16).replace('T', ' ');
              expect(message.includes(endpoint) || message.includes(local), `Show conflict endpoint ${endpoint} or ${local}`).toBe(true);
            }
          }
          expect(message).not.toContain(unscheduledTitle);
          expect(message).not.toContain(title);
          expect(await editor.getByLabel(titleLabel, { exact: true }).inputValue()).toBe(title);
          expect(await editor.getByLabel('開始時間', { exact: true }).inputValue()).toBe(`${date}T09:30`);
          expect(await editor.getByLabel('結束時間', { exact: true }).inputValue()).toBe(`${date}T11:30`);
        }
        async function saved(id: string | undefined, start: string, end: string) {
          const response = await submit(id);
          expect(response.status()).toBe(id ? 200 : 201);
          const item = await response.json() as PlannerEvent | PlannerTask;
          expect(item).toMatchObject({ ...input(title, start, end), ...(id ? { id } : {}) });
          const state = await snapshot();
          expect(state[kind].filter((row: { id: string }) => row.id === item.id)).toEqual([item]);
          const rows = kind === 'events' ? state.sqlEvents : state.sqlTasks;
          const stored = rows.filter(row => row.id === item.id);
          expect(stored).toHaveLength(1);
          expect(stored[0].title).toBe(title);
          expect(new Date(stored[0].starts_at).toISOString()).toBe(iso(start));
          expect(new Date(stored[0].ends_at).toISOString()).toBe(iso(end));
          return item;
        }

        await open(original?.id);
        await times('09:30', '11:30');
        await reject(original?.id);
        const beforeCancel = await snapshot();
        const cancel = editor.getByRole('button', { name: /^取消/ });
        await visible(cancel);
        await cancel.click();
        expect(await snapshot()).toEqual(beforeCancel);
        expect(await editor.getByLabel(titleLabel, { exact: true }).inputValue()).toBe('');
        await reload();
        expect(await snapshot()).toEqual(beforeCancel);

        // Revise without checking confirmation. Test touching from both sides.
        await open(original?.id);
        await times('08:00', '09:00');
        const revised = await saved(original?.id, '08:00', '09:00');
        await open(revised.id);
        await times('12:00', '13:00');
        await saved(revised.id, '12:00', '13:00');
        // Submitting an unchanged interval must exclude the item itself.
        await open(revised.id);
        await saved(revised.id, '12:00', '13:00');

        // The create path must explicitly confirm a POST, the reschedule path a
        // PATCH. Keep the earlier touching item for create; do not replace POST
        // acceptance with an update that happens to use the same editor.
        const confirmId = operation === 'reschedule' ? revised.id : undefined;
        await open(confirmId);
        await times('09:30', '11:30');
        await reject(confirmId);
        await editor.getByRole('checkbox', { name: confirmName, exact: true }).check();
        const confirmed = await saved(confirmId, '09:30', '11:30');
        await reload();
        await page.getByLabel('日期', { exact: true }).fill(date);
        const confirmedRow = page.getByRole('region', { name: '日行程清單', exact: true })
          .getByTestId(`${kind === 'events' ? 'event' : 'task'}-${confirmed.id}`);
        await visible(confirmedRow);
        expect(await confirmedRow.innerText()).toContain(title);
        expect(await confirmedRow.innerText()).toContain(`${date} 09:30`);
        expect(await confirmedRow.innerText()).toContain(`${date} 11:30`);
      }
    }
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
