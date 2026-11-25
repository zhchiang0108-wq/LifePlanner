import React from 'react';
import type { PlannerEvent, PlannerTask } from './shared';
import { TaskControls } from './task-editor';
import { datesForView, localTime, toInstant, shiftDate } from './calendar';

type ListItem = PlannerEvent & { task?: PlannerTask };
export function EventList({ view, date, events, onEdit, tasks, onEditTask, onCompleteTask }: {
  view: '日' | '週'; date: string; events: PlannerEvent[];
  onEdit(event: PlannerEvent): void;
  tasks: PlannerTask[]; onEditTask(task: PlannerTask): void;
  onCompleteTask(task: PlannerTask, completed: boolean): Promise<void>;
}) {
  const items: ListItem[] = [...events, ...tasks.flatMap(task => task.start && task.end ? [{
    id: task.id, title: task.title, start: task.start, end: task.end, hidden: false, task,
  }] : [])];
  const days = datesForView(view, date);
  const first = days[0];
  const groups = days.map(day => ({
    day,
    // Include continuations, but never include an exclusive end at midnight.
    items: items.filter(event => event.start < toInstant(`${shiftDate(day, 1)}T00:00`) &&
      event.end > toInstant(`${day}T00:00`)).sort((a, b) =>
      Number(Boolean(b.allDay)) - Number(Boolean(a.allDay)) ||
      Date.parse(a.start) - Date.parse(b.start) || Date.parse(a.end) - Date.parse(b.end) || a.id.localeCompare(b.id)),
  }));
  // Keep persisted events discoverable after login, even outside the selected
  // period. Do not mix them into the date-filtered day/week region.
  const otherEvents = items.filter(event =>
    event.end <= toInstant(`${first}T00:00`) ||
    event.start >= toInstant(`${shiftDate(first, days.length)}T00:00`)
  ).sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || a.id.localeCompare(b.id));
  function rows(items: ListItem[]) {
    return <ul>{items.map(event => <li key={event.id} data-testid={`${event.task ? 'task' : 'event'}-${event.id}`}>
      <button type="button" className="list-event" onClick={() => event.task ? onEditTask(event.task) : onEdit(event)}>
        <strong>{event.title}</strong>{event.allDay && <span> 全天</span>}{event.hidden && <span> 已隱藏</span>}<br />
        <time dateTime={event.start}>{localTime(event.start).replace('T', ' ')}</time> – <time dateTime={event.end}>{localTime(event.end).replace('T', ' ')}</time>
      </button>
      {event.task && <TaskControls task={event.task} onEdit={onEditTask} onComplete={onCompleteTask} />}
    </li>)}</ul>;
  }
  return <><section aria-label={`${view}行程清單`}>
    <h2>{view}行程清單</h2>
    {view === '日' ? rows(groups[0].items) : groups.filter(group => group.items.length).map(group =>
      <section role="group" aria-label={group.day} key={group.day}><h3>{group.day}</h3>{rows(group.items)}</section>)}
    {groups.every(group => !group.items.length) && <p>此{view}尚無行程</p>}
  </section>{otherEvents.length > 0 && <section aria-label="其他日期行程">
    <h2>其他日期行程</h2>{rows(otherEvents)}
  </section>}</>;
}
