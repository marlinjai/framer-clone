'use client';

// src/components/cms/agent/AgentHeader.tsx
//
// The Content agent column header: a sparkles tile + label, a History button
// (opens a "Coming soon" notice -- run history persistence is a later slice),
// and a New chat button that clears the transcript.

import React from 'react';
import { Sparkles, History, Plus } from 'lucide-react';

export interface AgentHeaderProps {
  onNewChat: () => void;
}

export default function AgentHeader({ onNewChat }: AgentHeaderProps) {
  const [showHistory, setShowHistory] = React.useState(false);

  return (
    <div className="shrink-0 border-b border-border">
      <div className="flex h-12 items-center gap-2 px-3">
        <span className="flex size-[22px] items-center justify-center rounded-[6px] bg-brand/12 text-brand">
          <Sparkles className="size-[13px]" />
        </span>
        <span className="text-[13.5px] font-semibold text-foreground">Content agent</span>

        <div className="flex-1" />

        <button
          type="button"
          onClick={() => setShowHistory((v) => !v)}
          aria-label="Run history"
          data-testid="agent-history"
          className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <History className="size-[15px]" />
        </button>
        <button
          type="button"
          onClick={onNewChat}
          aria-label="New chat"
          data-testid="agent-new-chat"
          className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Plus className="size-[15px]" />
        </button>
      </div>

      {showHistory && (
        <div
          data-testid="agent-history-notice"
          className="border-t border-border bg-muted/40 px-3 py-2 text-[12px] text-muted-foreground"
        >
          Run history is coming soon.
        </div>
      )}
    </div>
  );
}
