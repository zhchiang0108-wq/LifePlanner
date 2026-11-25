import React, { useEffect, useMemo, useState } from 'react';
import type { PlannerEvent, PlannerTask } from './shared';

export function DueReminders({ events, tasks }: { events: PlannerEvent[]; tasks: PlannerTask[] }) {
  const reminders = useMemo(() => [...events, ...tasks].flatMap(item =>
    item.reminderAt ? [{ id: item.id, title: item.title, at: Date.parse(item.reminderAt) }] : []
  ).sort((a, b) => a.at - b.at), [events, tasks]);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    let timer: number;
    function update() {
      window.clearTimeout(timer);
      const current = Date.now();
      setNow(current);
      const next = reminders.find(item => item.at > current);
      if (next) timer = window.setTimeout(update, Math.min(next.at - current, 2_147_483_647));
    }
    update();
    document.addEventListener('visibilitychange', update);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', update);
    };
  }, [reminders]);
  const due = reminders.filter(item => item.at <= now);
  return <section aria-label="到期提醒"><h2>到期提醒</h2>
    <ul aria-live="polite">{due.map(item => <li key={item.id}>{item.title}</li>)}</ul>
  </section>;
}
