import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Download,
  ExternalLink,
  Loader2,
  Play,
  RefreshCw,
  RotateCcw,
  XCircle,
} from 'lucide-react';

import { api, readApiJson } from '@/shared/api';
import type { XcodeCloudBuildRun, XcodeCloudBuildRunDetail, XcodeCloudIssueCounts } from '@/shared/types';
import { cn } from '@/shared/utils';
import { useXcodeCloud } from '@/modules/xcode-cloud/hooks/useXcodeCloud';

type XcodeCloudPanelProps = {
  // Opens a source file from an issue (path resolved against the project).
  onFileOpen?: (filePath: string, diffInfo?: unknown, line?: number | null) => void;
};

// Xcode Cloud reports paths inside its own checkout; the part after this is repo-relative.
const CI_CHECKOUT_PREFIX = /^\/Volumes\/workspace\/repository\//;

/** Shows how long ago an ISO date was, e.g. "5m ago". Exported for tests. */
export function formatTimeAgo(iso: string | null, now: number = Date.now()): string {
  if (!iso) return '';
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Shows a build's running time, e.g. "4m 12s", counting to now while it runs. Exported for tests. */
export function formatDuration(startIso: string | null, endIso: string | null, now: number = Date.now()): string {
  if (!startIso) return '';
  const end = endIso ? new Date(endIso).getTime() : now;
  const seconds = Math.max(0, Math.round((end - new Date(startIso).getTime()) / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

type StatusLook = { label: string; className: string; icon: typeof Circle; spin?: boolean };

/** Maps Xcode Cloud's progress and result to a label, color and icon. Exported for tests. */
export function describeStatus(executionProgress: string, completionStatus: string | null): StatusLook {
  if (executionProgress === 'RUNNING') return { label: 'Running', className: 'text-blue-600 dark:text-blue-400', icon: Loader2, spin: true };
  if (executionProgress === 'PENDING') return { label: 'Queued', className: 'text-amber-600 dark:text-amber-400', icon: Circle };
  switch (completionStatus) {
    case 'SUCCEEDED': return { label: 'Succeeded', className: 'text-green-600 dark:text-green-400', icon: CheckCircle2 };
    case 'FAILED': return { label: 'Failed', className: 'text-red-600 dark:text-red-400', icon: XCircle };
    case 'ERRORED': return { label: 'Error', className: 'text-red-600 dark:text-red-400', icon: AlertTriangle };
    case 'CANCELED': return { label: 'Canceled', className: 'text-muted-foreground', icon: Circle };
    case 'SKIPPED': return { label: 'Skipped', className: 'text-muted-foreground', icon: Circle };
    default: return { label: completionStatus ?? 'Unknown', className: 'text-muted-foreground', icon: Circle };
  }
}

function StatusIcon({ executionProgress, completionStatus, className }: { executionProgress: string; completionStatus: string | null; className?: string }) {
  const look = describeStatus(executionProgress, completionStatus);
  const Icon = look.icon;
  return <Icon className={cn('h-4 w-4 flex-shrink-0', look.className, look.spin && 'animate-spin', className)} aria-label={look.label} />;
}

function IssueSummary({ counts }: { counts: XcodeCloudIssueCounts }) {
  const parts = [
    counts.errors ? { text: `${counts.errors} error${counts.errors === 1 ? '' : 's'}`, className: 'text-red-600 dark:text-red-400' } : null,
    counts.testFailures ? { text: `${counts.testFailures} test failure${counts.testFailures === 1 ? '' : 's'}`, className: 'text-red-600 dark:text-red-400' } : null,
    counts.warnings + counts.analyzerWarnings ? { text: `${counts.warnings + counts.analyzerWarnings} warning${counts.warnings + counts.analyzerWarnings === 1 ? '' : 's'}`, className: 'text-amber-600 dark:text-amber-400' } : null,
  ].filter(Boolean) as Array<{ text: string; className: string }>;
  if (!parts.length) return null;
  return (
    <span className="flex flex-wrap gap-x-2 text-xs">
      {parts.map((part) => <span key={part.text} className={part.className}>{part.text}</span>)}
    </span>
  );
}

const formatBytes = (bytes: number): string => {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
};

type BuildRunDetailProps = {
  run: XcodeCloudBuildRun;
  testFlightUrl: string | null;
  onFileOpen?: XcodeCloudPanelProps['onFileOpen'];
};

// Loads and shows one build's actions, issues, artifacts and TestFlight builds.
function BuildRunDetail({ run, testFlightUrl, onFileOpen }: BuildRunDetailProps) {
  // The build's details; reloaded when its status changes.
  const [detail, setDetail] = useState<XcodeCloudBuildRunDetail | null>(null);
  // Why the details couldn't be loaded, if they couldn't.
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await readApiJson<XcodeCloudBuildRunDetail>(await api.xcodeCloud.buildRun(run.id));
        if (!cancelled) {
          setDetail(result);
          setError(null);
        }
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : String(loadError));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [run.id, run.executionProgress, run.completionStatus]);

  if (error) return <p className="px-4 pb-3 text-xs text-red-600 dark:text-red-400">{error}</p>;
  if (!detail) return <p className="px-4 pb-3 text-xs text-muted-foreground">Loading build details...</p>;

  return (
    <div className="space-y-3 px-4 pb-4 pt-1">
      {detail.actions.map((action) => (
        <div key={action.id} className="rounded-md border border-border bg-background">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <StatusIcon executionProgress={action.executionProgress} completionStatus={action.completionStatus} />
            <span className="text-sm font-medium text-foreground">{action.name}</span>
            <span className="text-xs text-muted-foreground">{formatDuration(action.startedDate, action.finishedDate)}</span>
            <span className="ml-auto"><IssueSummary counts={action.issueCounts} /></span>
          </div>

          {action.issues.length > 0 && (
            <ul className="max-h-64 divide-y divide-border overflow-y-auto">
              {action.issues.map((issue) => {
                const relativePath = issue.filePath?.replace(CI_CHECKOUT_PREFIX, '') ?? null;
                const isError = issue.issueType === 'ERROR' || issue.issueType === 'TEST_FAILURE';
                return (
                  <li key={issue.id} className="flex gap-2 px-3 py-1.5 text-xs">
                    {isError
                      ? <XCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-red-500" />
                      : <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-amber-500" />}
                    <div className="min-w-0">
                      <p className="whitespace-pre-wrap break-words text-foreground">{issue.message}</p>
                      {relativePath && (
                        <button
                          type="button"
                          className="mt-0.5 font-mono text-[11px] text-blue-600 hover:underline dark:text-blue-400"
                          onClick={() => onFileOpen?.(relativePath, undefined, issue.lineNumber)}
                        >
                          {relativePath}{issue.lineNumber ? `:${issue.lineNumber}` : ''}
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {action.artifacts.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-3 py-2">
              {action.artifacts.map((artifact) => (
                artifact.downloadUrl ? (
                  <a
                    key={artifact.id}
                    href={artifact.downloadUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-foreground hover:bg-accent"
                    title={artifact.fileType}
                  >
                    <Download className="h-3 w-3" />
                    {artifact.fileName}
                    <span className="text-muted-foreground">{formatBytes(artifact.fileSize)}</span>
                  </a>
                ) : null
              ))}
            </div>
          )}
        </div>
      ))}

      {detail.builds.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-xs">
          <span className="font-medium text-foreground">TestFlight</span>
          {detail.builds.map((build) => (
            <span key={build.id} className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
              {`Build ${build.version}${build.processingState ? ` · ${build.processingState.toLowerCase()}` : ''}${build.expired ? ' · expired' : ''}`}
            </span>
          ))}
          {testFlightUrl && (
            <a href={testFlightUrl} target="_blank" rel="noopener noreferrer" className="ml-auto flex items-center gap-1 text-blue-600 hover:underline dark:text-blue-400">
              Open in TestFlight <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      )}

      {detail.actions.length === 0 && detail.builds.length === 0 && (
        <p className="text-xs text-muted-foreground">No details yet. Xcode Cloud adds them as the build runs.</p>
      )}
    </div>
  );
}

/** Used by the project-workspace module as the Builds tab: Xcode Cloud builds for the server's App Store Connect key, with live status, issues, artifacts, TestFlight builds and starting new builds. */
export function XcodeCloudPanel({ onFileOpen }: XcodeCloudPanelProps) {
  const {
    configured,
    products,
    product,
    setProductId,
    workflows,
    buildRuns,
    loading,
    error,
    lastUpdated,
    startBuild,
    refresh,
  } = useXcodeCloud(true);
  // The build whose details are open.
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  // The workflow or build a start request is in flight for, so its button shows progress.
  const [startingKey, setStartingKey] = useState<string | null>(null);
  // The last start request's failure, shown above the list.
  const [startError, setStartError] = useState<string | null>(null);
  // Re-renders once a second so running times and "ago" labels move.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const runStart = async (key: string, body: Parameters<typeof startBuild>[0]) => {
    setStartingKey(key);
    setStartError(null);
    try {
      await startBuild(body);
    } catch (startFailure) {
      setStartError(startFailure instanceof Error ? startFailure.message : String(startFailure));
    } finally {
      setStartingKey(null);
    }
  };

  if (configured === null) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {error ?? 'Loading Xcode Cloud...'}
      </div>
    );
  }

  if (!configured) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-md space-y-3 text-sm text-muted-foreground">
          <h2 className="text-base font-semibold text-foreground">Connect Xcode Cloud</h2>
          <p>This tab shows your Xcode Cloud builds once an App Store Connect API key is set up on the server. On the server, run:</p>
          <pre className="rounded-md bg-muted px-3 py-2 font-mono text-xs text-foreground">sudo bash vps-setup.sh --only asc_key</pre>
          <p>It asks for the Key ID and Issuer ID, then gives you an <code>scp</code> command that copies the .p8 key from your Mac. Reload this page afterwards.</p>
        </div>
      </div>
    );
  }

  const appUrl = product?.appId ? `https://appstoreconnect.apple.com/apps/${product.appId}` : null;
  const testFlightUrl = appUrl ? `${appUrl}/testflight` : null;
  // Starting a workflow reuses the branch its most recent build used.
  const latestRunByWorkflow = new Map<string, XcodeCloudBuildRun>();
  for (const run of buildRuns) {
    if (run.workflowId && !latestRunByWorkflow.has(run.workflowId)) latestRunByWorkflow.set(run.workflowId, run);
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex flex-shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <select
          value={product?.id ?? ''}
          onChange={(event) => {
            setProductId(event.target.value);
            setExpandedRunId(null);
          }}
          className="h-8 min-w-40 rounded-md border border-border bg-background pl-2 pr-8 text-sm text-foreground"
          aria-label="Xcode Cloud product"
        >
          {products.length === 0 && <option value="">No Xcode Cloud products</option>}
          {products.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        {product?.bundleId && <span className="font-mono text-xs text-muted-foreground">{product.bundleId}</span>}
        <span className="ml-auto text-xs text-muted-foreground">{lastUpdated ? `Updated ${formatTimeAgo(new Date(lastUpdated).toISOString(), now)}` : ''}</span>
        <button type="button" onClick={() => void refresh()} className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground" title="Refresh">
          <RefreshCw className="h-4 w-4" />
        </button>
        {appUrl && (
          <a href={appUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
            App Store Connect <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <aside className="flex-shrink-0 border-b border-border p-3 md:w-64 md:border-b-0 md:border-r">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Workflows</h3>
          {workflows.length === 0 && !loading && <p className="text-xs text-muted-foreground">No workflows.</p>}
          <ul className="space-y-1">
            {workflows.map((workflow) => {
              const latest = latestRunByWorkflow.get(workflow.id);
              const key = `workflow:${workflow.id}`;
              return (
                <li key={workflow.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent/50">
                  <div className="min-w-0 flex-1">
                    <p className={cn('truncate text-sm', workflow.isEnabled ? 'text-foreground' : 'text-muted-foreground line-through')}>{workflow.name}</p>
                    {latest?.branch && <p className="truncate text-[11px] text-muted-foreground">{latest.branch}</p>}
                  </div>
                  <button
                    type="button"
                    disabled={!workflow.isEnabled || startingKey !== null}
                    onClick={() => void runStart(key, { workflowId: workflow.id, sourceRefId: latest?.sourceRefId ?? undefined })}
                    className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-foreground hover:bg-accent disabled:opacity-50"
                    title={latest?.branch ? `Start a build on ${latest.branch}` : 'Start a build'}
                  >
                    {startingKey === key ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
                    Build
                  </button>
                </li>
              );
            })}
          </ul>
        </aside>

        <section className="min-h-0 flex-1 overflow-y-auto">
          {(error || startError) && (
            <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-300">
              {startError ?? error}
            </div>
          )}
          {loading && buildRuns.length === 0 && <p className="p-4 text-sm text-muted-foreground">Loading builds...</p>}
          {!loading && buildRuns.length === 0 && !error && <p className="p-4 text-sm text-muted-foreground">No builds yet.</p>}
          <ul className="divide-y divide-border">
            {buildRuns.map((run) => {
              const isExpanded = expandedRunId === run.id;
              const look = describeStatus(run.executionProgress, run.completionStatus);
              const rerunKey = `run:${run.id}`;
              return (
                <li key={run.id}>
                  <div className="flex items-start gap-3 px-4 py-2.5 hover:bg-accent/40">
                    <button
                      type="button"
                      onClick={() => setExpandedRunId(isExpanded ? null : run.id)}
                      className="flex min-w-0 flex-1 items-start gap-3 text-left"
                      aria-expanded={isExpanded}
                    >
                      {isExpanded ? <ChevronDown className="mt-0.5 h-4 w-4 flex-shrink-0 text-muted-foreground" /> : <ChevronRight className="mt-0.5 h-4 w-4 flex-shrink-0 text-muted-foreground" />}
                      <StatusIcon executionProgress={run.executionProgress} completionStatus={run.completionStatus} className="mt-0.5" />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline gap-x-2">
                          <span className="text-sm font-medium text-foreground">#{run.number}</span>
                          <span className="text-sm text-foreground">{run.workflowName ?? 'Build'}</span>
                          <span className={cn('text-xs', look.className)}>{look.label}</span>
                          {run.branch && <span className="rounded bg-muted px-1.5 font-mono text-[11px] text-muted-foreground">{run.branch}</span>}
                        </div>
                        <p className="truncate text-xs text-muted-foreground">
                          {[run.commitMessage, run.commitSha?.slice(0, 7), run.commitAuthor].filter(Boolean).join(' · ')}
                        </p>
                        <IssueSummary counts={run.issueCounts} />
                      </div>
                      <div className="flex-shrink-0 text-right text-xs text-muted-foreground">
                        <p>{formatTimeAgo(run.createdDate, now)}</p>
                        <p>{formatDuration(run.startedDate, run.finishedDate, now)}</p>
                      </div>
                    </button>
                    {run.executionProgress === 'COMPLETE' && (
                      <button
                        type="button"
                        disabled={startingKey !== null}
                        onClick={() => void runStart(rerunKey, { rebuildOfBuildRunId: run.id })}
                        className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
                        title="Run this build again"
                      >
                        {startingKey === rerunKey ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
                      </button>
                    )}
                  </div>
                  {isExpanded && <BuildRunDetail run={run} testFlightUrl={testFlightUrl} onFileOpen={onFileOpen} />}
                </li>
              );
            })}
          </ul>
        </section>
      </div>
    </div>
  );
}
