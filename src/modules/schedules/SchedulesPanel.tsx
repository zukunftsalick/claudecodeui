import { useEffect, useState } from 'react';
import type { ChangeEvent } from 'react';
import {
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Loader2,
  MessageSquare,
  Pause,
  Pencil,
  Play,
  Plus,
  Power,
  RefreshCw,
  SkipForward,
  Trash2,
  Upload,
  XCircle,
} from 'lucide-react';

import { api, readApiJson } from '@/shared/api';
import type { ScheduledTask, ScheduledTaskRun } from '@/shared/types';
import { cn } from '@/shared/utils';
import { useSchedules } from '@/modules/schedules/hooks/useSchedules';
import { ScheduleEditor } from '@/modules/schedules/ScheduleEditor';

type SchedulesPanelProps = {
  // The open project's folder: the default folder for new and imported tasks.
  projectPath: string | null;
  // Opens a run's chat in the Chat tab.
  onOpenSession: (sessionId: string) => void;
};

/** Shows a date relative to now, e.g. "in 3h" or "5m ago". Exported for tests. */
export function formatRelative(iso: string | null, now: number = Date.now()): string {
  if (!iso) return '';
  const diffSeconds = Math.round((new Date(iso).getTime() - now) / 1000);
  const future = diffSeconds > 0;
  const seconds = Math.abs(diffSeconds);
  let text: string;
  if (seconds < 60) text = future ? 'under a minute' : 'just now';
  else if (seconds < 3600) text = `${Math.round(seconds / 60)}m`;
  else if (seconds < 48 * 3600) text = `${Math.round(seconds / 3600)}h`;
  else text = `${Math.round(seconds / 86400)}d`;
  if (text === 'just now') return text;
  return future ? `in ${text}` : `${text} ago`;
}

const formatDateTime = (iso: string): string => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function RunStatusIcon({ run, isRunning }: { run: ScheduledTaskRun | null; isRunning?: boolean }) {
  if (isRunning || run?.status === 'running') return <Loader2 className="h-4 w-4 flex-shrink-0 animate-spin text-blue-600 dark:text-blue-400" aria-label="Running" />;
  if (!run) return <Circle className="h-4 w-4 flex-shrink-0 text-muted-foreground" aria-label="Never run" />;
  if (run.status === 'succeeded') return <CheckCircle2 className="h-4 w-4 flex-shrink-0 text-green-600 dark:text-green-400" aria-label="Succeeded" />;
  if (run.status === 'skipped') return <SkipForward className="h-4 w-4 flex-shrink-0 text-amber-600 dark:text-amber-400" aria-label="Skipped" />;
  return <XCircle className="h-4 w-4 flex-shrink-0 text-red-600 dark:text-red-400" aria-label="Failed" />;
}

