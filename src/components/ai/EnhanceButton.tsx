// src/components/ai/EnhanceButton.tsx
//
// Enhance in the Generate dialog (plan
// docs/plans/2026-11-04-page-generator-ideas-and-streaming.md, pull request
// 1): the button beside the character counter, which turns into Stop while
// the rewrite streams in, and the notice under the brief that offers the one
// undo step ("Undo enhance", or "Undo" after an idea replaced typed text) and
// shows why an Enhance failed. The state lives in ./useBriefAssist.ts.

'use client';

import React from 'react';
import { Square, Undo2, Wand2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { BriefAssist } from './useBriefAssist';

export function EnhanceButton({ assist, disabled }: { assist: BriefAssist; disabled: boolean }) {
  if (assist.enhancing) {
    return (
      <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={assist.stop}>
        <Square className="size-3.5" aria-hidden="true" />
        Stop
      </Button>
    );
  }
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-7 px-2 text-xs"
      onClick={() => void assist.enhance()}
      disabled={disabled}
      title="Rewrite the brief with more structure (sections, audience, tone, call to action). You can undo it."
    >
      <Wand2 className="size-3.5" aria-hidden="true" />
      Enhance
    </Button>
  );
}

/** Under the brief: what is happening, the undo on offer, or why it failed. */
export function BriefNotice({ assist }: { assist: BriefAssist }) {
  const { enhancing, undo, message } = assist;
  return (
    <>
      <p role="status" aria-live="polite" className={enhancing || undo ? 'text-xs text-muted-foreground' : 'sr-only'}>
        {enhancing ? (
          'Rewriting the brief...'
        ) : undo ? (
          <>
            {undo.kind === 'enhance' ? 'Brief rewritten.' : `Your brief was replaced with the idea "${undo.title}".`}{' '}
            <button
              type="button"
              onClick={assist.undoLast}
              className="inline-flex items-center gap-1 font-medium text-foreground underline underline-offset-2 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Undo2 className="size-3" aria-hidden="true" />
              {undo.kind === 'enhance' ? 'Undo enhance' : 'Undo'}
            </button>
          </>
        ) : null}
      </p>
      {message &&
        (message.tone === 'error' ? (
          <p role="alert" className="text-xs text-destructive">
            {message.text}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">{message.text}</p>
        ))}
    </>
  );
}
