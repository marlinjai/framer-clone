// src/lib/ai/pageGen/protocol.ts
//
// Client-safe wire types shared by POST /api/ai/generate-page (server) and the
// editor's Generate page dialog (client). No server-only imports.

import type { GeneratedNodeSnapshot } from './validate';
import type { BreakpointInput } from './schema';

/** Models the page generator may run on (Opus is deliberately not offered: cost per page). */
export const PAGE_GEN_MODELS = ['SONNET', 'HAIKU'] as const;
export type PageGenModel = (typeof PAGE_GEN_MODELS)[number];
export const DEFAULT_PAGE_GEN_MODEL: PageGenModel = 'SONNET';

/** Where the generated nodes go. */
export type PageGenTarget =
  | { kind: 'newPage'; title?: string }
  /** Replace the selected component (the app-tree root: replace its children). */
  | { kind: 'replace'; context: unknown }
  /** Append inside the selected container. */
  | { kind: 'insert'; context: unknown };

export interface PageGenRequest {
  brief: string;
  model?: PageGenModel;
  /** The target page's breakpoints (labels + min widths; ids stay on the client). */
  breakpoints: BreakpointInput[];
  target: PageGenTarget;
  /** Project name, for tone only. */
  projectName?: string;
  /** Existing page titles, so a new page does not duplicate one. */
  existingPageTitles?: string[];
}

/** SSE `gen:progress`: the model is writing (or the server is checking / repairing). */
export interface PageGenProgress {
  phase: 'generating' | 'validating' | 'repairing';
  /** Characters of structured output received so far in this attempt. */
  receivedChars: number;
  attempt: number;
}

/** SSE `gen:result`: a validated generation, ready to apply. */
export interface PageGenResultPayload {
  generationId: string;
  title?: string;
  description?: string;
  nodes: GeneratedNodeSnapshot[];
  warnings: string[];
  stats: { nodeCount: number; maxDepth: number };
  model: string;
}

/**
 * SSE `gen:error` and the JSON error envelope's `code`. The dialog maps each
 * code to its own message, so the user can tell "try again later" from
 * "rephrase" from "ask an admin".
 */
export type PageGenErrorCode =
  | 'invalid_output'
  | 'refused'
  | 'rate_limited'
  | 'overloaded'
  | 'provider_unavailable'
  | 'provider_auth'
  | 'missing_anthropic_key'
  | 'aborted'
  | 'generation_failed'
  | 'network_error'
  | 'unauthorized'
  | 'forbidden'
  | 'no_active_company'
  | 'sites_not_enabled'
  | 'auth_unavailable'
  | 'authz_unavailable'
  | 'bad_json'
  | 'bad_body'
  | 'context_too_large'
  | 'http_error';

export interface PageGenErrorPayload {
  code: PageGenErrorCode | string;
  message: string;
  /** Validation errors of the last attempt (invalid_output only). */
  details?: string[];
  /** Seconds to wait before retrying (rate_limited). */
  retryAfterSec?: number;
}

export interface PageGenUsagePayload {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  attempts: number;
}
