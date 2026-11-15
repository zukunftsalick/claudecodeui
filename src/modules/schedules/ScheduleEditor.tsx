import { useState } from 'react';
import type { FormEvent } from 'react';

import type { ScheduledTask, ScheduledTaskDraft } from '@/shared/types';

type ScheduleEditorProps = {
  // The task being edited, or null for a new one.
  task: ScheduledTask | null;
  // Folder a new task runs in when none is typed: the open project.
  defaultProjectPath: string;
  onSave: (draft: ScheduledTaskDraft) => Promise<unknown>;
  onCancel: () => void;
};

const PRESETS: Array<{ label: string; cron: string }> = [
  { label: 'Every day 08:00', cron: '0 8 * * *' },
  { label: 'Weekdays 09:00', cron: '0 9 * * 1-5' },
  { label: 'Mondays 10:00', cron: '0 10 * * 1' },
  { label: 'Sundays 10:00', cron: '0 10 * * 0' },
  { label: 'Every hour', cron: '0 * * * *' },
  { label: '1st of the month', cron: '0 9 1 * *' },
];

const PERMISSION_MODES: Array<{ value: string; label: string }> = [
  { value: 'auto', label: 'Auto: Claude decides what is safe (recommended)' },
  { value: 'acceptEdits', label: 'Accept edits: file edits only, commands are refused' },
  { value: 'bypassPermissions', label: 'Bypass: allow everything' },
  { value: 'plan', label: 'Plan: read only, no changes' },
];

const browserTimeZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

/** An ISO instant as the value of a datetime-local input, in the browser's zone. */
const toLocalInput = (iso: string | null): string => {
  if (!iso) return '';
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

const fieldClass = 'w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground';
const labelClass = 'mb-1 block text-xs font-medium text-muted-foreground';

/** The create and edit form of the Schedules tab. */
export function ScheduleEditor({ task, defaultProjectPath, onSave, onCancel }: ScheduleEditorProps) {
  // The task's name, shown in the list and on each run's chat title.
  const [name, setName] = useState(task?.name ?? '');
  // What Claude is asked to do on every run.
  const [prompt, setPrompt] = useState(task?.prompt ?? '');
  // The folder each run's chat opens in.
  const [projectPath, setProjectPath] = useState(task?.projectPath ?? defaultProjectPath);
  // Repeat on a cron schedule, or run once at a set time.
  const [mode, setMode] = useState<'repeat' | 'once'>(task && !task.cronExpression && task.runOnceAt ? 'once' : 'repeat');
  // The five-field cron expression for a repeating task.
  const [cronExpression, setCronExpression] = useState(task?.cronExpression ?? '0 8 * * *');
  // The zone the cron expression is read in.
  const [timezone, setTimezone] = useState(task?.timezone ?? browserTimeZone());
  // The datetime-local value for a one-off task, in the browser's zone.
  const [runOnceLocal, setRunOnceLocal] = useState(toLocalInput(task?.runOnceAt ?? null));
  // How freely an unattended run may act.
  const [permissionMode, setPermissionMode] = useState(task?.runOptions.permissionMode ?? 'auto');
  // Optional model override, blank for the default.
  const [model, setModel] = useState(task?.runOptions.model ?? '');
  // Whether the task is switched on after saving.
  const [enabled, setEnabled] = useState(task?.enabled ?? true);
  // True while the save request is in flight.
  const [saving, setSaving] = useState(false);
  // Why the server refused the save, shown above the buttons.
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await onSave({
        name,
        prompt,
        projectPath,
        cronExpression: mode === 'repeat' ? cronExpression : null,
        timezone,
        runOnceAt: mode === 'once' && runOnceLocal ? new Date(runOnceLocal).toISOString() : null,
        enabled,
        runOptions: { permissionMode, ...(model.trim() ? { model: model.trim() } : {}) },
      });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
      setSaving(false);
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="mx-auto max-w-2xl space-y-4 p-4">
      <h2 className="text-base font-semibold text-foreground">{task ? 'Edit scheduled task' : 'New scheduled task'}</h2>

      <div>
        <label className={labelClass} htmlFor="schedule-name">Name</label>
        <input id="schedule-name" className={fieldClass} value={name} onChange={(event) => setName(event.target.value)} placeholder="Morning repo check" required />
      </div>

      <div>
        <label className={labelClass} htmlFor="schedule-prompt">Prompt</label>
        <textarea
          id="schedule-prompt"
          className={`${fieldClass} min-h-40 font-mono text-xs`}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="What Claude should do on every run. Its last message is sent to you as the report."
          required
        />
      </div>

      <div>
        <label className={labelClass} htmlFor="schedule-folder">Folder on the server</label>
        <input id="schedule-folder" className={`${fieldClass} font-mono text-xs`} value={projectPath} onChange={(event) => setProjectPath(event.target.value)} required />
      </div>

      <div>
        <span className={labelClass}>When</span>
        <div className="mb-2 flex gap-2 text-sm">
          {(['repeat', 'once'] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setMode(value)}
              className={`rounded-md border px-3 py-1 ${mode === value ? 'border-primary bg-primary/10 text-foreground' : 'border-border text-muted-foreground hover:bg-accent'}`}
            >
              {value === 'repeat' ? 'Repeat' : 'Once'}
            </button>
          ))}
        </div>

        {mode === 'repeat' ? (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-1">
              {PRESETS.map((preset) => (
                <button
                  key={preset.cron}
                  type="button"
                  onClick={() => setCronExpression(preset.cron)}
                  className={`rounded border px-2 py-0.5 text-xs ${cronExpression === preset.cron ? 'border-primary text-foreground' : 'border-border text-muted-foreground hover:bg-accent'}`}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <input className={`${fieldClass} font-mono`} value={cronExpression} onChange={(event) => setCronExpression(event.target.value)} aria-label="Cron expression" />
            <p className="text-xs text-muted-foreground">Cron: minute, hour, day of month, month, day of week. For example <code>47 10 * * 0</code> is Sundays at 10:47.</p>
            <div>
              <label className={labelClass} htmlFor="schedule-timezone">Time zone</label>
              <input id="schedule-timezone" className={fieldClass} value={timezone} onChange={(event) => setTimezone(event.target.value)} placeholder="Asia/Hong_Kong" />
            </div>
          </div>
        ) : (
          <div>
            <input type="datetime-local" className={fieldClass} value={runOnceLocal} onChange={(event) => setRunOnceLocal(event.target.value)} aria-label="Run at" required />
            <p className="mt-1 text-xs text-muted-foreground">In this device&apos;s time zone. It switches itself off after it runs.</p>
          </div>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className={labelClass} htmlFor="schedule-permissions">Permissions</label>
          <select id="schedule-permissions" className={fieldClass} value={permissionMode} onChange={(event) => setPermissionMode(event.target.value)}>
            {PERMISSION_MODES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </div>
        <div>
          <label className={labelClass} htmlFor="schedule-model">Model (optional)</label>
          <input id="schedule-model" className={fieldClass} value={model} onChange={(event) => setModel(event.target.value)} placeholder="Default" />
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm text-foreground">
        <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
        Switched on
      </label>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      <div className="flex gap-2">
        <button type="submit" disabled={saving} className="rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60">
          {saving ? 'Saving...' : 'Save'}
        </button>
        <button type="button" onClick={onCancel} className="rounded-md border border-border px-4 py-1.5 text-sm text-foreground hover:bg-accent">
          Cancel
        </button>
      </div>
    </form>
  );
}
