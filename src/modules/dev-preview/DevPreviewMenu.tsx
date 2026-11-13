import { useEffect, useRef, useState } from 'react';
import { Globe } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { DevPreviewStatus } from '@/shared/types';
import { cn } from '@/shared/utils';

type DevPreviewMenuProps = {
  status: DevPreviewStatus | null;
  activePort: number | null;
  onOpenPreview: (port: number) => void;
};

/** Used by the project-workspace module's header to list running dev servers and open one in the side panel. Renders nothing until previews are set up on the server. */
export function DevPreviewMenu({ status, activePort, onOpenPreview }: DevPreviewMenuProps) {
  const { t } = useTranslation('codeEditor');
  // Whether the server list is showing.
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close when clicking anywhere else.
  useEffect(() => {
    if (!isOpen) return undefined;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setIsOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    return () => document.removeEventListener('mousedown', closeOnOutsideClick);
  }, [isOpen]);

  if (!status?.enabled) {
    return null;
  }

  const servers = status.servers;

  return (
    <div ref={containerRef} className="relative flex-shrink-0">
      <button
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        className={cn(
          'flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors',
          activePort !== null
            ? 'bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400'
            : 'text-muted-foreground hover:bg-accent hover:text-foreground',
        )}
        title={t('devPreview.menuTitle', 'Preview a dev server')}
        aria-expanded={isOpen}
      >
        <Globe className="h-4 w-4" />
        <span className="hidden sm:inline">{t('devPreview.menuLabel', 'Preview')}</span>
        {servers.length > 0 && (
          <span className="rounded-full bg-primary/15 px-1.5 text-[10px] leading-4 text-primary">{servers.length}</span>
        )}
      </button>

      {isOpen && (
        <div className="absolute right-0 top-full z-50 mt-1 w-72 rounded-md border border-border bg-popover p-1 shadow-lg">
          {servers.length === 0 ? (
            <p className="px-2 py-2 text-xs text-muted-foreground">
              {t('devPreview.none', 'No dev servers are running. Ask Claude to start one, and it will open here.')}
            </p>
          ) : (
            servers.map((server) => (
              <button
                key={server.port}
                type="button"
                onClick={() => {
                  onOpenPreview(server.port);
                  setIsOpen(false);
                }}
                className={cn(
                  'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent',
                  server.port === activePort && 'bg-accent',
                )}
              >
                <span className="font-mono font-medium text-foreground">:{server.port}</span>
                <span className="truncate text-muted-foreground">{server.label ?? ''}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
