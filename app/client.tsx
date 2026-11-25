import React, { useEffect, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import type { AuthResponse, Credentials, EventInput, PlannerEvent, PlannerTask, TaskInput, ApiError } from './shared';
import './style.css';
import { Calendar, localTime, toInstant, shiftDate } from './calendar';
import { DueReminders } from './due-reminders';
import { EventList } from './event-list';
import { TaskEditor, TaskControls } from './task-editor';

class RequestError extends Error {
  constructor(public data: ApiError) { super(data.error); }
}
async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new RequestError(data as ApiError);
  return data as T;
}
function App() {
  const mode = location.pathname === '/register' ? 'register' : 'login';
  const [isAuthPage, setIsAuthPage] = useState(() => ['/register', '/login'].includes(location.pathname));
  const [error, setError] = useState('');
  const [events, setEvents] = useState<PlannerEvent[]>([]);
  const [tasks, setTasks] = useState<PlannerTask[]>([]);
  const [taskActive, setTaskActive] = useState(false);
  const [editingTask, setEditingTask] = useState<PlannerTask | null>(null);
  const [taskEditorVersion, setTaskEditorVersion] = useState(0);
  const [taskConfirmationToken, setTaskConfirmationToken] = useState<string>();
  function editTask(task: PlannerTask) {
    setTaskConfirmationToken(undefined);
    setEditingTask(task); setTaskActive(true); setTaskEditorVersion(v => v + 1); setError('');
    document.getElementById('task-editor')?.scrollIntoView({ block: 'center' });
  }
  async function completeTask(task: PlannerTask, completed: boolean) {
    setError('');
    try {
      const updated = await request<PlannerTask>(`/api/tasks/${task.id}`, 'PATCH', { completed });
      setTasks(current => current.map(item => item.id === updated.id ? updated : item));
    } catch (e) { setError((e as Error).message); }
  }
  async function saveTask(input: TaskInput) {
    setError('');
    try {
      await request<PlannerTask>(editingTask ? `/api/tasks/${editingTask.id}` : '/api/tasks', editingTask ? 'PATCH' : 'POST', { ...input, confirmationToken: taskConfirmationToken });
      setTasks(await request<PlannerTask[]>('/api/tasks'));
      setEditingTask(null); setTaskConfirmationToken(undefined); return true;
    } catch (e) {
      setTaskConfirmationToken(e instanceof RequestError ? e.data.confirmationToken : undefined);
      setError((e as Error).message); return false;
    }
  }
  async function confirmTask(input: TaskInput) {
    if (taskConfirmationToken || !input.start || !input.end) return;
    try {
      const disclosure = await request<ApiError>('/api/conflicts', 'POST', { kind: 'tasks', id: editingTask?.id, input });
      setTaskConfirmationToken(disclosure.confirmationToken);
      setError(disclosure.conflicts?.length ? disclosure.error : '');
    } catch (e) { setError((e as Error).message); throw e; }
  }
  const [email, setEmail] = useState('');
  const [view, setView] = useState<'日' | '週'>('日');
  const [date, setDate] = useState(() => localTime(new Date().toISOString()).slice(0, 10));
  const [editing, setEditing] = useState<PlannerEvent | null>(null);
  const [draft, setDraft] = useState({ title: '', start: '', end: '', reminderAt: '', allDay: false, hidden: false, confirmOverlap: false });
  const [showHidden, setShowHidden] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmationToken, setConfirmationToken] = useState<string>();
  async function confirmEvent(checked: boolean) {
    setDraft(current => ({ ...current, confirmOverlap: checked }));
    if (!checked || confirmationToken) return;
    setSaving(true);
    try {
      const input = { ...draft, reminderAt: draft.reminderAt ? toInstant(draft.reminderAt) : null, start: toInstant(draft.start), end: toInstant(draft.end) };
      const disclosure = await request<ApiError>('/api/conflicts', 'POST', { kind: 'events', id: editing?.id, input });
      setConfirmationToken(disclosure.confirmationToken);
      setError(disclosure.conflicts?.length ? disclosure.error : '');
    } catch (e) {
      setDraft(current => ({ ...current, confirmOverlap: false })); setError((e as Error).message);
    } finally { setSaving(false); }
  }
  function resetEditor(start = '') {
    setConfirmationToken(undefined);
    setEditing(null);
    setDraft({ title: '', start, end: start ? localTime(new Date(Date.parse(toInstant(start)) + 3600_000).toISOString()) : '', reminderAt: '', allDay: false, hidden: false, confirmOverlap: false });
  }
  function create(start = '') {
    setTaskActive(false);
    resetEditor(start);
    setError('');
    document.getElementById('event-editor')?.scrollIntoView({ block: 'center' });
  }
  function edit(event: PlannerEvent) {
    setConfirmationToken(undefined);
    setTaskActive(false);
    setEditing(event);
    setDraft({ title: event.title, start: localTime(event.start), end: localTime(event.end), reminderAt: event.reminderAt ? localTime(event.reminderAt) : '', allDay: event.allDay ?? false, hidden: event.hidden ?? false, confirmOverlap: false });
    setError('');
    document.getElementById('event-editor')?.scrollIntoView({ block: 'center' });
  }
  useEffect(() => {
    if (isAuthPage) return;
    void request<AuthResponse>('/api/auth/me').then(result => setEmail(result.user.email)).catch(() => location.assign('/login'));
    void request<PlannerEvent[]>('/api/events').then(setEvents).catch(e => setError(e.message));
    void request<PlannerTask[]>('/api/tasks').then(setTasks).catch(e => setError(e.message));
  }, [isAuthPage]);
  async function authenticate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError('');
    const data = new FormData(e.currentTarget);
    const credentials: Credentials = { email: String(data.get('email')), password: String(data.get('password')) };
    try {
      await request<AuthResponse>(`/api/auth/${mode}`, 'POST', credentials);
      history.replaceState(null, '', '/');
      setIsAuthPage(false);
    }
    catch (e) { setError((e as Error).message); }
  }
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError('');
    setSaving(true);
    try {
      const input: EventInput = { ...draft, reminderAt: draft.reminderAt ? toInstant(draft.reminderAt) : null, confirmationToken, start: toInstant(draft.start), end: toInstant(draft.end) };
      await request<PlannerEvent>(editing ? `/api/events/${editing.id}` : '/api/events', editing ? 'PATCH' : 'POST', input);
      setEvents(await request<PlannerEvent[]>('/api/events'));
      resetEditor();
    }
    catch (e) {
      setConfirmationToken(e instanceof RequestError ? e.data.confirmationToken : undefined);
      setDraft(current => ({ ...current, confirmOverlap: false }));
      setError((e as Error).message);
    }
    finally { setSaving(false); }
  }
  async function remove() {
    if (!editing || !window.confirm(`刪除「${editing.title}」？`)) return;
    setError(''); setSaving(true);
    try {
      await request(`/api/events/${editing.id}`, 'DELETE');
      setEvents(await request<PlannerEvent[]>('/api/events'));
      resetEditor();
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  }
  return <main><h1>Life Planner</h1>{error && <p role="alert">{error}</p>}{isAuthPage ? <>
    <h2>{mode === 'register' ? '建立帳號' : '登入帳號'}</h2>
    <form onSubmit={authenticate}>
      <label>電子郵件<input name="email" type="email" autoComplete="email" required /></label>
      <label>密碼<input name="password" type="password" minLength={12} maxLength={128} autoComplete={mode === 'register' ? 'new-password' : 'current-password'} required /></label>
      <button>{mode === 'register' ? '註冊' : '登入'}</button>
    </form><a href={mode === 'register' ? '/login' : '/register'}>{mode === 'register' ? '已有帳號，前往登入' : '建立新帳號'}</a>
  </> : <>
    <p>{email}</p><button onClick={async () => { await request('/api/auth/logout', 'POST'); location.assign('/login'); }}>登出</button>
    <DueReminders events={events} tasks={tasks} />
    <h2>行事曆</h2><div className="calendar-toolbar">
      <button type="button" aria-pressed={view === '日'} onClick={() => setView('日')}>日</button>
      <button type="button" aria-pressed={view === '週'} onClick={() => setView('週')}>週</button>
      <label>日期<input type="date" required value={date} onChange={e => { if (e.target.value) setDate(e.target.value); }} /></label>
      <button type="button" onClick={() => setDate(shiftDate(date, view === '日' ? -1 : -7))}>上一{view}</button>
      <button type="button" onClick={() => setDate(localTime(new Date().toISOString()).slice(0, 10))}>今天</button>
      <button type="button" onClick={() => setDate(shiftDate(date, view === '日' ? 1 : 7))}>下一{view}</button>
    </div>
    <label className="confirm"><input type="checkbox" checked={showHidden} onChange={e => setShowHidden(e.target.checked)} />顯示隱藏行程</label>
    <Calendar view={view} date={date} events={events.filter(event => showHidden || !event.hidden)} onCreate={create} onEdit={edit} />
    <h2 id="event-editor">{editing ? '修改行程' : '新增行程'}</h2><p>時間以台北時區（UTC+8）輸入與顯示。點選時間格新增，或點選行程修改與刪除。</p><form onSubmit={save}>
      <label>行程名稱<input name="title" maxLength={200} required value={draft.title} onFocus={() => setTaskActive(false)} onChange={e => setDraft({ ...draft, title: e.target.value })} /></label>
      {!taskActive && <>
      <label>開始時間<input name="start" type="datetime-local" required value={draft.start} onChange={e => { setConfirmationToken(undefined); setDraft({ ...draft, start: e.target.value, confirmOverlap: false }); }} /></label>
      <label>結束時間<input name="end" type="datetime-local" required value={draft.end} onChange={e => { setConfirmationToken(undefined); setDraft({ ...draft, end: e.target.value, confirmOverlap: false }); }} /></label>
      <label>行程提醒時間<input type="datetime-local" value={draft.reminderAt} onChange={e => setDraft({ ...draft, reminderAt: e.target.value })} /></label>
      <label className="confirm"><input name="allDay" type="checkbox" checked={draft.allDay} onChange={e => setDraft({ ...draft, allDay: e.target.checked })} />全天</label>
      {draft.allDay && <p>全天起訖須為台北時間午夜；結束日期不包含在行程內。</p>}
      <label className="confirm"><input name="hidden" type="checkbox" checked={draft.hidden} onChange={e => setDraft({ ...draft, hidden: e.target.checked })} />隱藏行程</label>
      <label className="confirm"><input name="confirmOverlap" type="checkbox" disabled={saving} checked={draft.confirmOverlap} onChange={e => { void confirmEvent(e.target.checked); }} />確認允許時段重疊</label>
      <button disabled={saving}>儲存行程</button>
      {editing && <button type="button" disabled={saving} onClick={remove}>刪除行程</button>}
      <button type="button" disabled={saving} onClick={() => create()}>取消編輯</button>
      </>}
    </form>
    <TaskEditor key={taskEditorVersion} editing={editingTask} active={taskActive} onActivate={() => setTaskActive(true)} onSave={saveTask} onConfirm={confirmTask}
      onCancel={() => { setTaskConfirmationToken(undefined); setEditingTask(null); setTaskActive(false); setTaskEditorVersion(v => v + 1); setError(''); }} />
    <section aria-label="未排程待辦"><h2>未排程待辦</h2><ul>{tasks.filter(task => task.start === null).map(task =>
      <li key={task.id} data-testid={`task-${task.id}`}><strong>{task.title}</strong>
        <TaskControls task={task} onEdit={editTask} onComplete={completeTask} />
      </li>)}</ul>{!tasks.some(task => task.start === null) && <p>尚無未排程待辦</p>}</section>
    <EventList view={view} date={date} events={events} onEdit={edit} tasks={tasks} onEditTask={editTask} onCompleteTask={completeTask} />
  </>}</main>;
}
createRoot(document.getElementById('root')!).render(<App />);
