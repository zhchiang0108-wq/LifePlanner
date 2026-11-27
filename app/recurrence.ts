import type { EventInput, WeeklyRecurrence } from './shared';

const day = 86_400_000;
const offset = 8 * 3600_000;
export const taipeiDate = (instant: string) => new Date(Date.parse(instant) + offset).toISOString().slice(0, 10);
export class InvalidRecurrence extends Error {}
export function validRecurrence(value: unknown): value is WeeklyRecurrence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const rule = value as WeeklyRecurrence;
  return rule.frequency === 'weekly' && Array.isArray(rule.weekdays) && rule.weekdays.length > 0 &&
    rule.weekdays.length <= 7 && new Set(rule.weekdays).size === rule.weekdays.length &&
    rule.weekdays.every(value => Number.isInteger(value) && value >= 0 && value <= 6) &&
    typeof rule.until === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rule.until) &&
    Number.isFinite(Date.parse(rule.until)) && new Date(rule.until).toISOString().slice(0, 10) === rule.until;
}

// The creation date remains the anchor when editing a later occurrence.
// Whole dates preserve wall-clock times because Taipei uses a fixed UTC+8 offset.
export function weeklyOccurrences(input: EventInput, anchor: string, cutoff = -Infinity): EventInput[] {
  const rule = input.recurrence!;
  const first = Date.parse(anchor + 'T00:00:00+08:00');
  const last = Date.parse(rule.until + 'T00:00:00+08:00');
  if (last < first || (last - first) / day > 3_660) throw new InvalidRecurrence('每週重複範圍最多十年');
  const time = ((Date.parse(input.start) + offset) % day + day) % day;
  const duration = Date.parse(input.end) - Date.parse(input.start);
  const reminderOffset = input.reminderAt == null ? null : Date.parse(input.reminderAt) - Date.parse(input.start);
  const occurrences: EventInput[] = [];
  for (let date = first; date <= last; date += day) {
    if (!rule.weekdays.includes(new Date(date + offset).getUTCDay())) continue;
    const start = date + time;
    if (start < cutoff) continue;
    occurrences.push({ ...input, start: new Date(start).toISOString(), end: new Date(start + duration).toISOString(),
      reminderAt: reminderOffset === null ? null : new Date(start + reminderOffset).toISOString() });
    if (occurrences.length > 1_000) throw new InvalidRecurrence('每個系列最多一千次');
  }
  return occurrences;
}
