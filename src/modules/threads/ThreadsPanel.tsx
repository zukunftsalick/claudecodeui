import { useState } from 'react';
import type { FormEvent } from 'react';
import { FolderPlus, Maximize2, Minimize2, MessageSquarePlus, Network, Trash2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { api, readApiJson } from '@/shared/api';
import type { AgentThreadSummary, ProjectThreadsOverview } from '@/shared/types';
import { cn } from '@/shared/utils';
import { describeThreadStatus, excerptReply, formatThreadTimeAgo, sortThreadsForPane } from '@/modules/threads/utils/threadCards';

type ThreadsPanelProps = {
  projectPath: string;
  overview: ProjectThreadsOverview | null;
  // The session open in the chat, highlighted among the cards.
  activeSessionId: string | null;
  // Docked beside the workspace (true) or covering the screen on phones (false).
  isSidebar: boolean;
  isExpanded: boolean;
  onRefresh: () => void;
  onOpenSession: (sessionId: string) => void;
  onToggleExpand: (() => void) | null;
  onClose: () => void;
};

const TOOLBAR_BUTTON_CLASS = 'flex items-center justify-center rounded-md p-1.5 text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-white';
function ThreadCard({ card, isActive, onOpen }: { card: AgentThreadSummary; isActive: boolean; onOpen: () => void }) {
  const look = describeThreadStatus(card.status);
  const excerpt = excerptReply(card.lastReply);
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'w-full rounded-md border border-border bg-card p-2.5 text-left transition-colors hover:bg-accent',
        isActive && 'ring-1 ring-primary',
      )}
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{card.title}</span>
        <span className={cn('flex-shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium', look.className)}>{look.label}</span>
      </div>
      {card.statusNote && <p className="mt-1 text-xs text-foreground/80">{card.statusNote}</p>}
      {excerpt && <p className="mt-1 line-clamp-3 text-xs text-muted-foreground">{excerpt}</p>}
      <div className="mt-1.5 flex items-center gap-2 text-[10px] text-muted-foreground">
        <span>{formatThreadTimeAgo(card.updatedAt)}</span>
        {card.queuedMessages > 0 && <span>· {card.queuedMessages} queued</span>}
        <span className="min-w-0 flex-1 truncate text-right font-mono" title={card.folder}>{card.folder}</span>
      </div>
    </button>
  );
}

