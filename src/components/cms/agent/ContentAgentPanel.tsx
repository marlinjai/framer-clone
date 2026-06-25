'use client';

// src/components/cms/agent/ContentAgentPanel.tsx
//
// The right "Content agent" column of the CMS workspace. Owns the ephemeral
// chat transcript, the running flag, and the last run id. It POSTs natural-
// language instructions to /api/ai/cms-agent over a fetch-based SSE transport
// (the repo's first; native EventSource is GET-only and cannot carry a body)
// and maps the streamed events onto the transcript. On `agent:done` it fires
// `onRunComplete(runId)` so the workspace re-keys the grid to re-fetch.
//
// The transport is injectable for tests; it defaults to the real fetch streamer.

import React from 'react';
import {
  fetchAgentTransport,
  type AgentStreamRequest,
  type AgentTransport,
} from '@/lib/ai/cmsAgentClient';
import AgentHeader from './AgentHeader';
import AgentChat from './AgentChat';
import AgentSuggestions from './AgentSuggestions';
import AgentInput, { type AgentInputHandle, type AgentSendPayload } from './AgentInput';
import type { ChatMessage } from './types';

export interface ContentAgentPanelProps {
  collectionId: string;
  workspaceId: string;
  collectionName: string;
  /** Fired on agent:done so the workspace can re-fetch the grid. */
  onRunComplete?: (runId: string) => void;
  /** Injectable transport for tests; defaults to the fetch-based SSE streamer. */
  transport?: AgentTransport;
}

export default function ContentAgentPanel({
  collectionId,
  workspaceId,
  collectionName,
  onRunComplete,
  transport = fetchAgentTransport,
}: ContentAgentPanelProps) {
  const [messages, setMessages] = React.useState<ChatMessage[]>([]);
  const [isRunning, setIsRunning] = React.useState(false);
  const inputRef = React.useRef<AgentInputHandle>(null);
  const idRef = React.useRef(0);
  const lastPayloadRef = React.useRef<AgentSendPayload | null>(null);

  const nextId = (): string => `m${(idRef.current += 1)}`;

  const patchAssistant = React.useCallback(
    (assistantId: string, patch: (msg: Extract<ChatMessage, { kind: 'assistant' }>) => ChatMessage) => {
      setMessages((prev) =>
        prev.map((m) => (m.kind === 'assistant' && m.id === assistantId ? patch(m) : m)),
      );
    },
    [],
  );

  const runAgent = React.useCallback(
    async (payload: AgentSendPayload) => {
      lastPayloadRef.current = payload;
      const userMessage: ChatMessage = {
        kind: 'user',
        id: nextId(),
        text: payload.prompt,
        csvName: payload.csvPayload?.name,
      };
      const assistantId = nextId();
      const assistantMessage: ChatMessage = {
        kind: 'assistant',
        id: assistantId,
        thinking: true,
        steps: [],
      };
      setMessages((prev) => [...prev, userMessage, assistantMessage]);
      setIsRunning(true);

      const request: AgentStreamRequest = {
        collectionId,
        workspaceId,
        prompt: payload.prompt,
        model: payload.model,
        csvPayload: payload.csvPayload,
      };

      await transport(request, {
        onToolResult: (p) =>
          patchAssistant(assistantId, (msg) => ({
            ...msg,
            steps: [...msg.steps, { tool: p.tool, success: p.success, summary: p.summary }],
          })),
        onDone: (p) => {
          patchAssistant(assistantId, (msg) => ({
            ...msg,
            thinking: false,
            changes: p.changes,
            runId: p.runId,
          }));
          onRunComplete?.(p.runId);
        },
        onError: (p) => {
          patchAssistant(assistantId, (msg) => ({ ...msg, thinking: false }));
          setMessages((prev) => [...prev, { kind: 'error', id: nextId(), message: p.message }]);
        },
      });

      setIsRunning(false);
    },
    [collectionId, workspaceId, transport, patchAssistant, onRunComplete],
  );

  const handleNewChat = (): void => {
    setMessages([]);
    lastPayloadRef.current = null;
  };

  const handleRetry = (): void => {
    if (lastPayloadRef.current && !isRunning) void runAgent(lastPayloadRef.current);
  };

  const handleUndone = (): void => {
    // The grid re-fetches via the same onRunComplete key-bump signal.
    onRunComplete?.('undo');
  };

  return (
    <aside
      className="flex h-full w-[348px] shrink-0 flex-col border-l border-border bg-muted/30"
      aria-label={`Content agent for ${collectionName}`}
      data-testid="content-agent-panel"
    >
      <AgentHeader onNewChat={handleNewChat} />
      <AgentChat messages={messages} onRetry={handleRetry} onUndone={handleUndone} />
      <AgentSuggestions
        disabled={isRunning}
        onPick={(text) => {
          inputRef.current?.setText(text);
          inputRef.current?.focus();
        }}
      />
      <AgentInput ref={inputRef} isRunning={isRunning} onSend={(payload) => void runAgent(payload)} />
    </aside>
  );
}
