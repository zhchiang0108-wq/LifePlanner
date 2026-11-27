import { randomUUID } from 'node:crypto';
import { request, type APIRequestContext } from 'playwright';
import { expect, test } from 'vitest';
import pg from 'pg';
import { startApp, type RunningApp } from '../server';
import type { EventInput, PlannerEvent } from '../shared';

test('weekly series checks every occurrence, binds consent to the proposed set, and preserves eligible dates when edited later', async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw Error('Set TEST_DATABASE_URL to a disposable PostgreSQL database');
  const admin = new pg.Pool({ connectionString: url });
  const schema = 'weekly_' + randomUUID().replaceAll('-', '');
  const iso = (local: string) => new Date(local + ':00+08:00').toISOString();
  let created = false;
  let app: RunningApp | undefined;
  const contexts: APIRequestContext[] = [];
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    const db = new URL(url);
    db.searchParams.set('options', '-c search_path=' + schema);
    const options = { databaseUrl: db.href, now: () => new Date(iso('2026-12-10T12:00')) };
    app = await startApp(options);
    async function account() {
      const api = await request.newContext({ baseURL: app!.url });
      contexts.push(api);
      const credentials = { email: randomUUID() + '@example.test', password: 'weekly-password!42' };
      expect((await api.post('/api/auth/register', { data: credentials })).status()).toBe(201);
      return { api, credentials };
    }
    async function events(api: APIRequestContext): Promise<PlannerEvent[]> {
      const response = await api.get('/api/events');
      expect(response.status()).toBe(200);
      return response.json();
    }
    const { api, credentials } = await account();
    const input = (title: string, date: string, start = '09:00', end = '10:00'): EventInput => ({
      title, start: iso(date + 'T' + start), end: iso(date + 'T' + end),
    });
    const blocker = await api.post('/api/events', { data: input('later occurrence conflict', '2026-12-16', '09:30', '09:45') });
    expect(blocker.status()).toBe(201);
    const blockerEvent: PlannerEvent = await blocker.json();
    const proposal: EventInput = {
      ...input('weekly candidate', '2026-12-14'),
      recurrence: { frequency: 'weekly', weekdays: [1, 3], until: '2026-12-23' },
    };
    const first = await api.post('/api/events', { data: proposal });
    expect(first.status(), 'A clean first occurrence cannot conceal a later conflict').toBe(409);
    const disclosure = await first.json();
    expect(disclosure.conflicts.map((event: PlannerEvent) => event.id)).toEqual([blockerEvent.id]);
    expect(await events(api), 'Rejected series creation must be atomic').toEqual([blockerEvent]);

    const longer = { ...proposal, recurrence: { ...proposal.recurrence!, until: '2026-12-30' } };
    const changedSet = await api.post('/api/events', { data: {
      ...longer, confirmOverlap: true, confirmationToken: disclosure.confirmationToken,
    } });
    expect(changedSet.status(), 'Consent cannot be reused for a changed occurrence set').toBe(409);
    const changedDisclosure = await changedSet.json();
    expect(await events(api)).toEqual([blockerEvent]);
    const otherSession = await request.newContext({ baseURL: app.url });
    contexts.push(otherSession);
    expect((await otherSession.post('/api/auth/login', { data: credentials })).status()).toBe(200);
    const late = await otherSession.post('/api/events', { data: input('new later conflict', '2026-12-23', '09:15', '09:30') });
    expect(late.status()).toBe(201);
    const lateEvent: PlannerEvent = await late.json();
    const beforeRetry = await events(api);
    const stale = await api.post('/api/events', { data: {
      ...longer, confirmOverlap: true, confirmationToken: changedDisclosure.confirmationToken,
    } });
    expect(stale.status()).toBe(409);
    const refreshed = await stale.json();
    expect(new Set(refreshed.conflicts.map((event: PlannerEvent) => event.id)))
      .toEqual(new Set([blockerEvent.id, lateEvent.id]));
    expect(await events(api)).toEqual(beforeRetry);
    const accepted = await api.post('/api/events', { data: {
      ...longer, confirmOverlap: true, confirmationToken: refreshed.confirmationToken,
    } });
    expect(accepted.status()).toBe(201);
    expect((await events(api)).filter(event => event.title === proposal.title)).toHaveLength(6);

    // A separate owner's calendar also verifies that series identifiers never
    // grant access. No existing conflict fixtures share this owner's times.
    const { api: owner } = await account();
    const recurring: EventInput = {
      ...input('editable series', '2026-12-07', '14:00', '15:00'),
      reminderAt: iso('2026-12-07T13:30'),
      recurrence: { frequency: 'weekly', weekdays: [1, 3], until: '2026-12-23' },
    };
    expect((await owner.post('/api/events', { data: recurring })).status()).toBe(201);
    const original = await events(owner);
    expect(original).toHaveLength(6);
    const selected = original.find(event => event.start === iso('2026-12-21T14:00'))!;
    const preserved = original.find(event => event.start === iso('2026-12-14T14:00'))!;
    const past = original.slice(0, 2);
    const edit: EventInput = {
      ...input('changed weekdays', '2026-12-21', '16:00', '17:00'),
      reminderAt: iso('2026-12-21T15:15'),
      recurrence: { frequency: 'weekly', weekdays: [1, 5], until: '2026-12-25' },
    };
    const beforeForeign = await events(owner);
    expect((await api.get('/api/events/' + selected.id)).status()).toBe(404);
    expect((await api.patch('/api/events/' + selected.id, { data: edit })).status()).toBe(404);
    expect((await api.delete('/api/events/' + selected.id)).status()).toBe(404);
    expect(await events(owner)).toEqual(beforeForeign);

    expect((await owner.patch('/api/events/' + selected.id, { data: edit })).status()).toBe(200);
    const updated = await events(owner);
    expect(updated.filter(event => past.some(item => item.id === event.id))).toEqual(past);
    const future = updated.filter(event => !past.some(item => item.id === event.id));
    const expectedDates = ['2026-12-11', '2026-12-14', '2026-12-18', '2026-12-21', '2026-12-25'];
    expect(future.map(event => ({ title: event.title, start: event.start, end: event.end, reminderAt: event.reminderAt })))
      .toEqual(expectedDates.map(date => ({ title: edit.title, start: iso(date + 'T16:00'), end: iso(date + 'T17:00'), reminderAt: iso(date + 'T15:15') })));
    expect(future.find(event => event.start === iso('2026-12-14T16:00'))!.id).toBe(preserved.id);
    expect(future.find(event => event.start === iso('2026-12-21T16:00'))!.id).toBe(selected.id);
    // A fresh request context must read the committed series.
    const cookies = (await owner.storageState()).cookies;
    const fresh = await request.newContext({ baseURL: app.url, storageState: { cookies, origins: [] } });
    contexts.push(fresh);
    expect(await events(fresh)).toEqual(updated);

    // With an empty calendar, these two 48-hour occurrences overlap each other.
    const { api: overlapping } = await account();
    expect(await events(overlapping)).toEqual([]);
    const internalOverlap: EventInput = {
      title: 'overlapping proposed occurrences',
      start: iso('2027-02-01T09:00'), end: iso('2027-02-03T09:00'),
      recurrence: { frequency: 'weekly', weekdays: [1, 2], until: '2027-02-02' },
    };
    const preview = await overlapping.post('/api/conflicts', { data: { kind: 'events', input: internalOverlap } });
    expect(preview.status()).toBe(200);
    const internalDisclosure = await preview.json();
    expect(internalDisclosure.conflicts.length, 'Preview must disclose overlap inside the proposed series').toBeGreaterThan(0);
    expect(internalDisclosure.confirmationToken).toEqual(expect.any(String));
    expect(await events(overlapping), 'Conflict preview cannot write occurrences').toEqual([]);
    const unconfirmed = await overlapping.post('/api/events', { data: internalOverlap });
    expect(unconfirmed.status()).toBe(409);
    expect(await events(overlapping), 'Unconfirmed internal overlap must write no rows').toEqual([]);
    const confirmed = await overlapping.post('/api/events', { data: {
      ...internalOverlap, confirmOverlap: true, confirmationToken: internalDisclosure.confirmationToken,
    } });
    expect(confirmed.status()).toBe(201);
    const internallyOverlapping = await events(overlapping);
    expect(internallyOverlapping).toHaveLength(2);
    expect(internallyOverlapping.map(event => ({ start: event.start, end: event.end }))).toEqual([
      { start: iso('2027-02-01T09:00'), end: iso('2027-02-03T09:00') },
      { start: iso('2027-02-02T09:00'), end: iso('2027-02-04T09:00') },
    ]);
  } finally {
    try { await Promise.all(contexts.map(context => context.dispose())); }
    finally {
      try { await app?.close(); }
      finally {
        try { if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`); }
        finally { await admin.end(); }
      }
    }
  }
});
