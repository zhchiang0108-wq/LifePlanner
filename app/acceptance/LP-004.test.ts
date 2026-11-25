import { randomUUID } from 'node:crypto';
import { test, expect } from 'vitest';
import { chromium, errors, type Locator } from 'playwright';
import pg from 'pg';
import { startApp, type RunningApp } from '../server';
import type { PlannerEvent } from '../shared';

// UI contract: 日 / 週 buttons select a named 日行事曆 / 週行事曆 grid.
// 日期 is a date input; gridcells have local names YYYY-MM-DD HH:mm.
// Clicking an empty cell opens the existing labelled event form, prefilled with
// that cell's start. Clicking event-<id> in a cell opens its edit/delete form.
// These are real UI integration points, not test-only product implementations.
test('LP-004: day and week time grids create, reschedule and delete persisted events after reload', async () => {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) throw new Error('TEST_DATABASE_URL must point to a disposable PostgreSQL test database');
  const admin = new pg.Pool({ connectionString });
  const schema = `lp004_${randomUUID().replaceAll('-', '')}`;
  const databaseUrl = new URL(connectionString);
  databaseUrl.searchParams.set('options', `-c search_path=${schema}`);
  const database = new pg.Pool({ connectionString: databaseUrl.toString() });
  let createdSchema = false;
  let app: RunningApp | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const email = `lp004-${randomUUID()}@example.test`;
  const password = 'LP004-test-password!42';
  const iso = (local: string) => new Date(`${local}:00+08:00`).toISOString();
  const visible = async (locator: Locator) => {
    // Wait for React without turning a missing product control into a generic
    // polling timeout. The outer red runner requires an AssertionError.
    try { await locator.waitFor({ state: 'visible', timeout: 5_000 }); }
    catch (error) {
      if (!(error instanceof errors.TimeoutError)) throw error;
    }
    expect(await locator.isVisible(), `Expected visible calendar UI: ${locator}`).toBe(true);
  };

  try {
    await admin.query('SELECT 1');
    await admin.query(`CREATE SCHEMA "${schema}"`);
    createdSchema = true;
    app = await startApp({ databaseUrl: databaseUrl.toString() });
    browser = await chromium.launch();
    const context = await browser.newContext({ timezoneId: 'Asia/Taipei' });
    const page = await context.newPage();
    await page.goto(`${app.url}/register`);
    await page.getByLabel('電子郵件', { exact: true }).fill(email);
    await page.getByLabel('密碼', { exact: true }).fill(password);
    const registered = page.waitForResponse(r => new URL(r.url()).pathname === '/api/auth/register' && r.request().method() === 'POST');
    await page.getByRole('button', { name: '註冊', exact: true }).click();
    const registration = await registered;
    expect(registration.status()).toBe(201);
    const { user } = await registration.json();
    await page.goto(app.url);

    async function selectView(view: '日' | '週', date: string) {
      const button = page.getByRole('button', { name: view, exact: true });
      // Missing calendar controls are a product assertion failure, not a long
      // click timeout or a missing import/environment error.
      await visible(button);
      await button.click();
      await page.getByLabel('日期', { exact: true }).fill(date);
      const grid = page.getByRole('grid', { name: `${view}行事曆`, exact: true });
      await visible(grid);
      return grid;
    }
    const cell = (grid: Locator, local: string) => grid.getByRole('gridcell', {
      name: local.replace('T', ' '), exact: true,
    });
    async function reloadGrid(view: '日' | '週', date: string) {
      const loaded = page.waitForResponse(r => new URL(r.url()).pathname === '/api/events' && r.request().method() === 'GET');
      await page.reload();
      expect((await loaded).status()).toBe(200);
      // Re-select explicitly: persistence of the view preference is not required.
      return selectView(view, date);
    }
    async function stored(id: string, title: string, start: string, end: string) {
      const result = await database.query(
        'SELECT id, user_id, title, starts_at, ends_at FROM events WHERE id = $1', [id],
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toMatchObject({ id, user_id: user.id, title });
      expect(new Date(result.rows[0].starts_at).toISOString()).toBe(iso(start));
      expect(new Date(result.rows[0].ends_at).toISOString()).toBe(iso(end));
    }
    async function shown(grid: Locator, event: PlannerEvent, local: string) {
      const block = cell(grid, local).getByTestId(`event-${event.id}`);
      await visible(block);
      await expect.poll(() => block.textContent()).toContain(event.title);
      return block;
    }

    // Support a native confirmation when deleting through the real UI.
    page.on('dialog', dialog => void dialog.accept());
    for (const scenario of [
      { view: '日', date: '2026-12-01', start: '2026-12-01T09:00', end: '2026-12-01T10:00', moved: '2026-12-01T11:00', movedEnd: '2026-12-01T12:00' },
      // Move to another column as well as another hour in the same week.
      { view: '週', date: '2026-12-02', start: '2026-12-02T14:00', end: '2026-12-02T15:00', moved: '2026-12-03T16:00', movedEnd: '2026-12-03T17:00' },
    ] as const) {
      const { view, date, start, end, moved, movedEnd } = scenario;
      const title = `LP-004 ${view}曆研究討論`;
      let grid = await selectView(view, date);
      await cell(grid, start).click();
      expect(await page.getByLabel('開始時間', { exact: true }).inputValue()).toBe(start);
      await page.getByLabel('行程名稱', { exact: true }).fill(title);
      await page.getByLabel('結束時間', { exact: true }).fill(end);
      const created = page.waitForResponse(r => new URL(r.url()).pathname === '/api/events' && r.request().method() === 'POST');
      await page.getByRole('button', { name: '儲存行程', exact: true }).click();
      const createResponse = await created;
      expect(createResponse.status()).toBe(201);
      const event: PlannerEvent = await createResponse.json();
      expect(event.id).toBeTruthy();
      expect(event).toMatchObject({ title, start: iso(start), end: iso(end) });
      await shown(grid, event, start);
      await stored(event.id, title, start, end);
      grid = await reloadGrid(view, date);
      await shown(grid, event, start);

      await (await shown(grid, event, start)).click();
      expect(await page.getByLabel('行程名稱', { exact: true }).inputValue()).toBe(title);
      expect(await page.getByLabel('開始時間', { exact: true }).inputValue()).toBe(start);
      expect(await page.getByLabel('結束時間', { exact: true }).inputValue()).toBe(end);
      const editedTitle = `${title}（改期）`;
      await page.getByLabel('行程名稱', { exact: true }).fill(editedTitle);
      await page.getByLabel('開始時間', { exact: true }).fill(moved);
      await page.getByLabel('結束時間', { exact: true }).fill(movedEnd);
      const updated = page.waitForResponse(r => new URL(r.url()).pathname === `/api/events/${event.id}` && r.request().method() === 'PATCH');
      await page.getByRole('button', { name: '儲存行程', exact: true }).click();
      const updateResponse = await updated;
      expect(updateResponse.status()).toBe(200);
      expect(await updateResponse.json()).toMatchObject({ id: event.id, title: editedTitle, start: iso(moved), end: iso(movedEnd) });
      const edited = { ...event, title: editedTitle, start: iso(moved), end: iso(movedEnd) };
      await shown(grid, edited, moved);
      await stored(event.id, editedTitle, moved, movedEnd);
      grid = await reloadGrid(view, date);
      await shown(grid, edited, moved);
      expect(await cell(grid, start).getByTestId(`event-${event.id}`).count()).toBe(0);
      expect(await grid.getByTestId(`event-${event.id}`).count()).toBe(1);

      await (await shown(grid, edited, moved)).click();
      const deleted = page.waitForResponse(r => new URL(r.url()).pathname === `/api/events/${event.id}` && r.request().method() === 'DELETE');
      await page.getByRole('button', { name: '刪除行程', exact: true }).click();
      expect([200, 204]).toContain((await deleted).status());
      await expect.poll(() => grid.getByTestId(`event-${event.id}`).count()).toBe(0);
      expect((await database.query('SELECT id FROM events WHERE id = $1', [event.id])).rows).toEqual([]);
      grid = await reloadGrid(view, date);
      expect(await grid.getByTestId(`event-${event.id}`).count()).toBe(0);
      const list = await context.request.get(`${app.url}/api/events`);
      expect(list.status()).toBe(200);
      expect(await list.json()).toEqual([]);
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
