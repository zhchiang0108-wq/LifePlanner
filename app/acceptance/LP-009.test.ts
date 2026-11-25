import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { chromium } from 'playwright';
import pg from 'pg';
import { startApp, type RunningApp } from '../server';
import type { PlannerEvent, PlannerTask } from '../shared';

// Real UI -> authenticated Express -> PostgreSQL, with independent cookie jars.
// A confirmation covers the conflicts actually disclosed to that editor. If B
// inserts another conflict before A confirms, A must see and confirm it afresh.
// No routes, conflict responses, product writes or clocks are mocked.
test('LP-009: stale overlap confirmation rejects a new conflict from another session until explicitly reconfirmed', async () => {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) throw new Error('TEST_DATABASE_URL must point to a disposable PostgreSQL test database');
  const admin = new pg.Pool({ connectionString });
  const schema = `lp009_${randomUUID().replaceAll('-', '')}`;
  const databaseUrl = new URL(connectionString);
  databaseUrl.searchParams.set('options', `-c search_path=${schema}`);
  const database = new pg.Pool({ connectionString: databaseUrl.toString() });
  let createdSchema = false;
  let app: RunningApp | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    createdSchema = true;
    app = await startApp({ databaseUrl: databaseUrl.toString() });
    browser = await chromium.launch();
    const desktop = await browser.newContext({ timezoneId: 'Asia/Taipei', viewport: { width: 1280, height: 900 } });
    const mobile = await browser.newContext({ timezoneId: 'Asia/Taipei', viewport: { width: 412, height: 915 }, isMobile: true });
    const pageA = await desktop.newPage();
    const pageB = await mobile.newPage();
    const credentials = { email: `lp009-${randomUUID()}@example.test`, password: 'LP009-password!42' };
    const registration = await desktop.request.post(`${app.url}/api/auth/register`, { data: credentials });
    expect(registration.status()).toBe(201);
    const { user } = await registration.json();
    expect((await mobile.request.get(`${app.url}/api/events`)).status()).toBe(401);
    expect((await mobile.request.post(`${app.url}/api/auth/login`, { data: credentials })).status()).toBe(200);
    await pageA.goto(app.url);
    await pageB.goto(app.url);

    async function reload(page: typeof pageA) {
      const events = page.waitForResponse(r => new URL(r.url()).pathname === '/api/events' && r.request().method() === 'GET');
      const tasks = page.waitForResponse(r => new URL(r.url()).pathname === '/api/tasks' && r.request().method() === 'GET');
      await page.reload();
      expect((await events).status()).toBe(200);
      expect((await tasks).status()).toBe(200);
    }
    async function snapshot() {
      const events = await desktop.request.get(`${app!.url}/api/events`);
      const tasks = await desktop.request.get(`${app!.url}/api/tasks`);
      expect(events.status()).toBe(200);
      expect(tasks.status()).toBe(200);
      return {
        events: await events.json(), tasks: await tasks.json(),
        sqlEvents: (await database.query('SELECT * FROM events WHERE user_id=$1 ORDER BY id', [user.id])).rows,
        sqlTasks: (await database.query('SELECT * FROM tasks WHERE user_id=$1 ORDER BY id', [user.id])).rows,
      };
    }

    let index = 0;
    for (const kind of ['events', 'tasks'] as const) {
      for (const operation of ['create', 'reschedule'] as const) {
        const date = `2026-12-${11 + index++}`;
        const iso = (time: string) => new Date(`${date}T${time}:00+08:00`).toISOString();
        const input = (title: string, start: string, end: string) => ({ title, start: iso(start), end: iso(end) });
        const title = `${kind}-${operation}-等待確認`;
        const initialResponse = await desktop.request.post(`${app.url}/api/events`, { data: {
          ...input(`${date}-原衝突`, '09:00', '10:00'), hidden: true,
        } });
        expect(initialResponse.status()).toBe(201);
        const initial = await initialResponse.json() as PlannerEvent;
        let original: PlannerEvent | PlannerTask | undefined;
        if (operation === 'reschedule') {
          const response = await desktop.request.post(`${app.url}/api/${kind}`, { data: input(title, '14:00', '15:00') });
          expect(response.status()).toBe(201);
          original = await response.json();
        }
        await reload(pageA);
        await pageA.getByLabel('日期', { exact: true }).fill(date);
        if (original) {
          const row = pageA.getByRole('region', { name: '日行程清單', exact: true })
            .getByTestId(`${kind === 'events' ? 'event' : 'task'}-${original.id}`);
          await row.getByRole('button').first().click();
        }
        const editor = kind === 'events'
          ? pageA.locator('form').filter({ has: pageA.getByLabel('行程名稱', { exact: true }) })
          : pageA.getByRole('region', { name: '待辦編輯', exact: true });
        const titleLabel = kind === 'events' ? '行程名稱' : '待辦名稱';
        const confirm = editor.getByRole('checkbox', {
          name: kind === 'events' ? '確認允許時段重疊' : '確認允許待辦時段重疊', exact: true,
        });
        await editor.getByLabel(titleLabel, { exact: true }).fill(title);
        await editor.getByLabel('開始時間', { exact: true }).fill(`${date}T09:30`);
        await editor.getByLabel('結束時間', { exact: true }).fill(`${date}T11:30`);
        expect(await confirm.isChecked()).toBe(false);
        async function submit() {
          const path = `/api/${kind}${original ? `/${original.id}` : ''}`;
          const pending = pageA.waitForResponse(r => new URL(r.url()).pathname === path && r.request().method() === (original ? 'PATCH' : 'POST'));
          await editor.getByRole('button', { name: kind === 'events' ? '儲存行程' : '儲存待辦', exact: true }).click();
          return await pending;
        }
        const beforeFirst = await snapshot();
        expect((await submit()).status()).toBe(409);
        expect(await snapshot()).toEqual(beforeFirst);
        expect(await pageA.getByRole('alert').innerText()).toContain(initial.title);

        // B inserts after A has seen the original conflict, before A confirms.
        // This interval touches neither the original blocker nor the old draft
        // location; it intersects only A's proposed 09:30-11:30 interval.
        const lateKind = kind === 'events' ? 'tasks' : 'events';
        const lateResponse = await mobile.request.post(`${app.url}/api/${lateKind}`, { data: {
          ...input(`${date}-另一工作階段的新衝突`, '10:30', '11:00'),
          ...(lateKind === 'events' ? { hidden: true } : {}),
        } });
        expect(lateResponse.status()).toBe(201);
        const late = await lateResponse.json() as PlannerEvent | PlannerTask;
        expect(await pageA.getByRole('alert').innerText()).not.toContain(late.title);
        const beforeStale = await snapshot();
        await confirm.check();
        const stale = await submit();
        expect(stale.status(), `${kind} ${operation}: the old confirmation must not authorize B's new conflict`).toBe(409);
        expect(await snapshot(), 'Rejecting stale confirmation must preserve every API and SQL row').toEqual(beforeStale);
        const message = await pageA.getByRole('alert').innerText();
        for (const conflict of [initial, late]) {
          expect(message).toContain(conflict.title);
          for (const endpoint of [conflict.start!, conflict.end!]) {
            const local = new Date(Date.parse(endpoint) + 8 * 3600_000).toISOString().slice(0, 16).replace('T', ' ');
            expect(message.includes(endpoint) || message.includes(local), `Disclose conflict endpoint ${endpoint}`).toBe(true);
          }
        }
        expect(await confirm.isChecked(), 'A must explicitly confirm the newly disclosed conflicts').toBe(false);
        expect(await editor.getByLabel(titleLabel, { exact: true }).inputValue()).toBe(title);
        expect(await editor.getByLabel('開始時間', { exact: true }).inputValue()).toBe(`${date}T09:30`);
        expect(await editor.getByLabel('結束時間', { exact: true }).inputValue()).toBe(`${date}T11:30`);
        // Merely retrying the rejected save is still not confirmation.
        expect((await submit()).status()).toBe(409);
        expect(await snapshot()).toEqual(beforeStale);
        await confirm.check();
        const accepted = await submit();
        expect(accepted.status()).toBe(original ? 200 : 201);
        const saved = await accepted.json() as PlannerEvent | PlannerTask;
        expect(saved).toMatchObject({ ...input(title, '09:30', '11:30'), ...(original ? { id: original.id } : {}) });
        const state = await snapshot();
        expect(state[kind].filter((item: { title: string }) => item.title === title)).toEqual([saved]);
        const rows = kind === 'events' ? state.sqlEvents : state.sqlTasks;
        const stored = rows.filter(row => row.id === saved.id);
        expect(stored).toHaveLength(1);
        expect(stored[0].title).toBe(title);
        expect(new Date(stored[0].starts_at).toISOString()).toBe(iso('09:30'));
        expect(new Date(stored[0].ends_at).toISOString()).toBe(iso('11:30'));
        // Refresh B's independent browser to verify the final committed write.
        await reload(pageB);
        await pageB.getByLabel('日期', { exact: true }).fill(date);
        const synced = pageB.getByRole('region', { name: '日行程清單', exact: true })
          .getByTestId(`${kind === 'events' ? 'event' : 'task'}-${saved.id}`);
        await synced.waitFor({ state: 'visible' });
        expect(await synced.innerText()).toContain(title);
        expect(await synced.innerText()).toContain(`${date} 09:30`);
        expect(await synced.innerText()).toContain(`${date} 11:30`);
        const otherRows = lateKind === 'events' ? state.events : state.tasks;
        expect(otherRows.find((item: { id: string }) => item.id === late.id)).toEqual(late);
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
