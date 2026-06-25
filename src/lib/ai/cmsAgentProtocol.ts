// src/lib/ai/cmsAgentProtocol.ts
//
// Client-safe wire types shared between the CMS content agent route (server)
// and the ContentAgentPanel (client). Kept free of server-only imports (no
// Anthropic SDK, no adapter) so a client component can import it without
// pulling the executor into the browser bundle.

/** One per-tool summary, shown as a row in the Changes card. */
export interface AgentChangeSummary {
  tool: string;
  entityType: string;
  icon: string; // lucide icon name
  count: number;
  label: string;
}

/** SSE `agent:thinking` payload: a chunk of model reasoning narration. */
export interface AgentThinkingPayload {
  text: string;
}

/** SSE `agent:tool_call` payload: a tool invocation is starting. */
export interface AgentToolCallPayload {
  tool: string;
  input: Record<string, unknown>;
}

/** SSE `agent:tool_result` payload: a tool finished (success or handled error). */
export interface AgentToolResultPayload {
  tool: string;
  success: boolean;
  summary: string;
}

/** SSE `agent:done` payload: the run completed; carries the change summaries. */
export interface AgentDonePayload {
  runId: string;
  changes: AgentChangeSummary[];
}

/** SSE `agent:error` payload: an unrecoverable error (never swallowed). */
export interface AgentErrorPayload {
  code: string;
  message: string;
}

/** SSE `usage` payload: token accounting after the loop ends. */
export interface AgentUsagePayload {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

/** Response shape from POST /api/ai/cms-agent/undo. */
export interface UndoResult {
  undone: number;
  skipped: number;
  warnings: string[];
}
