// src/components/ai/PageGenProgressPanel.tsx
//
// What the Generate dialog becomes while a generation runs: a slim floating
// panel, not a modal, so the canvas stays visible and usable while the page
// builds itself on it (src/components/ai/PageGenDraftLayer.tsx). It says what
// the run is doing and how many sections are drawn, and holds the one way to
// stop it (Cancel). The full dialog comes back for the result.
'use client';

import React from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

export interface PageGenProgressPanelProps {
  /** What the run is doing (the dialog's progress line). */
  text: string;
  /** Sections drawn on the canvas so far. */
  sections: number;
  /** Whether the draft is on another page than the one on screen. */
  elsewhere?: string;
  onCancel: () => void;
}

export function PageGenProgressPanel({ text, sections, elsewhere, onCancel }: PageGenProgressPanelProps) {
  return (
    <div
      data-editor-ui="true"
      data-testid="pagegen-progress-panel"
      className="pointer-events-auto fixed bottom-20 left-1/2 z-50 flex w-[min(440px,calc(100vw-32px))] -translate-x-1/2 items-center gap-3 rounded-xl border border-border bg-background/95 px-4 py-3 text-sm shadow-lg backdrop-blur"
    >
      <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" aria-hidden="true" />
      <div role="status" aria-live="polite" className="min-w-0 flex-1">
        <p className="truncate">{text}</p>
        <p className="truncate text-xs text-muted-foreground">
          {sections > 0 ? `${sections} ${sections === 1 ? 'section' : 'sections'} on the canvas` : 'The first section appears on the canvas as soon as it is written'}
          {elsewhere ? `, ${elsewhere}` : ''}
        </p>
      </div>
      <Button type="button" size="sm" variant="outline" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}
