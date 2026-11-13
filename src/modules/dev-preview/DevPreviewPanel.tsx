import { useState } from 'react';
import type { FormEvent } from 'react';
import { ExternalLink, Globe, Maximize2, Minimize2, RefreshCw, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { getStoredAuthToken } from '@/shared/authToken';
import type { DevPreviewStatus } from '@/shared/types';

type DevPreviewPanelProps = {
  port: number;
  status: DevPreviewStatus | null;
  // Docked beside the workspace (true) or covering the screen on phones (false).
  isSidebar: boolean;
  isExpanded: boolean;
  onSelectPort: (port: number) => void;
  onToggleExpand: (() => void) | null;
  onClose: () => void;
};

const TOOLBAR_BUTTON_CLASS = 'flex items-center justify-center rounded-md p-1.5 text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-white';

// The frame first visits the preview host's auth path with the session token,
// which sets a host-only cookie and redirects to the page. The token is the
// same one the app already sends on every API call.
const buildPreviewUrl = (domain: string, port: number, path: string): string => {
  // Same scheme and public port as the app (none behind Cloudflare; set when
  // CloudCLI is reached on a port directly).
  const appPort = window.location.port ? `:${window.location.port}` : '';
  const origin = `${window.location.protocol}//p${port}.${domain}${appPort}`;
  const params = new URLSearchParams({ next: path });
  const token = getStoredAuthToken();
  if (token) params.set('token', token);
  return `${origin}/__cloudcli/preview-auth?${params.toString()}`;
};

const normalizePath = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return '/';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
};

/** Used by the code-editor module's EditorSidebar to show a dev server running on the VPS, live, in the side panel. */
export function DevPreviewPanel({
  port,
  status,
  isSidebar,
  isExpanded,
  onSelectPort,
  onToggleExpand,
  onClose,
}: DevPreviewPanelProps) {
  const { t } = useTranslation('codeEditor');
  // The path loaded in the frame. The frame is cross-origin, so in-page
  // navigation can't be read back; this is what the address box last asked for.
  const [path, setPath] = useState('/');
  // Unsubmitted text in the address box.
  const [pathDraft, setPathDraft] = useState('/');
  // Bumped by Reload to remount the frame, which also renews its session cookie.
  const [reloadCount, setReloadCount] = useState(0);

  const domain = status?.domain ?? null;
  const servers = status?.servers ?? [];
  const isRunning = servers.some((server) => server.port === port);
  const previewUrl = domain ? buildPreviewUrl(domain, port, path) : null;

  const submitPath = (event: FormEvent) => {
    event.preventDefault();
    const nextPath = normalizePath(pathDraft);
    setPathDraft(nextPath);
    setPath(nextPath);
    setReloadCount((count) => count + 1);
  };

  const portOptions = isRunning || !status ? servers : [{ port, label: null }, ...servers];

  const header = (
    <div className="flex flex-shrink-0 items-center gap-1.5 border-b border-border px-2 py-1.5">
      <Globe className="h-4 w-4 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
      <select
        value={port}
        onChange={(event) => {
          onSelectPort(Number(event.target.value));
          setPath('/');
          setPathDraft('/');
        }}
        className="h-7 flex-shrink-0 rounded-md border border-border bg-background px-1.5 text-xs text-foreground"
        aria-label={t('devPreview.port', 'Dev server')}
      >
        {portOptions.map((server) => (
          <option key={server.port} value={server.port}>
            {`:${server.port}${server.label ? ` · ${server.label}` : ''}`}
          </option>
        ))}
      </select>
      <form onSubmit={submitPath} className="min-w-0 flex-1">
        <input
          value={pathDraft}
          onChange={(event) => setPathDraft(event.target.value)}
          className="h-7 w-full min-w-0 rounded-md border border-border bg-background px-2 font-mono text-xs text-foreground"
          aria-label={t('devPreview.path', 'Path')}
          spellCheck={false}
        />
      </form>
      <button type="button" onClick={() => setReloadCount((count) => count + 1)} className={TOOLBAR_BUTTON_CLASS} title={t('devPreview.reload', 'Reload')}>
        <RefreshCw className="h-4 w-4" />
      </button>
      {previewUrl && (
        <a href={previewUrl} target="_blank" rel="noopener noreferrer" className={TOOLBAR_BUTTON_CLASS} title={t('devPreview.openInNewTab', 'Open in new tab')}>
          <ExternalLink className="h-4 w-4" />
        </a>
      )}
      {onToggleExpand && (
        <button type="button" onClick={onToggleExpand} className={TOOLBAR_BUTTON_CLASS} title={isExpanded ? t('toolbar.collapse') : t('toolbar.expand')}>
          {isExpanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
        </button>
      )}
      <button type="button" onClick={onClose} className={TOOLBAR_BUTTON_CLASS} title={t('actions.close', 'Close')}>
        <X className="h-4 w-4" />
      </button>
    </div>
  );

  let body;
  if (!status) {
    body = <p className="text-sm text-muted-foreground">{t('devPreview.loading', 'Looking for dev servers...')}</p>;
  } else if (!previewUrl) {
    body = (
      <p className="max-w-sm text-center text-sm text-muted-foreground">
        {t('devPreview.notConfigured', 'Dev server previews are not set up on this server yet. Set DEV_PREVIEW_DOMAIN and route *.<domain> to CloudCLI.')}
      </p>
    );
  } else {
    body = (
      <>
        {!isRunning && (
          <div className="w-full border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-800 dark:border-amber-900/40 dark:bg-amber-900/20 dark:text-amber-300">
            {t('devPreview.stopped', 'Nothing is listening on port {{port}} right now.', { port })}
          </div>
        )}
        <iframe
          key={`${port}:${reloadCount}`}
          src={previewUrl}
          title={t('devPreview.frameTitle', 'Preview of port {{port}}', { port })}
          className="w-full flex-1 border-0 bg-white"
          allow="clipboard-read; clipboard-write; fullscreen"
        />
      </>
    );
  }

  const content = (
    <div className="flex h-full w-full flex-col bg-background">
      {header}
      <div className={`flex min-h-0 flex-1 flex-col ${previewUrl ? '' : 'items-center justify-center p-6'}`}>
        {body}
      </div>
    </div>
  );

  if (isSidebar) {
    return content;
  }

  return <div className="fixed inset-0 z-[9999] bg-background">{content}</div>;
}
