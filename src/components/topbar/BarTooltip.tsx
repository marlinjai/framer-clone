// src/components/topbar/BarTooltip.tsx
//
// The top bar's tooltip for a control (docs/plans/2026-11-12-top-bar-fold.md): opened by hover and by keyboard
// focus, so a control folded into its icon still says what it does to a person who cannot hover. The control
// keeps its own accessible name; the tooltip adds the description.
'use client';

import React from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export function BarTooltip({ text, children }: { text: React.ReactNode; children: React.ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom">{text}</TooltipContent>
    </Tooltip>
  );
}

/** The words of a control that folds into its icon: hidden from sight, kept for a screen reader. */
export function FoldLabel({ folded, children }: { folded: boolean; children: React.ReactNode }) {
  return <span data-fold-label="" className={folded ? 'sr-only' : undefined}>{children}</span>;
}

/** The classes that make a small labelled button square once its words fold. */
export const ICON_ONLY = 'w-8 px-0 has-[>svg]:px-0';
