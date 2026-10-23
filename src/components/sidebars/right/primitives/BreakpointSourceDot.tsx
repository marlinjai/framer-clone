'use client';
import React from 'react';
import { cn } from '@/lib/utils';
import type { BreakpointSourceInfo } from '../breakpointSource';

/**
 * The indicator before a property label that says where its value comes from
 * on the breakpoint being edited (src/components/sidebars/right/breakpointSource.ts).
 *
 * - Set on this breakpoint: a filled brand dot. It is a button: clicking it
 *   removes the override, so the value inherits from the larger breakpoint
 *   again (one undo step).
 * - Inherited: a muted ring. Not interactive; the tooltip and the screen
 *   reader text name the breakpoint it comes from.
 *
 * It hangs in the section's 12px left inset, so the 64px label column keeps
 * its full width. The parent must be `position: relative`.
 */
export function BreakpointSourceDot({ source }: { source?: BreakpointSourceInfo }) {
  if (!source) return null;
  const position = 'absolute -left-[11px] top-1/2 flex h-3 w-3 -translate-y-1/2 items-center justify-center rounded-full';

  if (source.kind === 'own') {
    const tooltip = `Set on ${source.breakpointLabel}, click to reset to ${source.resetToLabel}`;
    return (
      <button
        type="button"
        onClick={source.onReset}
        title={tooltip}
        aria-label={tooltip}
        data-testid="breakpoint-source"
        data-source="own"
        className={cn(
          position,
          'group cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
        )}
      >
        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-brand transition-transform group-hover:scale-125" />
      </button>
    );
  }

  return (
    <span
      title={`Inherited from ${source.fromLabel}`}
      data-testid="breakpoint-source"
      data-source="inherited"
      className={position}
    >
      <span aria-hidden className="h-1.5 w-1.5 rounded-full border border-muted-foreground/60" />
      <span className="sr-only">from {source.fromLabel}</span>
    </span>
  );
}