// The last runs of one task, loaded when its row is expanded.
function RunHistory({ task, onOpenSession }: { task: ScheduledTask; onOpenSession: (sessionId: string) => void }) {
  // The task's recent runs, newest first.
  const [runs, setRuns] = useState<ScheduledTaskRun[] | null>(null);
  // Why the history could not be loaded.
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await readApiJson<{ data: { runs: ScheduledTaskRun[] } }>(await api.schedules.runs(task.id));
        if (!cancelled) setRuns(response.data.runs);
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : String(loadError));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [task.id, task.lastRun?.id, task.lastRun?.status]);

  if (error) return <p className="px-4 pb-3 text-xs text-red-600 dark:text-red-400">{error}</p>;
  if (!runs) return <p className="px-4 pb-3 text-xs text-muted-foreground">Loading runs...</p>;

  return (
    <div className="space-y-3 px-4 pb-4">
      <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md bg-muted px-3 py-2 font-mono text-xs text-foreground">{task.prompt}</pre>
      {runs.length === 0 && <p className="text-xs text-muted-foreground">No runs yet.</p>}
      <ul className="divide-y divide-border rounded-md border border-border">
        {runs.map((run) => (
          <li key={run.id} className="space-y-1 px-3 py-2 text-xs">
            <div className="flex items-center gap-2">
              <RunStatusIcon run={run} />
              <span className="text-foreground">{formatDateTime(run.startedAt)}</span>
              <span className="text-muted-foreground">{run.trigger === 'manual' ? 'run by hand' : 'on schedule'}</span>
              {run.sessionId && (
                <button type="button" onClick={() => onOpenSession(run.sessionId!)} className="ml-auto flex items-center gap-1 text-blue-600 hover:underline dark:text-blue-400">
                  <MessageSquare className="h-3 w-3" /> Open chat
                </button>
              )}
            </div>
            {run.error && <p className="text-red-600 dark:text-red-400">{run.error}</p>}
            {run.lastReply && <p className="line-clamp-4 whitespace-pre-wrap text-muted-foreground">{run.lastReply}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}

// Paste or pick an exported tasks file; everything imported starts paused.
function ImportForm({ projectPath, onImport, onClose }: {
  projectPath: string;
  onImport: (projectPath: string, data: unknown) => Promise<{ imported: ScheduledTask[]; skipped: Array<{ name: string; reason: string }> }>;
  onClose: () => void;
}) {
  // The pasted or loaded JSON text.
  const [text, setText] = useState('');
  // The folder tasks without their own folder run in.
  const [folder, setFolder] = useState(projectPath);
  // What the last import did, or why it failed.
  const [result, setResult] = useState<string | null>(null);
  // True while the import request is in flight.
  const [busy, setBusy] = useState(false);

  const loadFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) setText(await file.text());
  };

  const submit = async () => {
    setBusy(true);
    try {
      const outcome = await onImport(folder, JSON.parse(text));
      const skipped = outcome.skipped.map((entry) => `${entry.name}: ${entry.reason}`).join('; ');
      setResult(`Imported ${outcome.imported.length} task(s), all paused.${skipped ? ` Skipped: ${skipped}` : ''}`);
    } catch (importError) {
      setResult(importError instanceof SyntaxError ? 'That is not valid JSON.' : importError instanceof Error ? importError.message : String(importError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 border-b border-border bg-muted/30 p-4">
      <p className="text-sm text-foreground">Import scheduled tasks from an export file. They come in paused, so switch each one on once its copy elsewhere is off.</p>
      <input type="file" accept="application/json,.json" onChange={(event) => void loadFile(event)} className="text-xs" />
      <textarea className="min-h-28 w-full rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs" value={text} onChange={(event) => setText(event.target.value)} placeholder='{"tasks": [...]}' />
      <div>
        <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor="schedules-import-folder">Folder for tasks that do not name one</label>
        <input id="schedules-import-folder" className="w-full rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs" value={folder} onChange={(event) => setFolder(event.target.value)} />
      </div>
      {result && <p className="text-xs text-foreground">{result}</p>}
      <div className="flex gap-2">
        <button type="button" disabled={busy || !text.trim() || !folder.trim()} onClick={() => void submit()} className="rounded-md bg-primary px-3 py-1 text-sm text-primary-foreground disabled:opacity-60">Import</button>
        <button type="button" onClick={onClose} className="rounded-md border border-border px-3 py-1 text-sm">Close</button>
      </div>
    </div>
  );
}

/** Used by the project-workspace module to render the Schedules tab: scheduled Claude tasks the server runs on a timer. */
export function SchedulesPanel({ projectPath, onOpenSession }: SchedulesPanelProps) {
  const schedules = useSchedules();
  // The task open in the editor: null for none, 'new' for a new one.
  const [editing, setEditing] = useState<ScheduledTask | 'new' | null>(null);
  // Whether the import form is showing above the list.
  const [importing, setImporting] = useState(false);
  // Rows whose run history is expanded.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // The task whose Delete was pressed once and waits for a second press.
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  // Ticks every 30s so "in 3h" labels stay current.
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  if (editing) {
    return (
      <div className="h-full overflow-y-auto bg-background">
        <ScheduleEditor
          task={editing === 'new' ? null : editing}
          defaultProjectPath={projectPath ?? ''}
          onSave={async (draft) => {
            await schedules.save(draft, editing === 'new' ? null : editing.id);
            setEditing(null);
          }}
          onCancel={() => setEditing(null)}
        />
      </div>
    );
  }

  const toggleExpanded = (id: string) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex flex-shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <CalendarClock className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold text-foreground">Scheduled tasks</h2>
        <span className="text-xs text-muted-foreground">{schedules.tasks.length ? `${schedules.tasks.filter((task) => task.enabled).length} of ${schedules.tasks.length} on` : ''}</span>
        <div className="ml-auto flex items-center gap-1">
          <button type="button" onClick={() => void schedules.refresh()} className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground" title="Refresh">
            <RefreshCw className="h-4 w-4" />
          </button>
          <button type="button" onClick={() => setImporting((value) => !value)} className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
            <Upload className="h-3.5 w-3.5" /> Import
          </button>
          <button type="button" onClick={() => setEditing('new')} className="flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground hover:bg-primary/90">
            <Plus className="h-3.5 w-3.5" /> New task
          </button>
        </div>
      </div>

      {importing && <ImportForm projectPath={projectPath ?? ''} onImport={schedules.importTasks} onClose={() => setImporting(false)} />}
      {schedules.error && <p className="border-b border-border px-4 py-2 text-xs text-red-600 dark:text-red-400">{schedules.error}</p>}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!schedules.loading && schedules.tasks.length === 0 && (
          <div className="mx-auto max-w-md space-y-2 p-8 text-center text-sm text-muted-foreground">
            <p className="text-foreground">No scheduled tasks yet.</p>
            <p>Each run starts a new chat in the task&apos;s folder, so you can read it and carry on from there. Set SCHEDULES_NTFY_URL on the server to get a phone notification when a run ends.</p>
          </div>
        )}

        <ul className="divide-y divide-border">
          {schedules.tasks.map((task) => {
            const isOpen = expanded.has(task.id);
            return (
              <li key={task.id} className={cn(!task.enabled && 'opacity-70')}>
                <div className="flex flex-wrap items-center gap-2 px-4 py-2.5">
                  <button type="button" onClick={() => toggleExpanded(task.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left" aria-expanded={isOpen}>
                    {isOpen ? <ChevronDown className="h-4 w-4 flex-shrink-0 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 flex-shrink-0 text-muted-foreground" />}
                    <RunStatusIcon run={task.lastRun} isRunning={task.isRunning} />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-foreground">{task.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {task.cronExpression ? `${task.scheduleLabel} (${task.timezone})` : task.runOnceAt ? `Once, ${formatDateTime(task.runOnceAt)}` : task.scheduleLabel}
                        {' · '}
                        {task.isRunning ? 'running now' : task.enabled && task.nextRunAt ? `next ${formatRelative(task.nextRunAt, now)}` : 'paused'}
                        {task.lastRun && !task.isRunning ? ` · last ${formatRelative(task.lastRun.startedAt, now)}` : ''}
                      </span>
                      <span className="block truncate font-mono text-[11px] text-muted-foreground/80">{task.projectPath}</span>
                    </span>
                  </button>
                  <div className="flex items-center gap-1">
                    {task.lastRun?.sessionId && (
                      <button type="button" onClick={() => onOpenSession(task.lastRun!.sessionId!)} className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground" title="Open the last run's chat">
                        <MessageSquare className="h-4 w-4" />
                      </button>
                    )}
                    <button type="button" disabled={task.isRunning} onClick={() => void schedules.runNow(task.id)} className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40" title="Run now">
                      <Play className="h-4 w-4" />
                    </button>
                    <button type="button" onClick={() => void schedules.setEnabled(task.id, !task.enabled)} className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground" title={task.enabled ? 'Pause' : 'Switch on'}>
                      {task.enabled ? <Pause className="h-4 w-4" /> : <Power className="h-4 w-4" />}
                    </button>
                    <button type="button" onClick={() => setEditing(task)} className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground" title="Edit">
                      <Pencil className="h-4 w-4" />
                    </button>
                    {confirmDelete === task.id ? (
                      <button type="button" autoFocus onBlur={() => setConfirmDelete(null)} onClick={() => { setConfirmDelete(null); void schedules.remove(task.id); }} className="rounded-md bg-red-600 px-2 py-1 text-xs text-white hover:bg-red-700">
                        Delete?
                      </button>
                    ) : (
                      <button type="button" onClick={() => setConfirmDelete(task.id)} className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-red-600" title="Delete">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </div>
                {isOpen && <RunHistory task={task} onOpenSession={onOpenSession} />}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
