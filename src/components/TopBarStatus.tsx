// src/components/TopBarStatus.tsx
//
// The result line of a top-bar action (Save, Publish). On a wide top bar it
// sits inline beside its button, as it always has. Under 1024px the compact
// top bar has no room for it, so it becomes a notice under the bar, full width
// minus 16px margins, with a dismiss button; a success there clears itself
// after a few seconds, an error stays until dismissed (plan
// docs/plans/2026-10-24-editor-on-phones.md).
'use client';

import React from 'react';
import { X } from 'lucide-react';

/** The compact top bar's media query (Tailwind's `max-lg`). */
export const COMPACT_TOP_BAR_QUERY = '(max-width: 1023.98px)';
export const COMPACT_SUCCESS_MS = 5000;

function isCompactTopBar(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(COMPACT_TOP_BAR_QUERY).matches;
}

export interface TopBarStatusProps {
  kind: 'success' | 'error';
  /** Full text for the tooltip. */
  title: string;
  onDismiss: () => void;
  /** Inline width cap on the wide bar. */
  inlineMaxWidth?: string;
  /** Extra classes for the text colour. */
  toneClassName?: string;
  children: React.ReactNode;
}

export function TopBarStatus({ kind, title, onDismiss, inlineMaxWidth = 'lg:max-w-[200px]', toneClassName, children }: TopBarStatusProps) {
  // The callback is usually an inline arrow; keep the timer keyed to the message only.
  const dismissRef = React.useRef(onDismiss);
  React.useEffect(() => {
    dismissRef.current = onDismiss;
  });
  React.useEffect(() => {
    if (kind !== 'success' || !isCompactTopBar()) return;
    const t = window.setTimeout(() => dismissRef.current(), COMPACT_SUCCESS_MS);
    return () => window.clearTimeout(t);
  }, [kind, title]);

  const tone = toneClassName ?? (kind === 'error' ? 'text-destructive' : 'text-muted-foreground');
  return (
    <span
      role={kind === 'error' ? 'alert' : 'status'}
      aria-live={kind === 'error' ? undefined : 'polite'}
      title={title}
      data-editor-ui="true"
      className={`flex items-center gap-1 text-xs ${tone} lg:truncate ${inlineMaxWidth} max-lg:fixed max-lg:inset-x-4 max-lg:top-[4.5rem] max-lg:z-[95] max-lg:justify-between max-lg:gap-2 max-lg:rounded-md max-lg:border max-lg:border-border max-lg:bg-background max-lg:py-1.5 max-lg:pl-3 max-lg:pr-1 max-lg:shadow-lg phone:top-14`}
    >
      <span className="flex min-w-0 items-center gap-1 lg:truncate">{children}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground lg:hidden"
      >
        <X size={14} />
      </button>
    </span>
  );
}
