'use client';

// src/components/cms/agent/AgentChat.tsx
//
// The scrollable transcript. Renders each ChatMessage:
//   - user        -> the prompt text + an optional attached-CSV chip
//   - assistant   -> a thinking indicator while streaming, the executed-tool
//                    step list, and a ChangesCard once the run completes
//   - error       -> the surfaced agent:error message + a "Try again" action

import React from 'react';
import { Paperclip, Loader2, Check, X, TriangleAlert } from 'lucide-react';
import type { ChatMessage } from './types';
import type { UndoResult } from '@/lib/ai/cmsAgentProtocol';
import ChangesCard from './ChangesCard';

export interface AgentChatProps {
  messages: ChatMessage[];
  onRetry?: () => void;
  onUndone?: (result: UndoResult) => void;
}

export default function AgentChat({ messages, onRetry, onUndone }: AgentChatProps) {
  const scrollRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  return (
    <div
      ref={scrollRef}
      className="flex-1 overflow-y-auto px-3 py-3"
      data-testid="agent-chat"
    >
      {messages.length === 0 ? (
        <p className="px-1 py-6 text-center text-[12.5px] text-muted-foreground">
          Ask the agent to generate, import, translate, or organize your content.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {messages.map((message) => (
            <li key={message.id}>{renderMessage(message, onRetry, onUndone)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function renderMessage(
  message: ChatMessage,
  onRetry?: () => void,
  onUndone?: (result: UndoResult) => void,
): React.ReactNode {
  if (message.kind === 'user') {
    return (
      <div className="ml-auto max-w-[88%] rounded-lg bg-brand/10 px-2.5 py-2" data-testid="agent-user-message">
        <p className="whitespace-pre-wrap text-[13px] text-foreground">{message.text}</p>
        {message.csvName && (
          <span className="mt-1 inline-flex items-center gap-1 text-[11.5px] text-muted-foreground">
            <Paperclip className="size-[11px]" />
            {message.csvName}
          </span>
        )}
      </div>
    );
  }

  if (message.kind === 'error') {
    return (
      <div
        className="flex flex-col gap-1.5 rounded-lg border border-destructive/30 bg-destructive/10 px-2.5 py-2"
        data-testid="agent-error-message"
      >
        <span className="flex items-center gap-1.5 text-[12.5px] font-medium text-destructive">
          <TriangleAlert className="size-[13px]" />
          {message.message}
        </span>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            data-testid="agent-try-again"
            className="self-start text-[12px] font-medium text-brand hover:text-brand/80"
          >
            Try again
          </button>
        )}
      </div>
    );
  }

  // assistant
  return (
    <div className="max-w-[92%]" data-testid="agent-assistant-message">
      {message.thinking && message.steps.length === 0 && (
        <span
          className="inline-flex items-center gap-1.5 text-[12.5px] text-muted-foreground"
          data-testid="agent-thinking-indicator"
        >
          <Loader2 className="size-[13px] animate-spin" />
          Thinking...
        </span>
      )}

      {message.steps.length > 0 && (
        <ul className="flex flex-col gap-1">
          {message.steps.map((step, index) => (
            <li
              key={`${step.tool}-${index}`}
              className="flex items-start gap-1.5 text-[12.5px] text-foreground"
              data-testid="agent-step"
            >
              {step.success ? (
                <Check className="mt-0.5 size-[13px] shrink-0 text-brand" />
              ) : (
                <X className="mt-0.5 size-[13px] shrink-0 text-destructive" />
              )}
              <span className={step.success ? '' : 'text-destructive'}>{step.summary}</span>
            </li>
          ))}
          {message.thinking && (
            <li
              className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground"
              data-testid="agent-thinking-indicator"
            >
              <Loader2 className="size-[13px] animate-spin" />
              Working...
            </li>
          )}
        </ul>
      )}

      {message.changes && message.runId && (
        <ChangesCard runId={message.runId} changes={message.changes} onUndone={onUndone} />
      )}
    </div>
  );
}