/** Used by the code-editor module's EditorSidebar to show the project chat, its threads and the allowed folders in the side panel. */
export function ThreadsPanel({
  projectPath,
  overview,
  activeSessionId,
  isSidebar,
  isExpanded,
  onRefresh,
  onOpenSession,
  onToggleExpand,
  onClose,
}: ThreadsPanelProps) {
  const { t } = useTranslation('codeEditor');
  // Unsubmitted text in the "allow a folder" box.
  const [folderDraft, setFolderDraft] = useState('');
  // The last action's error, shown above the folders; cleared on the next action.
  const [actionError, setActionError] = useState<string | null>(null);
  // Disables the buttons while a request is going, so a double click does not create two project chats.
  const [isBusy, setIsBusy] = useState(false);

  const runAction = async (action: () => Promise<void>) => {
    setIsBusy(true);
    setActionError(null);
    try {
      await action();
      onRefresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsBusy(false);
    }
  };

  const createProjectChat = () => runAction(async () => {
    const response = await readApiJson<{ data: AgentThreadSummary }>(await api.threads.createProjectChat(projectPath));
    onOpenSession(response.data.sessionId);
  });

  const allowFolder = (event: FormEvent) => {
    event.preventDefault();
    const folder = folderDraft.trim();
    if (!folder) return;
    void runAction(async () => {
      await readApiJson(await api.threads.allowFolder(projectPath, folder));
      setFolderDraft('');
    });
  };

  const removeFolder = (folder: string) => runAction(async () => {
    await readApiJson(await api.threads.removeFolder(projectPath, folder));
  });

  const threads = overview ? sortThreadsForPane(overview.threads) : [];
  const runningCount = threads.filter((thread) => thread.status === 'working').length;

  const header = (
    <div className="flex flex-shrink-0 items-center gap-1.5 border-b border-border px-3 py-2">
      <Network className="h-4 w-4 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{t('threads.title', 'Project chat and threads')}</span>
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

  const body = !overview ? (
    <p className="p-4 text-sm text-muted-foreground">{t('threads.loading', 'Loading threads...')}</p>
  ) : (
    <div className="flex flex-col gap-4 p-3">
      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('threads.projectChat', 'Project chat')}</h3>
          <button
            type="button"
            disabled={isBusy}
            onClick={() => void createProjectChat()}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-primary hover:bg-accent disabled:opacity-50"
          >
            <MessageSquarePlus className="h-3.5 w-3.5" />
            {t('threads.newProjectChat', 'New project chat')}
          </button>
        </div>
        {overview.coordinator ? (
          <ThreadCard
            card={overview.coordinator}
            isActive={overview.coordinator.sessionId === activeSessionId}
            onOpen={() => onOpenSession(overview.coordinator!.sessionId)}
          />
        ) : (
          <p className="text-xs text-muted-foreground">
            {t('threads.noProjectChat', 'No project chat yet. Start one, or ask any chat in this project to start a thread and it becomes the project chat.')}
          </p>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('threads.threads', 'Threads')}
          {threads.length > 0 && (
            <span className="ml-1 font-normal normal-case">
              {t('threads.running', '({{running}} running, up to {{max}} at once)', { running: runningCount, max: overview.maxRunningThreads })}
            </span>
          )}
        </h3>
        {threads.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('threads.none', 'No threads yet. Ask the project chat to split work into threads.')}</p>
        ) : (
          threads.map((thread) => (
            <ThreadCard
              key={thread.sessionId}
              card={thread}
              isActive={thread.sessionId === activeSessionId}
              onOpen={() => onOpenSession(thread.sessionId)}
            />
          ))
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('threads.folders', 'Allowed folders')}</h3>
        <p className="text-xs text-muted-foreground">{t('threads.foldersHelp', 'Folders outside the project that its chats and threads may use.')}</p>
        {actionError && <p className="rounded-md bg-red-50 px-2 py-1 text-xs text-red-700 dark:bg-red-900/20 dark:text-red-300">{actionError}</p>}
        {overview.folders.map((folder) => (
          <div key={folder} className="flex items-center gap-2 rounded-md border border-border px-2 py-1">
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground" title={folder}>{folder}</span>
            <button
              type="button"
              disabled={isBusy}
              onClick={() => void removeFolder(folder)}
              className={TOOLBAR_BUTTON_CLASS}
              title={t('threads.removeFolder', 'Remove')}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
        <form onSubmit={allowFolder} className="flex items-center gap-1.5">
          <input
            value={folderDraft}
            onChange={(event) => setFolderDraft(event.target.value)}
            placeholder="~/projects"
            className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 font-mono text-xs text-foreground"
            aria-label={t('threads.folderInput', 'Folder to allow')}
            spellCheck={false}
          />
          <button
            type="submit"
            disabled={isBusy || !folderDraft.trim()}
            className="flex h-7 items-center gap-1 rounded-md border border-border px-2 text-xs hover:bg-accent disabled:opacity-50"
          >
            <FolderPlus className="h-3.5 w-3.5" />
            {t('threads.allowFolder', 'Allow')}
          </button>
        </form>
      </section>
    </div>
  );

  const content = (
    <div className="flex h-full w-full flex-col bg-background">
      {header}
      <div className="min-h-0 flex-1 overflow-y-auto">{body}</div>
    </div>
  );

  if (isSidebar) {
    return content;
  }

  return <div className="fixed inset-0 z-[9999] bg-background">{content}</div>;
}
