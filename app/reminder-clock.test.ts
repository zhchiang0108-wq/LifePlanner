import { build } from 'esbuild';
import { chromium } from 'playwright';
import { expect, test } from 'vitest';

test('reminder clock cancels the old timer after an edit and renders at the exact millisecond', async () => {
  const bundle = await build({ bundle: true, write: false, stdin: { loader: 'tsx', resolveDir: process.cwd(), contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { flushSync } from 'react-dom';
    import { DueReminders } from './app/due-reminders';
    const root = createRoot(document.getElementById('root'));
    window.renderReminder = reminderAt => flushSync(() => root.render(
      <DueReminders events={[{id:'e', title:'Meeting', hidden:true, reminderAt}]} tasks={[]} />
    ));
  ` } });
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const due = new Date('2026-12-01T10:00:00+08:00').getTime();
    await page.clock.install({ time: new Date(due - 60_000) });
    await page.clock.pauseAt(new Date(due - 1_000));
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const render = (at: number) => page.evaluate((iso: string) =>
      (window as unknown as { renderReminder(iso: string): void }).renderReminder(iso), new Date(at).toISOString());
    await render(due);
    await render(due + 1_000);
    const rows = page.getByRole('region', { name: '到期提醒' }).getByRole('listitem');
    await page.clock.runFor(1_000);
    expect(await rows.count()).toBe(0);
    await page.clock.runFor(999);
    expect(await rows.count()).toBe(0);
    await page.clock.runFor(1);
    await rows.first().waitFor();
    expect(await rows.allTextContents()).toEqual(['Meeting']);
  } finally { await browser.close(); }
});
