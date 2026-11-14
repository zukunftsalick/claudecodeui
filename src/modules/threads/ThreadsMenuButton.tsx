import { Network } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/shared/utils';

type ThreadsMenuButtonProps = {
  isOpen: boolean;
  waitingCount: number;
  onToggle: () => void;
};

/** Used by the project-workspace module's header to open the threads pane; the badge counts threads waiting for the user. */
export function ThreadsMenuButton({ isOpen, waitingCount, onToggle }: ThreadsMenuButtonProps) {
  const { t } = useTranslation('codeEditor');

  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        'flex h-8 flex-shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors',
        isOpen
          ? 'bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400'
          : 'text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
      title={t('threads.menuTitle', 'Project chat and threads')}
      aria-pressed={isOpen}
    >
      <Network className="h-4 w-4" />
      <span className="hidden sm:inline">{t('threads.menuLabel', 'Threads')}</span>
      {waitingCount > 0 && (
        <span
          className="rounded-full bg-amber-500 px-1.5 text-[10px] leading-4 text-white"
          title={t('threads.waitingBadge', '{{count}} waiting for you', { count: waitingCount })}
        >
          {waitingCount}
        </span>
      )}
    </button>
  );
}
