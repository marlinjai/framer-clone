// src/components/cms/agent/types.ts
//
// Client-side chat model for the Content agent panel. The transcript is
// ephemeral per session (run metadata is persisted server-side as AgentRun; the
// chat itself is not, per the phase-2a deferral).

import type { AgentChangeSummary } from '@/lib/ai/cmsAgentProtocol';

/** One executed-tool line shown inside an assistant turn. */
export interface AssistantStep {
  tool: string;
  success: boolean;
  summary: string;
}

export type ChatMessage =
  | { kind: 'user'; id: string; text: string; csvName?: string }
  | {
      kind: 'assistant';
      id: string;
      /** True while reasoning/tool calls are still streaming. */
      thinking: boolean;
      steps: AssistantStep[];
      /** Present after agent:done. */
      changes?: AgentChangeSummary[];
      runId?: string;
    }
  | { kind: 'error'; id: string; message: string };
