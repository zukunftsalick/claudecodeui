import type { ScheduledTaskRun, ScheduledTaskSummary } from '@/modules/schedules/schedules.service.js';

/**
 * Phone notifications for finished scheduled runs, through ntfy
 * (https://ntfy.sh or a self-hosted server). Off unless SCHEDULES_NTFY_URL is
 * set to a full topic URL, such as https://ntfy.sh/some-long-random-topic.
 *
 * - SCHEDULES_NTFY_TOKEN: optional access token, for a protected topic.
 * - SCHEDULES_NTFY_INCLUDE_REPLY: "0" sends only the task name and outcome;
 *   anything else also sends the start of Claude's last message, which is the
 *   run's report. Anyone who knows a public ntfy.sh topic can read it, so use
 *   a long random topic name or a protected one.
 * - SCHEDULES_PUBLIC_URL: the harness address (https://code.example.com), so a
 *   tap on the notification opens the run's chat.
 */

const MAX_BODY_CHARS = 1_500;
const TIMEOUT_MS = 10_000;

type NtfyConfig = { url: string; token: string | null; includeReply: boolean; publicUrl: string | null };

/** Reads the ntfy settings from the environment; null when notifications are off. Exported for tests. */
export function readNtfyConfig(env: NodeJS.ProcessEnv = process.env): NtfyConfig | null {
  const url = env.SCHEDULES_NTFY_URL?.trim();
  if (!url) return null;
  return {
    url,
    token: env.SCHEDULES_NTFY_TOKEN?.trim() || null,
    includeReply: env.SCHEDULES_NTFY_INCLUDE_REPLY?.trim() !== '0',
    publicUrl: env.SCHEDULES_PUBLIC_URL?.trim().replace(/\/+$/, '') || null,
  };
}

/** The request a finished run turns into. Exported for tests. */
export function buildNtfyRequest(config: NtfyConfig, task: ScheduledTaskSummary, run: ScheduledTaskRun): { url: string; headers: Record<string, string>; body: string } {
  const failed = run.status === 'failed';
  let body: string;
  if (failed) body = `Failed: ${run.error ?? 'unknown error'}`;
  else if (config.includeReply && run.lastReply) body = run.lastReply;
  else body = 'Finished.';
  if (body.length > MAX_BODY_CHARS) body = `${body.slice(0, MAX_BODY_CHARS)}…`;

  const headers: Record<string, string> = {
    // ntfy reads the title from a header, which must be plain ASCII.
    Title: `${failed ? 'Failed' : 'Done'}: ${task.name}`.replace(/[^\x20-\x7E]/g, '?').slice(0, 200),
    Tags: failed ? 'warning' : 'white_check_mark',
    Priority: failed ? 'high' : 'default',
    Markdown: 'yes',
  };
  if (config.token) headers.Authorization = `Bearer ${config.token}`;
  if (config.publicUrl && run.sessionId) headers.Click = `${config.publicUrl}/session/${encodeURIComponent(run.sessionId)}`;
  return { url: config.url, headers, body };
}

/** Used by the schedules module wiring to tell the owner a run finished. Never throws. */
export function sendNtfyNotification(task: ScheduledTaskSummary, run: ScheduledTaskRun): void {
  const config = readNtfyConfig();
  if (!config) return;
  const request = buildNtfyRequest(config, task, run);
  void fetch(request.url, {
    method: 'POST',
    headers: request.headers,
    body: request.body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
    .then((response) => {
      if (!response.ok) console.warn(`[Schedules] ntfy answered ${response.status} for "${task.name}"`);
    })
    .catch((error: unknown) => {
      console.warn(`[Schedules] ntfy notification failed for "${task.name}":`, error instanceof Error ? error.message : error);
    });
}
