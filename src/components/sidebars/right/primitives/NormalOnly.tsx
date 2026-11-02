'use client';
// What does not follow a state: text, a link's target, a form, an attribute. These
// are props, and a state only holds styles, so while one is edited they are dimmed
// and out of reach, with the way back beside them. Always the same elements, so
// switching state neither remounts what is inside nor loses a draft or an open
// disclosure.
import React from 'react';
import { observer } from 'mobx-react-lite';
import { useStore } from '@/hooks/useStore';
import { cn } from '@/lib/utils';

export const NormalOnly = observer(({ children }: { children: React.ReactNode }) => {
  const { editorUI } = useStore();
  const label = editorUI.activeRule ? editorUI.activeRuleLabel : undefined;
  return (
    <div className={label ? 'flex min-w-0 flex-col gap-2' : 'contents'}>
      {label ? (
        <p className="text-[11px] leading-snug text-muted-foreground" data-testid="normal-only">
          Editing {label}.{' '}
          <button
            type="button"
            onClick={() => editorUI.setActiveRule(null)}
            className="relative font-medium text-foreground underline underline-offset-2 after:absolute after:-inset-x-1 after:-inset-y-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          >
            Back to Normal
          </button>
        </p>
      ) : null}
      <div inert={!!label} className={cn(label ? 'flex min-w-0 flex-col gap-2 opacity-40' : 'contents')}>
        {children}
      </div>
    </div>
  );
});

NormalOnly.displayName = 'NormalOnly';
