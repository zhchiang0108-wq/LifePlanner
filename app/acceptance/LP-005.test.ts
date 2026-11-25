import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { chromium, errors, type Locator } from 'playwright';
import pg from 'pg';
import { startApp, type RunningApp } from '../server';
import type { PlannerEvent } from '../shared';

// UI contract for the real application:
// - The editor's 全天 checkbox stores an explicit all-day event (not a title convention).
// - 日行程清單 / 週行程清單 are named regions controlled by the existing toolbar.
// - Weekly date groups have role=group and accessible name YYYY-MM-DD.
// - List rows retain event-<id>, show title and Taipei start/end (YYYY-MM-DD HH:mm),
//   and mark all-day rows 全天. All-day end is the exclusive next-day boundary.
// These selectors describe production UI; no test-side rendering or mocked API.
test('LP-005: persisted day/week lists show times, put all-day first, group and sort, and follow date navigation', async () => {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) throw new Error('TEST_DATABASE_URL must point to a disposable PostgreSQL test database');
  const admin = new pg.Pool({ connectionString });
  const schema = `lp005_${randomUUID().replaceAll('-', '')}`;
  const databaseUrl = new URL(connectionString);
  databaseUrl.searchParams.set('options', `-c search_path=${schema}`);
  const database = new pg.Pool({ connectionString: databaseUrl.toString() });
  let createdSchema = false;
  let app: RunningApp | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const iso = (local: string) => new Date(`${local}:00+08:00`).toISOString();
  const fixtures = [
    // Deliberately insert in neither chronological nor alphabetical order.
    { title: 'A 下午討論', start: '2026-12-01T15:30', end: '2026-12-01T16:45' },
    { title: '週日整理', start: '2026-12-06T18:00', end: '2026-12-06T19:00' },
    { title: 'Z 上午閱讀', start: '2026-12-01T09:05', end: '2026-12-01T10:20' },
    { title: '下週一行程', start: '2026-12-07T08:00', end: '2026-12-07T09:00' },
    { title: '週一跨月行程', start: '2026-11-30T11:00', end: '2026-11-30T12:00' },
    { title: '今天研究', start: '2026-12-02T13:00', end: '2026-12-02T14:00' },
    { title: '前週日行程', start: '2026-11-29T20:00', end: '2026-11-29T21:00' },
    // Midnight timed event must stay below the all-day row, even at equal starts.
    { title: '午夜例行工作', start: '2026-12-01T00:00', end: '2026-12-01T00:30' },
    { title: '全天研習', start: '2026-12-01T00:00', end: '2026-12-02T00:00', allDay: true },
  ];
  const saved: PlannerEvent[] = [];
  async function visible(locator: Locator) {
    // Match LP-004: missing product UI yields a useful assertion, not a timeout error.
    try { await locator.waitFor({ state: 'visible', timeout: 5_000 }); }
    catch (error) { if (!(error instanceof errors.TimeoutError)) throw error; }
    expect(await locator.isVisible(), `Expected visible LP-005 UI: ${locator}`).toBe(true);
  }

  try {
    await admin.query('SELECT 1');
    await admin.query(`CREATE SCHEMA "${schema}"`);
    createdSchema = true;
    app = await startApp({ databaseUrl: databaseUrl.toString() });
    browser = await chromium.launch();
    const context = await browser.newContext({ timezoneId: 'Asia/Taipei' });
    const page = await context.newPage();
    // Fix only browser Date. Network, timers, Express and PostgreSQL remain real.
    // This instant is Dec 2 in Taipei but still Dec 1 in UTC.
    await page.clock.setFixedTime(new Date('2026-12-01T16:30:00Z'));
    await page.goto(`${app.url}/register`);
    await page.getByLabel('電子郵件', { exact: true }).fill(`lp005-${randomUUID()}@example.test`);
    await page.getByLabel('密碼', { exact: true }).fill('LP005-test-password!42');
    const registered = page.waitForResponse(r => new URL(r.url()).pathname === '/api/auth/register' && r.request().method() === 'POST');
    await page.getByRole('button', { name: '註冊', exact: true }).click();
    const registration = await registered;
    expect(registration.status()).toBe(201);
    const { user } = await registration.json();
    await page.goto(app.url);

    for (const fixture of fixtures) {
      await page.getByLabel('行程名稱', { exact: true }).fill(fixture.title);
      await page.getByLabel('開始時間', { exact: true }).fill(fixture.start);
      await page.getByLabel('結束時間', { exact: true }).fill(fixture.end);
      if (fixture.allDay) {
        const checkbox = page.getByRole('checkbox', { name: '全天', exact: true });
        await visible(checkbox);
        await checkbox.check();
      }
      // All-day deliberately overlaps timed entries; explicitly confirm via real UI.
      await page.getByRole('checkbox', { name: '確認允許時段重疊', exact: true }).check();
      const created = page.waitForResponse(r => new URL(r.url()).pathname === '/api/events' && r.request().method() === 'POST');
      await page.getByRole('button', { name: '儲存行程', exact: true }).click();
      const response = await created;
      expect(response.status()).toBe(201);
      const event: PlannerEvent = await response.json();
      expect(event).toMatchObject({ title: fixture.title, start: iso(fixture.start), end: iso(fixture.end) });
      saved.push(event);
      // Wait for form reset, so the following iteration does not race the GET refresh.
      await expect.poll(() => page.getByLabel('行程名稱', { exact: true }).inputValue()).toBe('');
    }

    // Confirm fixtures belong to this account and actually reached PostgreSQL.
    const stored = await database.query('SELECT id, user_id, title, starts_at, ends_at FROM events WHERE user_id=$1', [user.id]);
    expect(stored.rows).toHaveLength(fixtures.length);
    for (const [index, fixture] of fixtures.entries()) {
      const row = stored.rows.find(row => row.id === saved[index].id);
      expect(row).toMatchObject({ user_id: user.id, title: fixture.title });
      expect(new Date(row.starts_at).toISOString()).toBe(iso(fixture.start));
      expect(new Date(row.ends_at).toISOString()).toBe(iso(fixture.end));
    }

    async function reload() {
      const loaded = page.waitForResponse(r => new URL(r.url()).pathname === '/api/events' && r.request().method() === 'GET');
      await page.reload();
      expect((await loaded).status()).toBe(200);
    }
    const list = (view: '日' | '週') => page.getByRole('region', { name: `${view}行程清單`, exact: true });
    async function select(view: '日' | '週', date: string) {
      await page.getByRole('button', { name: view, exact: true }).click();
      await page.getByLabel('日期', { exact: true }).fill(date);
      await visible(list(view));
      return list(view);
    }
    async function rows(scope: Locator, indices: number[]) {
      // An exact ordered ID sequence checks omissions, duplicates, extra dates and sorting.
      await expect.poll(() => scope.locator('[data-testid^="event-"]').evaluateAll(
        elements => elements.map(element => element.getAttribute('data-testid')),
      )).toEqual(indices.map(index => `event-${saved[index].id}`));
      for (const index of indices) {
        const row = scope.getByTestId(`event-${saved[index].id}`);
        await visible(row);
        const text = (await row.innerText()).replace(/\s+/g, ' ');
        expect(text).toContain(fixtures[index].title);
        expect(text).toContain(fixtures[index].start.replace('T', ' '));
        expect(text).toContain(fixtures[index].end.replace('T', ' '));
        if (fixtures[index].allDay) expect(text).toContain('全天');
      }
    }
    async function navigate(view: '日' | '週', name: string, date: string, indices: number[]) {
      await page.getByRole('button', { name, exact: true }).click();
      await expect.poll(() => page.getByLabel('日期', { exact: true }).inputValue()).toBe(date);
      await rows(list(view), indices);
    }

    // Read persisted data again rather than accepting optimistic client state.
    await reload();
    await rows(await select('日', '2026-12-01'), [8, 7, 2, 0]);
    await navigate('日', '上一日', '2026-11-30', [4]);
    await navigate('日', '下一日', '2026-12-01', [8, 7, 2, 0]);
    await navigate('日', '下一日', '2026-12-02', [5]);
    // Exclusive all-day end must not leak the Dec 1 event into Dec 2.
    await navigate('日', '下一日', '2026-12-03', []);
    await navigate('日', '今天', '2026-12-02', [5]);

    const weekly = await select('週', '2026-12-02');
    await rows(weekly, [4, 8, 7, 2, 0, 5, 1]);
    const expectedGroups = [
      { date: '2026-11-30', indices: [4] },
      { date: '2026-12-01', indices: [8, 7, 2, 0] },
      { date: '2026-12-02', indices: [5] },
      { date: '2026-12-06', indices: [1] },
    ];
    for (const group of expectedGroups) {
      const section = weekly.getByRole('group', { name: group.date, exact: true });
      await visible(section);
      expect(await section.innerText()).toContain(group.date);
      await rows(section, group.indices);
    }
    // The exact weekly row sequence above also checks chronological group order.
    await navigate('週', '上一週', '2026-11-25', [6]);
    await navigate('週', '下一週', '2026-12-02', [4, 8, 7, 2, 0, 5, 1]);
    await navigate('週', '下一週', '2026-12-09', [3]);
    await navigate('週', '今天', '2026-12-02', [4, 8, 7, 2, 0, 5, 1]);
    await reload();
    await rows(await select('日', '2026-12-01'), [8, 7, 2, 0]);
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
