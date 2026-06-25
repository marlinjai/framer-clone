'use client';

// src/components/cms/agent/AgentSuggestions.tsx
//
// Four pre-wired prompt chips shown below the chat. Clicking a chip POPULATES
// the input bar and focuses it; it does NOT auto-submit (the user reviews and
// edits before sending).

import React from 'react';

export const AGENT_SUGGESTIONS = [
  'Generate 5 blog posts',
  'Translate to German',
  'Bulk publish drafts',
  'Fill missing covers',
] as const;

export interface AgentSuggestionsProps {
  onPick: (text: string) => void;
  disabled?: boolean;
}

export default function AgentSuggestions({ onPick, disabled }: AgentSuggestionsProps) {
  return (
    <div className="flex flex-wrap gap-1.5 px-3 py-2" data-testid="agent-suggestions">
      {AGENT_SUGGESTIONS.map((text) => (
        <button
          key={text}
          type="button"
          disabled={disabled}
          onClick={() => onPick(text)}
          className="rounded-full border border-border bg-background px-2.5 py-1 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
        >
          {text}
        </button>
      ))}
    </div>
  );
}
