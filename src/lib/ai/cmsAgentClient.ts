// src/lib/ai/cmsAgentClient.ts
//
// The repo's first fetch-based SSE client. The CMS content agent route streams
// over POST (a request body is required, so the GET-only `EventSource` cannot be
// used). This module POSTs to /api/ai/cms-agent, reads `response.body` with a
// `ReadableStream` reader, decodes chunks, and feeds them through
// `parseSseFrames` to dispatch typed handlers.
//
// The transport is injectable into ContentAgentPanel so tests can drive the UI
// without a live network stream.

import { parseSseFrames } from './parseSse';
import type {
  AgentDonePayload,
  AgentErrorPayload,
  AgentThinkingPayload,
  AgentToolCallPayload,
  AgentToolResultPayload,
  AgentUsagePayload,
} from './cmsAgentProtocol';

export interface AgentStreamRequest {
  collectionId: string;
  workspaceId: string;
  prompt: string;
  model: 'HAIKU' | 'SONNET' | 'OPUS';
  csvPayload?: { name: string; content: string };
}

export interface AgentStreamHandlers {
  onThinking?: (payload: AgentThinkingPayload) => void;
  onToolCall?: (payload: AgentToolCallPayload) => void;
  onToolResult?: (payload: AgentToolResultPayload) => void;
  onDone?: (payload: AgentDonePayload) => void;
  onError?: (payload: AgentErrorPayload) => void;
  onUsage?: (payload: AgentUsagePayload) => void;
}

export type AgentTransport = (
  req: AgentStreamRequest,
  handlers: AgentStreamHandlers,
) => Promise<void>;

function dispatch(event: string, data: string, handlers: AgentStreamHandlers): void {
  let payload: unknown = {};
  if (data.length > 0) {
    try {
      payload = JSON.parse(data);
    } catch {
      return; // ignore unparseable frames (e.g. stray comment text)
    }
  }
  switch (event) {
    case 'agent:thinking':
      handlers.onThinking?.(payload as AgentThinkingPayload);
      return;
    case 'agent:tool_call':
      handlers.onToolCall?.(payload as AgentToolCallPayload);
      return;
    case 'agent:tool_result':
      handlers.onToolResult?.(payload as AgentToolResultPayload);
      return;
    case 'agent:done':
      handlers.onDone?.(payload as AgentDonePayload);
      return;
    case 'agent:error':
      handlers.onError?.(payload as AgentErrorPayload);
      return;
    case 'usage':
      handlers.onUsage?.(payload as AgentUsagePayload);
      return;
    default:
      return; // heartbeats and unknown events: no-op
  }
}

/**
 * The production transport: POST + ReadableStream reader + parseSseFrames.
 * Surfaces a non-2xx response or a network throw as a synthetic `onError` so the
 * caller never silently stalls.
 */
export const fetchAgentTransport: AgentTransport = async (req, handlers) => {
  let response: Response;
  try {
    response = await fetch('/api/ai/cms-agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
  } catch (err) {
    handlers.onError?.({
      code: 'network_error',
      message: err instanceof Error ? err.message : 'request failed',
    });
    return;
  }

  if (!response.ok || !response.body) {
    let message = `Request failed (${response.status})`;
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      if (body.error?.message) message = body.error.message;
    } catch {
      // non-JSON error body; keep the status message
    }
    handlers.onError?.({ code: 'http_error', message });
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let done = false;
  while (!done) {
    const chunk = await reader.read();
    done = chunk.done;
    if (chunk.value) {
      buffer += decoder.decode(chunk.value, { stream: true });
      const parsed = parseSseFrames(buffer);
      buffer = parsed.rest;
      for (const frame of parsed.frames) dispatch(frame.event, frame.data, handlers);
    }
  }
  // Flush any trailing buffered frame.
  buffer += decoder.decode();
  const { frames } = parseSseFrames(buffer.endsWith('\n\n') ? buffer : `${buffer}\n\n`);
  for (const frame of frames) dispatch(frame.event, frame.data, handlers);
};
