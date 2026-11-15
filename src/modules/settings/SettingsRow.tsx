import type { ReactNode } from 'react';

import { cn } from '@/shared/utils';

type SettingsRowProps = {
  label: string;
  description?: string;
  children: ReactNode;
  className?: string;
  /** Puts the control under the label at full width on phones, for controls too wide to sit beside it. */
  stackOnMobile?: boolean;
};

/** Used by the settings module's appearance, browser-use and tasks tabs to lay out one labelled setting and its control. */
export default function SettingsRow({ label, description, children, className, stackOnMobile = false }: SettingsRowProps) {
  return (
    <div
      className={cn(
        'flex justify-between gap-4 px-4 py-4',
        stackOnMobile ? 'flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:gap-4' : 'items-center',
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-foreground">{label}</div>
        {description && (
          <div className="mt-0.5 text-sm text-muted-foreground">{description}</div>
        )}
      </div>
      <div className={stackOnMobile ? 'w-full sm:w-auto sm:flex-shrink-0' : 'flex-shrink-0'}>{children}</div>
    </div>
  );
}
