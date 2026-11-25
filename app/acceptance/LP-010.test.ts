import { randomUUID } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { chromium, type Browser } from 'playwright';
import { expect, test } from 'vitest';
import pg from 'pg';
import { startApp, type RunningApp } from '../server';
import { TaskEditor } from '../task-editor';

test('LP-010: hidden events and unscheduled tasks show persisted reminders at the edited Taipei time', async () => {
  // A reminder must also be configurable for a task without a calendar slot.
  const editor = renderToStaticMarkup(createElement(TaskEditor, {
    active: true, editing: null, onActivate() {}, onCancel() {},
    onSave: async () => true, onConfirm: async () => {},
  }));
  expect(editor).toContain('待辦提醒時間');
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw Error('Set TEST_DATABASE_URL to a disposable PostgreSQL database');
  const admin = new pg.Pool({ connectionString: url });
  const schema = 'lp010_' + randomUUID().replaceAll('-', '');
  let created = false;
  let app: RunningApp | undefined;
  let browser: Browser | undefined;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    const db = new URL(url);
    db.searchParams.set('options', '-c search_path=' + schema);
    app = await startApp({ databaseUrl: db.href });
    browser = await chromium.launch();
    const context = await browser.newContext({ timezoneId: 'Asia/Taipei', baseURL: app.url });
    const login = await context.request.post('/api/auth/register', { data: {
      email: randomUUID() + '@example.test', password: 'LP010-password!42',
    } });
    expect(login.status()).toBe(201);
    const page = await context.newPage();
    const day = '2026-12-01T';
    const instant = (time: string) => new Date(day + time + '+08:00');
    await page.clock.install({ time: instant('09:58:00') });
    await page.clock.pauseAt(instant('09:59:59'));
    await page.goto('/');
    await page.getByLabel('行程名稱').fill('隱藏會議');
    await page.getByLabel('開始時間', { exact: true }).fill(day + '11:00');
    await page.getByLabel('結束時間', { exact: true }).fill(day + '12:00');
    await page.getByLabel('行程提醒時間').fill(day + '10:00');
    await page.getByLabel('隱藏行程', { exact: true }).check();
    const eventSaved = page.waitForResponse(r => r.url().endsWith('/api/events') && r.request().method() === 'POST');
    await page.getByRole('button', { name: '儲存行程' }).click();
    expect((await eventSaved).status()).toBe(201);

    await page.getByLabel('待辦名稱').fill('交作業');
    await page.getByLabel('待辦提醒時間').fill(day + '10:00');
    const taskSaved = page.waitForResponse(r => r.url().endsWith('/api/tasks') && r.request().method() === 'POST');
    await page.getByRole('button', { name: '儲存待辦' }).click();
    expect((await taskSaved).status()).toBe(201);
    await page.getByRole('button', { name: '編輯待辦' }).click();
    await page.getByLabel('待辦提醒時間').fill(day + '10:01');
    const updated = page.waitForResponse(r => r.url().includes('/api/tasks/') && r.request().method() === 'PATCH');
    await page.getByRole('button', { name: '儲存待辦' }).click();
    expect((await updated).status()).toBe(200);
    await page.reload();
    await page.getByRole('button', { name: '編輯待辦' }).waitFor();
    const [events, tasks] = await Promise.all(['/api/events', '/api/tasks'].map(async path =>
      (await context.request.get(path)).json()));
    expect(events[0]).toMatchObject({ hidden: true, reminderAt: instant('10:00:00').toISOString() });
    expect(tasks[0]).toMatchObject({ start: null, reminderAt: instant('10:01:00').toISOString() });
    const due = page.getByRole('region', { name: '到期提醒' });
    expect(await due.getByRole('listitem').count()).toBe(0);
    await page.clock.runFor(1_000);
    await due.getByText('隱藏會議', { exact: true }).waitFor();
    expect(await due.getByRole('listitem').allTextContents()).toEqual(['隱藏會議']);
    await page.clock.runFor(59_999);
    expect(await due.getByRole('listitem').count()).toBe(1);
    await page.clock.runFor(1);
    await due.getByText('交作業', { exact: true }).waitFor();
    expect(await due.getByRole('listitem').allTextContents()).toEqual(['隱藏會議', '交作業']);
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
