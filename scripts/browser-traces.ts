import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright';
import { beforeEach, vi } from 'vitest';

// Observe the actual Chromium contexts, including those closed inside a test.
// Existing acceptance files are fingerprinted by the TDD runner.
beforeEach(({ task }) => {
  const label = task.name.split(':')[0].replace(/[^a-z0-9_-]/gi, '-').slice(0, 60);
  const directory = resolve('test-results', 'traces', label + '-' + randomUUID());
  let contextCount = 0;
  const launch = chromium.launch.bind(chromium);
  const spy = vi.spyOn(chromium, 'launch').mockImplementation(async options => {
    const browser = await launch(options);
    const newContext = browser.newContext.bind(browser);
    const active = new Set<() => Promise<void>>();
    browser.newContext = async settings => {
      const context = await newContext(settings);
      await context.tracing.start({ screenshots: true, snapshots: true });
      const name = ++contextCount + '-' + (settings?.isMobile ? 'mobile' : 'desktop');
      let lastWrite = 'session';
      context.on('request', req => {
        const match = new URL(req.url()).pathname.match(/^\/api\/(events|tasks)(?:\/|$)/);
        if (match && ['POST', 'PATCH', 'DELETE'].includes(req.method())) {
          lastWrite = match[1] + '-' + req.method().toLowerCase();
        }
      });
      async function save() {
        if (!active.delete(save)) return;
        await mkdir(directory, { recursive: true });
        await context.tracing.stop({ path: join(directory, name + '-' + lastWrite + '.zip') });
      }
      active.add(save);
      const close = context.close.bind(context);
      context.close = async options => { try { await save(); } finally { await close(options); } };
      return context;
    };
    const close = browser.close.bind(browser);
    browser.close = async options => {
      try { await Promise.all([...active].map(save => save())); }
      finally { await close(options); }
    };
    return browser;
  });
  return async () => {
    spy.mockRestore();
    if (task.result?.state !== 'fail' && contextCount) await rm(directory, { recursive: true, force: true });
  };
});
