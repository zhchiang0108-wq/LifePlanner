import React, { useState, type FormEvent } from 'react';
import type { PlannerTask, TaskInput } from './shared';
import { localTime, toInstant } from './calendar';

export function TaskControls({ task, onEdit, onComplete }: {
  task: PlannerTask; onEdit(task: PlannerTask): void;
  onComplete(task: PlannerTask, completed: boolean): Promise<void>;
}) {
  const [pendingCompletion, setPendingCompletion] = useState<boolean | null>(null);
  return <><button type="button" onClick={() => onEdit(task)}>編輯待辦</button>
    <label className="confirm"><input type="checkbox" checked={pendingCompletion ?? task.completed} disabled={pendingCompletion !== null}
      onChange={async e => {
        const completed = e.currentTarget.checked;
        setPendingCompletion(completed);
        try { await onComplete(task, completed); }
        finally { setPendingCompletion(null); }
      }} />已完成</label></>;
}

export function TaskEditor({ editing, active, onActivate, onCancel, onSave, onConfirm }: {
  editing: PlannerTask | null; active: boolean; onActivate(): void; onCancel(): void;
  onSave(input: TaskInput): Promise<boolean>;
  onConfirm(input: TaskInput): Promise<void>;
}) {
  const [draft, setDraft] = useState({ title: editing?.title ?? '', start: editing?.start ? localTime(editing.start) : '',
    reminderAt: editing?.reminderAt ? localTime(editing.reminderAt) : '', end: editing?.end ? localTime(editing.end) : '', confirmOverlap: false });
  const [saving, setSaving] = useState(false);
  function taskInput(): TaskInput {
    return { ...draft, reminderAt: draft.reminderAt ? toInstant(draft.reminderAt) : null,
      start: draft.start ? toInstant(draft.start) : null, end: draft.end ? toInstant(draft.end) : null };
  }
  async function save(e: FormEvent) {
    e.preventDefault(); setSaving(true);
    try {
      if (await onSave(taskInput())) {
        setDraft({ title: '', start: '', end: '', reminderAt: '', confirmOverlap: false });
      } else {
        setDraft(current => ({ ...current, confirmOverlap: false }));
      }
    } finally { setSaving(false); }
  }
  return <section aria-label="待辦編輯" id="task-editor"><h2>{editing ? '修改待辦' : '新增待辦'}</h2>
    <form onSubmit={save} onFocus={onActivate}>
      <label>待辦名稱<input required maxLength={200} value={draft.title} onChange={e => setDraft({ ...draft, title: e.target.value })} /></label>
      {active && <><p>時間以台北時區輸入；起訖皆留空可建立未排程待辦。</p>
        <label>開始時間<input type="datetime-local" value={draft.start} onChange={e => setDraft({ ...draft, start: e.target.value, confirmOverlap: false })} /></label>
        <label>結束時間<input type="datetime-local" value={draft.end} onChange={e => setDraft({ ...draft, end: e.target.value, confirmOverlap: false })} /></label>
        <label>待辦提醒時間<input type="datetime-local" value={draft.reminderAt} onChange={e => setDraft({ ...draft, reminderAt: e.target.value })} /></label>
        <label className="confirm"><input type="checkbox" disabled={saving} checked={draft.confirmOverlap} onChange={async e => {
          const checked = e.target.checked;
          setDraft(current => ({ ...current, confirmOverlap: checked }));
          if (!checked) return;
          setSaving(true);
          try { await onConfirm(taskInput()); }
          catch { setDraft(current => ({ ...current, confirmOverlap: false })); }
          finally { setSaving(false); }
        }} />確認允許待辦時段重疊</label>
        <button disabled={saving}>儲存待辦</button><button type="button" disabled={saving} onClick={onCancel}>取消待辦編輯</button>
      </>}
    </form>
  </section>;
}
