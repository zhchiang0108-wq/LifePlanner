import { randomUUID } from 'node:crypto';
import { chromium, type Browser } from 'playwright';
import { expect, test } from 'vitest';
import pg from 'pg';
import { startApp, type RunningApp } from '../server';
import type { PlannerEvent } from '../shared';

// Real editor -> authenticated API -> PostgreSQL, followed by browser reloads.
// The same explicit instant controls the browser and the server's future cutoff.
test('LP-011: chosen weekly weekdays include the end date, and series changes preserve past events and reminders', async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw Error('Set TEST_DATABASE_URL to a disposable PostgreSQL database');
  const admin = new pg.Pool({ connectionString: url });
  const schema = 'lp011_' + randomUUID().replaceAll('-', '');
  const instant = (local: string) => new Date(local + ':00+08:00');
  const iso = (local: string) => instant(local).toISOString();
  const now = () => instant('2026-12-10T12:00');
  const dates = ['2026-12-07', '2026-12-09', '2026-12-14', '2026-12-16', '2026-12-21', '2026-12-23'];
  const originalTitle = 'LP-011 每週讀書會';
  const editedTitle = 'LP-011 未來讀書會';
  let created = false;
  let app: RunningApp | undefined;
  let browser: Browser | undefined;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    const db = new URL(url);
    db.searchParams.set('options', '-c search_path=' + schema);
    const options = { databaseUrl: db.href, now };
    app = await startApp(options);
    browser = await chromium.launch();
    const context = await browser.newContext({ timezoneId: 'Asia/Taipei', baseURL: app.url });
    expect((await context.request.post('/api/auth/register', { data: {
      email: randomUUID() + '@example.test', password: 'LP011-password!42',
    } })).status()).toBe(201);
    const page = await context.newPage();
    await page.clock.install({ time: now() });
    await page.clock.pauseAt(now());
    await page.goto('/');
    await page.getByLabel('行程名稱', { exact: true }).waitFor();
    // First missing feature fails as a product assertion, not a click timeout.
    const weekly = page.getByRole('checkbox', { name: '每週重複', exact: true });
    expect(await weekly.count(), 'The event editor must offer weekly repetition').toBe(1);
    await page.getByLabel('行程名稱', { exact: true }).fill(originalTitle);
    await page.getByLabel('開始時間', { exact: true }).fill(dates[0] + 'T09:00');
    await page.getByLabel('結束時間', { exact: true }).fill(dates[0] + 'T10:00');
    await page.getByLabel('行程提醒時間', { exact: true }).fill(dates[0] + 'T08:30');
    await weekly.check();
    for (const weekday of ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日']) {
      const control = page.getByRole('checkbox', { name: weekday, exact: true });
      expect(await control.count()).toBe(1);
      await control.setChecked(['星期一', '星期三'].includes(weekday));
    }
    await page.getByLabel('重複結束日期', { exact: true }).fill(dates.at(-1)!);
    const saved = page.waitForResponse(r => new URL(r.url()).pathname === '/api/events' && r.request().method() === 'POST');
    await page.getByRole('button', { name: '儲存行程', exact: true }).click();
    expect((await saved).status()).toBe(201);

    async function events(): Promise<PlannerEvent[]> {
      const response = await context.request.get('/api/events');
      expect(response.status()).toBe(200);
      return response.json();
    }
    async function reload() {
      const loaded = page.waitForResponse(r => new URL(r.url()).pathname === '/api/events' && r.request().method() === 'GET');
      await page.reload();
      expect((await loaded).status()).toBe(200);
      await page.getByLabel('行程名稱', { exact: true }).waitFor();
    }
    async function dayRows(date: string) {
      await page.getByLabel('日期', { exact: true }).fill(date);
      return page.getByRole('region', { name: '日行程清單', exact: true });
    }
    const due = page.getByRole('region', { name: '到期提醒', exact: true });
    await reload();
    const initial = await events();
    expect(initial).toHaveLength(dates.length);
    expect(new Set(initial.map(event => event.id)).size).toBe(dates.length);
    expect(initial.map(event => ({ title: event.title, start: event.start, end: event.end, reminderAt: event.reminderAt })))
      .toEqual(dates.map(date => ({ title: originalTitle, start: iso(date + 'T09:00'), end: iso(date + 'T10:00'), reminderAt: iso(date + 'T08:30') })));
    // This checks the selected final weekday itself, then the following week.
    expect(await (await dayRows('2026-12-23')).getByRole('listitem').count()).toBe(1);
    for (const date of ['2026-12-08', '2026-12-24', '2026-12-28', '2026-12-30']) {
      expect(await (await dayRows(date)).getByRole('listitem').count(), `No occurrence on ${date}`).toBe(0);
    }
    expect(await due.getByRole('listitem').allTextContents()).toEqual([originalTitle, originalTitle]);
    const past = initial.slice(0, 2);
    const future = initial.slice(2);
    const row = (await dayRows('2026-12-14')).getByTestId('event-' + future[0].id);
    await row.getByRole('button').click();
    await page.getByLabel('行程名稱', { exact: true }).fill(editedTitle);
    await page.getByLabel('開始時間', { exact: true }).fill('2026-12-14T11:00');
    await page.getByLabel('結束時間', { exact: true }).fill('2026-12-14T12:00');
    await page.getByLabel('行程提醒時間', { exact: true }).fill('2026-12-14T10:30');
    const patched = page.waitForResponse(r => new URL(r.url()).pathname === '/api/events/' + future[0].id && r.request().method() === 'PATCH');
    await page.getByRole('button', { name: '儲存系列', exact: true }).click();
    expect((await patched).status()).toBe(200);
    await reload();
    const updated = await events();
    expect(updated).toHaveLength(initial.length);
    expect(updated.filter(event => past.some(item => item.id === event.id))).toEqual(past);
    for (const [index, old] of future.entries()) {
      const date = dates[index + 2];
      const event = updated.find(item => item.id === old.id);
      expect(event).toMatchObject({ id: old.id, title: editedTitle, start: iso(date + 'T11:00'), end: iso(date + 'T12:00'), reminderAt: iso(date + 'T10:30') });
      const persisted = (await dayRows(date)).getByTestId('event-' + old.id);
      expect(await persisted.innerText()).toContain(editedTitle);
      expect(await persisted.innerText()).toContain(date + ' 11:00');
    }
    expect(await (await dayRows('2026-12-28')).getByRole('listitem').count()).toBe(0);
    // The old reminder must never fire; the new reminder fires exactly once.
    await page.clock.fastForward(instant('2026-12-14T08:30').getTime() - now().getTime());
    expect(await due.getByRole('listitem').allTextContents()).toEqual([originalTitle, originalTitle]);
    await page.clock.fastForward(2 * 3600_000 - 1);
    expect(await due.getByRole('listitem').count()).toBe(2);
    await page.clock.runFor(1);
    await expect.poll(() => due.getByRole('listitem').allTextContents()).toEqual([originalTitle, originalTitle, editedTitle]);

    await (await dayRows('2026-12-14')).getByTestId('event-' + future[0].id).getByRole('button').click();
    page.on('dialog', dialog => void dialog.accept());
    const deleted = page.waitForResponse(r => new URL(r.url()).pathname === '/api/events/' + future[0].id && r.request().method() === 'DELETE');
    await page.getByRole('button', { name: '刪除系列', exact: true }).click();
    expect((await deleted).status()).toBe(200);
    await reload();
    expect(await events()).toEqual(past);
    for (const date of dates.slice(2)) expect(await (await dayRows(date)).getByRole('listitem').count()).toBe(0);
    for (const event of past) {
      expect(await (await dayRows(event.start.slice(0, 10))).getByTestId('event-' + event.id).innerText()).toContain(originalTitle);
    }
    await page.clock.fastForward(instant('2026-12-31T12:00').getTime() - instant('2026-12-14T10:30').getTime());
    expect(await due.getByRole('listitem').allTextContents()).toEqual([originalTitle, originalTitle]);
  } finally {
    try { await browser?.close(); }
    finally {
      try { await app?.close(); }
      finally {
        try { if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`); }
        finally { await admin.end(); }
      }
    }
  }
});
