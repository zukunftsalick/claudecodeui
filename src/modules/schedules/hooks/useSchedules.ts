import { useCallback, useEffect, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import type { ScheduledTask, ScheduledTaskDraft } from '@/shared/types';

// Faster while a run is going, so its status flips soon after it ends.
const RUNNING_POLL_MS = 5_000;
const IDLE_POLL_MS = 30_000;

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Loads the scheduled tasks for the Schedules tab and wraps every change to
 * them (create, edit, pause, delete, run now, import), reloading the list
 * after each one and polling while the tab is open.
 */
export function useSchedules() {
  // Every scheduled task, as the server lists them.
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  // True until the first load answers, so the empty state does not flash.
  const [loading, setLoading] = useState(true);
  // The last load or action error, shown above the list; cleared by the next success.
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await readApiJson<{ data: { tasks: ScheduledTask[] } }>(await api.schedules.list());
      setTasks(response.data.tasks);
      setError(null);
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  const anyRunning = tasks.some((task) => task.isRunning);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), anyRunning ? RUNNING_POLL_MS : IDLE_POLL_MS);
    return () => clearInterval(timer);
  }, [refresh, anyRunning]);

  /** Runs an action, then reloads; rethrows so a form can show the message beside its fields. */
  const act = useCallback(async <T,>(action: () => Promise<Response>): Promise<T> => {
    const response = await readApiJson<{ data: T }>(await action());
    await refresh();
    return response.data;
  }, [refresh]);

  /** Runs an action whose error belongs above the list rather than in a form. */
  const actQuietly = useCallback(async (action: () => Promise<Response>) => {
    try {
      await act(action);
    } catch (actionError) {
      setError(errorMessage(actionError));
    }
  }, [act]);

  return {
    tasks,
    loading,
    error,
    refresh,
    save: (draft: ScheduledTaskDraft, id: string | null) => act<ScheduledTask>(() => (id ? api.schedules.update(id, draft) : api.schedules.create(draft))),
    importTasks: (projectPath: string, data: unknown) => act<{ imported: ScheduledTask[]; skipped: Array<{ name: string; reason: string }> }>(
      () => api.schedules.importTasks(projectPath, data),
    ),
    setEnabled: (id: string, enabled: boolean) => actQuietly(() => api.schedules.setEnabled(id, enabled)),
    remove: (id: string) => actQuietly(() => api.schedules.remove(id)),
    runNow: (id: string) => actQuietly(() => api.schedules.runNow(id)),
  };
}
