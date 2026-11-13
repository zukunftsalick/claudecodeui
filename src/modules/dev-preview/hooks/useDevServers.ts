import { useEffect, useRef, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import type { DevPreviewStatus } from '@/shared/types';

// Often enough that a server Claude just started shows up within moments.
const POLL_INTERVAL_MS = 4000;

/**
 * Polls the VPS for dev servers that can be previewed. Stops after the first
 * answer when previews aren't set up on the server, and pauses while the tab
 * is hidden. `onNewServer` fires for each port that appears after the first
 * poll, so servers already running at page load never pop open.
 */
export function useDevServers(onNewServer?: (port: number) => void): DevPreviewStatus | null {
  // The latest answer from the server; null until the first poll lands.
  const [status, setStatus] = useState<DevPreviewStatus | null>(null);
  const onNewServerRef = useRef(onNewServer);
  onNewServerRef.current = onNewServer;

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    // Ports seen so far; null until the first poll, which only records them.
    let knownPorts: Set<number> | null = null;

    const poll = async () => {
      timer = null;
      if (document.hidden) {
        timer = window.setTimeout(poll, POLL_INTERVAL_MS);
        return;
      }
      try {
        const next = await readApiJson<DevPreviewStatus>(await api.devPreview.status());
        if (cancelled) return;
        setStatus(next);
        const ports = new Set(next.servers.map((server) => server.port));
        if (knownPorts) {
          for (const port of ports) {
            if (!knownPorts.has(port)) onNewServerRef.current?.(port);
          }
        }
        knownPorts = ports;
        if (!next.enabled) return;
      } catch {
        // Older server without the route, or offline: try again later.
      }
      if (!cancelled) timer = window.setTimeout(poll, POLL_INTERVAL_MS);
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, []);

  return status;
}
