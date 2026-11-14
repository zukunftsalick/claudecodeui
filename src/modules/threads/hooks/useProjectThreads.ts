import { useCallback, useEffect, useRef, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import type { ProjectThreadsOverview } from '@/shared/types';

// Same cadence as the dev-server list: a thread's status change shows within moments.
const POLL_INTERVAL_MS = 4000;

type ProjectThreadsState = {
  overview: ProjectThreadsOverview | null;
  // How many cards say "Waiting for you"; drives the header badge.
  waitingCount: number;
  // Polls again right away, after the pane changed something.
  refresh: () => void;
};

/**
 * Used by the project-workspace module to poll the threads of the selected
 * project for the header button and the threads pane. Pauses while the tab is
 * hidden and starts over when the project changes.
 */
export function useProjectThreads(projectPath: string | null): ProjectThreadsState {
  // The latest overview and the project it was polled for, so a stale answer
  // for the previous project is never shown after switching projects.
  const [latest, setLatest] = useState<ProjectThreadsOverview | null>(null);
  const pollNowRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (!projectPath) return undefined;
    let cancelled = false;
    let timer: number | null = null;

    const schedule = () => {
      if (!cancelled) timer = window.setTimeout(poll, POLL_INTERVAL_MS);
    };

    // One poll at a time: a refresh asked for mid-request runs right after it,
    // instead of starting a second timer chain.
    let inFlight = false;
    let pollAgain = false;

    const poll = async () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      if (inFlight) {
        pollAgain = true;
        return;
      }
      if (document.hidden) {
        schedule();
        return;
      }
      inFlight = true;
      try {
        const response = await readApiJson<{ data: ProjectThreadsOverview }>(await api.threads.overview(projectPath));
        if (!cancelled) setLatest(response.data);
      } catch {
        // Older server without the route, or offline: try again later.
      } finally {
        inFlight = false;
      }
      if (cancelled) return;
      if (pollAgain) {
        pollAgain = false;
        void poll();
        return;
      }
      schedule();
    };

    pollNowRef.current = () => {
      void poll();
    };
    void poll();
    return () => {
      cancelled = true;
      pollNowRef.current = () => undefined;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [projectPath]);

  const refresh = useCallback(() => pollNowRef.current(), []);

  const overview = latest && latest.projectPath === projectPath ? latest : null;
  const cards = overview ? [...(overview.coordinator ? [overview.coordinator] : []), ...overview.threads] : [];
  const waitingCount = cards.filter((card) => card.status === 'waiting').length;

  return { overview, waitingCount, refresh };
}
