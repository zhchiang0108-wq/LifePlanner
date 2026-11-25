import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { chromium, errors, type Locator, type Page } from 'playwright';
import pg from 'pg';
import { startApp, type RunningApp } from '../server';
import type { PlannerEvent } from '../shared';

// Production UI/API contract for Green (no test-side rendering or mocked data):
// - The event editor has a 隱藏行程 checkbox, saved by the normal save button.
// - GET/PATCH events expose hidden: boolean, persisted in events.hidden.
// - Hidden events disappear from day/week layout by default. 顯示隱藏行程
//   reveals them without changing their saved hidden state; lists always retain
//   the row, its times, and 已隱藏 marker, with the existing edit button.
// - Existing calendar/list event-<id> selectors remain scoped to their regions.
test('LP-006: hiding frees overlap width, retains day/week list details, and show/edit/restore synchronize between sessions', async () => {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) throw new Error('TEST_DATABASE_URL must point to a disposable PostgreSQL test database');
  const admin = new pg.Pool({ connectionString });
  const schema = `lp006_${randomUUID().replaceAll('-', '')}`;
  const databaseUrl = new URL(connectionString);
  databaseUrl.searchParams.set('options', `-c search_path=${schema}`);
  const database = new pg.Pool({ connectionString: databaseUrl.toString() });
  let createdSchema = false;
  let app: RunningApp | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const email = `lp006-${randomUUID()}@example.test`;
  const password = 'LP006-test-password!42';
  const date = '2026-12-01';
  const start = `${date}T09:00`;
  const end = `${date}T10:00`;
  const iso = (local: string) => new Date(`${local}:00+08:00`).toISOString();
  async function visible(locator: Locator) {
    try { await locator.waitFor({ state: 'visible', timeout: 5_000 }); }
    catch (error) { if (!(error instanceof errors.TimeoutError)) throw error; }
    expect(await locator.isVisible(), `Expected visible LP-006 UI: ${locator}`).toBe(true);
  }
  try {
    await admin.query('SELECT 1');
    await admin.query(`CREATE SCHEMA "${schema}"`);
    createdSchema = true;
    app = await startApp({ databaseUrl: databaseUrl.toString() });
    browser = await chromium.launch();
    // Independent cookies/storage, with desktop and narrow touch viewports.
    // These are browser checks; physical Windows/Android checks remain separate.
    const desktop = await browser.newContext({ timezoneId: 'Asia/Taipei', viewport: { width: 1280, height: 900 } });
    const mobile = await browser.newContext({ timezoneId: 'Asia/Taipei', viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
    const a = await desktop.newPage();
    const b = await mobile.newPage();
    async function authenticate(page: Page, mode: 'register' | 'login') {
      await page.goto(`${app!.url}/${mode}`);
      await page.getByLabel('電子郵件', { exact: true }).fill(email);
      await page.getByLabel('密碼', { exact: true }).fill(password);
      const response = page.waitForResponse(r => new URL(r.url()).pathname === `/api/auth/${mode}` && r.request().method() === 'POST');
      await page.getByRole('button', { name: mode === 'register' ? '註冊' : '登入', exact: true }).click();
      const result = await response;
      expect(result.status()).toBe(mode === 'register' ? 201 : 200);
      const data = await result.json();
      await page.goto(app!.url);
      return data.user.id as string;
    }
    const userId = await authenticate(a, 'register');
    expect(await authenticate(b, 'login')).toBe(userId);
    async function reload(page: Page) {
      const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/events' && r.request().method() === 'GET');
      await page.reload();
      expect((await response).status()).toBe(200);
    }
    async function select(page: Page, view: '日' | '週') {
      await page.getByRole('button', { name: view, exact: true }).click();
      await page.getByLabel('日期', { exact: true }).fill(date);
      const grid = page.getByRole('grid', { name: `${view}行事曆`, exact: true });
      await visible(grid);
      return grid;
    }
    async function create(title: string) {
      await a.getByLabel('行程名稱', { exact: true }).fill(title);
      await a.getByLabel('開始時間', { exact: true }).fill(start);
      await a.getByLabel('結束時間', { exact: true }).fill(end);
      await a.getByRole('checkbox', { name: '確認允許時段重疊', exact: true }).check();
      const response = a.waitForResponse(r => new URL(r.url()).pathname === '/api/events' && r.request().method() === 'POST');
      await a.getByRole('button', { name: '儲存行程', exact: true }).click();
      const result = await response;
      expect(result.status()).toBe(201);
      const event: PlannerEvent = await result.json();
      await expect.poll(() => a.getByLabel('行程名稱', { exact: true }).inputValue()).toBe('');
      return event;
    }
    const anchor = await create('保留可見的研究');
    const widths = new Map<string, number>();
    async function bounds(locator: Locator) {
      await visible(locator);
      const box = await locator.boundingBox();
      expect(box).not.toBeNull();
      return box!;
    }
    // Measure the real single-event width for each viewport and calendar mode.
    for (const [index, page] of [a, b].entries()) {
      await reload(page);
      for (const view of ['日', '週'] as const) {
        const grid = await select(page, view);
        widths.set(`${index}-${view}`, (await bounds(grid.getByTestId(`event-${anchor.id}`))).width);
      }
    }
    const target = await create('可隱藏的討論');
    let title = target.title;
    async function verify(hidden: boolean) {
      for (const [index, page] of [a, b].entries()) {
        await reload(page);
        const response = await page.request.get(`${app!.url}/api/events`);
        expect(response.status()).toBe(200);
        const events = await response.json();
        expect(events).toHaveLength(2);
        expect(events).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: target.id, title, start: iso(start), end: iso(end), hidden }),
        ]));
        for (const view of ['日', '週'] as const) {
          const grid = await select(page, view);
          const row = page.getByRole('region', { name: `${view}行程清單`, exact: true }).getByTestId(`event-${target.id}`);
          await visible(row);
          const text = (await row.innerText()).replace(/\s+/g, ' ');
          expect(text).toContain(title);
          expect(text).toContain(`${date} 09:00`);
          expect(text).toContain(`${date} 10:00`);
          expect(text.includes('已隱藏')).toBe(hidden);
          const anchorBox = await bounds(grid.getByTestId(`event-${anchor.id}`));
          const fullWidth = widths.get(`${index}-${view}`)!;
          if (hidden) {
            expect(await grid.getByTestId(`event-${target.id}`).count()).toBe(0);
            expect(Math.abs(anchorBox.width - fullWidth)).toBeLessThanOrEqual(2);
          } else {
            const targetBox = await bounds(grid.getByTestId(`event-${target.id}`));
            // Both simultaneous events occupy separate horizontal lanes, not
            // two full-width blocks stacked vertically or clipped to zero width.
            for (const box of [anchorBox, targetBox]) {
              expect(box.width).toBeGreaterThan(fullWidth * 0.35);
              expect(box.width).toBeLessThanOrEqual(fullWidth * 0.55);
            }
            expect(Math.min(anchorBox.y + anchorBox.height, targetBox.y + targetBox.height)
              - Math.max(anchorBox.y, targetBox.y)).toBeGreaterThan(0);
            expect(Math.min(anchorBox.x + anchorBox.width, targetBox.x + targetBox.width)
              - Math.max(anchorBox.x, targetBox.x)).toBeLessThanOrEqual(2);
          }
        }
      }
      const stored = await database.query('SELECT id, user_id, title, starts_at, ends_at, hidden FROM events WHERE user_id=$1', [userId]);
      expect(stored.rows).toHaveLength(2);
      const row = stored.rows.find(row => row.id === target.id);
      expect(row).toMatchObject({ id: target.id, user_id: userId, title, hidden });
      expect(new Date(row.starts_at).toISOString()).toBe(iso(start));
      expect(new Date(row.ends_at).toISOString()).toBe(iso(end));
    }
    async function edit(page: Page, hidden: boolean, nextTitle = title) {
      await select(page, '日');
      await page.getByRole('region', { name: '日行程清單', exact: true })
        .getByTestId(`event-${target.id}`).getByRole('button').click();
      const checkbox = page.getByRole('checkbox', { name: '隱藏行程', exact: true });
      await visible(checkbox);
      await checkbox.setChecked(hidden);
      await page.getByLabel('行程名稱', { exact: true }).fill(nextTitle);
      await page.getByRole('checkbox', { name: '確認允許時段重疊', exact: true }).check();
      const response = page.waitForResponse(r => new URL(r.url()).pathname === `/api/events/${target.id}` && r.request().method() === 'PATCH');
      await page.getByRole('button', { name: '儲存行程', exact: true }).click();
      const result = await response;
      expect(result.status()).toBe(200);
      expect(await result.json()).toMatchObject({ id: target.id, title: nextTitle, hidden });
      title = nextTitle;
      await expect.poll(() => page.getByLabel('行程名稱', { exact: true }).inputValue()).toBe('');
    }

    // Assert the new control first so missing UI gives a product AssertionError.
    await edit(a, true);
    await verify(true);
    // Revealing a hidden event is a view operation, not a persisted restoration.
    for (const page of [a, b]) {
      for (const view of ['日', '週'] as const) {
        const grid = await select(page, view);
        const show = page.getByRole('checkbox', { name: '顯示隱藏行程', exact: true });
        await visible(show);
        await show.check();
        await visible(grid.getByTestId(`event-${target.id}`));
        await show.uncheck();
        await expect.poll(() => grid.getByTestId(`event-${target.id}`).count()).toBe(0);
      }
    }
    await verify(true);
    await edit(b, true, '手機修改後仍隱藏的討論');
    await verify(true);
    await edit(a, false);
    await verify(false);
    // Check the reverse direction after restoration as well.
    await edit(b, true);
    await verify(true);
    await edit(b, false);
    await verify(false);
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
