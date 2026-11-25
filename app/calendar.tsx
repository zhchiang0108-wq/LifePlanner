import React from 'react';
import type { PlannerEvent } from './shared';

// Keep the calendar and the editor in the same explicit Taipei time zone.
export const localTime = (iso: string) => new Date(Date.parse(iso) + 8 * 3600_000).toISOString().slice(0, 16);
export const toInstant = (local: string) => new Date(`${local}+08:00`).toISOString();
export const shiftDate = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400_000).toISOString().slice(0, 10);

// Both the calendar and list use Monday as the first day of a week.
export function datesForView(view: '日' | '週', date: string): string[] {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  const first = view === '週' ? shiftDate(date, -((weekday + 6) % 7)) : date;
  return Array.from({ length: view === '日' ? 1 : 7 }, (_, i) => shiftDate(first, i));
}

// Partition each connected overlap group into lanes. Exclusive ends let
// adjacent events reuse a lane. Call with only the events being displayed.
function dayLayout(events: PlannerEvent[], day: string) {
  const midnight = Date.parse(toInstant(`${day}T00:00`));
  const next = midnight + 86400_000;
  const items = events.map(event => ({ event,
    start: Math.max(midnight, Date.parse(event.start)),
    end: Math.min(next, Date.parse(event.end)), lane: 0, lanes: 1,
  })).filter(item => item.start < item.end)
    .sort((a, b) => a.start - b.start || a.end - b.end || a.event.id.localeCompare(b.event.id));
  let group: typeof items = [];
  let laneEnds: number[] = [];
  let groupEnd = 0;
  function finishGroup() {
    for (const item of group) item.lanes = laneEnds.length;
    group = []; laneEnds = [];
  }
  for (const item of items) {
    if (item.start >= groupEnd) finishGroup();
    const available = laneEnds.findIndex(end => end <= item.start);
    item.lane = available < 0 ? laneEnds.length : available;
    laneEnds[item.lane] = item.end;
    group.push(item);
    groupEnd = Math.max(groupEnd, item.end);
  }
  finishGroup();
  return items.map(item => ({ ...item, minute: (item.start - midnight) / 60_000,
    duration: (item.end - item.start) / 60_000 }));
}

export function Calendar({ view, date, events, onCreate, onEdit }: {
  view: '日' | '週'; date: string; events: PlannerEvent[];
  onCreate(start: string): void; onEdit(event: PlannerEvent): void;
}) {
  const days = datesForView(view, date);
  const layouts = new Map(days.map(day => [day, dayLayout(events, day)]));
  return <div className="calendar-scroll" tabIndex={0} aria-label="行事曆捲動區">
    <div role="grid" aria-label={`${view}行事曆`} className={`calendar ${view === '週' ? 'week' : ''}`}>
      <div role="row" className="calendar-row">
        <span role="columnheader">時間</span>{days.map(day => <span role="columnheader" key={day}>{day}</span>)}
      </div>
      {Array.from({ length: 24 }, (_, hour) => {
        const time = `${String(hour).padStart(2, '0')}:00`;
        return <div role="row" className="calendar-row" key={hour}>
          <span role="rowheader">{time}</span>{days.map(day => {
            const start = `${day}T${time}`;
            const blocks = layouts.get(day)!.filter(item => Math.floor(item.minute / 60) === hour);
            return <div role="gridcell" aria-label={`${day} ${time}`} key={day} onClick={e => { if (e.target === e.currentTarget) onCreate(start); }}>
              <button type="button" className="new-slot" aria-label={`新增行程 ${day} ${time}`} onClick={() => onCreate(start)}>＋</button>
              {blocks.map(({ event, lane, lanes, minute, duration }) => <button type="button" className="calendar-event" key={event.id} data-testid={`event-${event.id}`} onClick={() => onEdit(event)}
                style={{ left: `calc(6px + (100% - 12px) * ${lane / lanes})`, width: `calc((100% - 12px) / ${lanes} - 2px)`,
                  top: (minute % 60) * 80 / 60, height: Math.max(24, duration * 80 / 60 - 2) }}>
                <strong>{event.title}</strong>{event.hidden && <span> 已隱藏</span>}<br />{localTime(event.start).replace('T', ' ')} – {localTime(event.end).replace('T', ' ')}
              </button>)}
            </div>;
          })}
        </div>;
      })}
    </div>
  </div>;
}
