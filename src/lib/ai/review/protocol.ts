// src/lib/ai/review/protocol.ts
//
// Client-safe wire types and budgets of the visual review pass (plan
// docs/plans/2026-10-23-ai-design-quality-round-2.md, decision 4): the editor
// measures the rendered page (./layoutAudit.ts, ./measureDom.ts), captures the
// breakpoint frames (./capture.ts) and sends both with the page tree to
// POST /api/ai/review-page, which answers with validated patch operations
// (./ops.ts) the editor applies as one undo step (./applyOps.ts).
//
// No server-only imports: the route and the browser both read this file.

import type { LayoutFinding } from './layoutAudit';
import type { PageGenModel } from '@/lib/ai/pageGen/protocol';
import type { BreakpointInput } from '@/lib/ai/pageGen/schema';

/** Models the review may run on: both read images. Sonnet is the default, Opus the careful option. */
export const REVIEW_MODELS = ['SONNET', 'OPUS'] as const satisfies readonly PageGenModel[];
export type ReviewModel = (typeof REVIEW_MODELS)[number];
export const DEFAULT_REVIEW_MODEL: ReviewModel = 'SONNET';

/** Hard per-request budgets. The route enforces them; the client stays under them. */
export const REVIEW_LIMITS = {
  /** Serialized page tree, in characters (a 200-node generated page is about 60k). */
  maxTreeChars: 150_000,
  /** Findings sent with one request (the audit sorts the worst first). */
  maxFindings: 60,
  /** Captured frames per request (Desktop and the smallest breakpoint). */
  maxImages: 2,
  /** One image as base64, in characters (about 1.1 MB of JPEG). */
  maxImageBase64Chars: 1_500_000,
  /** The original brief, when known. */
  maxBriefChars: 4000,
  /** Patch operations accepted from one review (more are dropped and reported). */
  maxOps: 40,
  /** Of those, node removals (a review is a polish, never a rewrite). */
  maxRemovals: 3,
  /** Longest `reason` the model may give for one fix, in characters. */
  maxReasonChars: 200,
} as const;

/** One captured breakpoint frame. */
export interface ReviewImage {
  /** The breakpoint key the frame shows ("desktop", "phone", ...). */
  breakpoint: string;
  mediaType: 'image/jpeg';
  /** Base64 without the data: prefix. */
  data: string;
  /** Rendered size in px (after scaling) and the frame's css width, for the prompt. */
  width: number;
  height: number;
  cssWidth: number;
  /** True when the capture stopped before the end of a tall page. */
  truncated: boolean;
}

/** A node of the page tree as the review sees it (responsive maps keyed by breakpoint KEY). */
export interface ReviewTreeNode {
  id: string;
  type: string;
  label?: string;
  props: Record<string, unknown>;
  children: ReviewTreeNode[];
}

export interface ReviewRequest {
  model?: ReviewModel;
  /** The page's breakpoints (labels and min widths; the route derives the keys). */
  breakpoints: BreakpointInput[];
  /** The page root (the app tree), its responsive maps keyed by breakpoint key. */
  tree: ReviewTreeNode;
  findings: LayoutFinding[];
  images: ReviewImage[];
  /** The brief the page was generated from, when known. */
  brief?: string;
  /** Problems on the client side the model should know about ("the phone capture failed"). */
  notes?: string[];
}

/**
 * One fix. `breakpoint` is a breakpoint KEY or null for the largest
 * breakpoint (which writes the base value, desktop-first like the editor:
 * src/lib/responsive/cascade.ts). `value: null` removes the value on that
 * breakpoint, so it inherits from the next larger one again.
 */
export type ReviewOp =
  | {
      op: 'update_style';
      nodeId: string;
      breakpoint: string | null;
      property: string;
      value: string | number | null;
      reason: string;
    }
  | { op: 'update_text'; nodeId: string; text: string; reason: string }
  | { op: 'remove_node'; nodeId: string; reason: string };

/** An operation the server (or the client) refused, with why. */
export interface RejectedOp {
  index: number;
  reason: string;
}

/** SSE `review:progress`. */
export interface ReviewProgress {
  phase: 'reviewing' | 'validating';
  receivedChars: number;
}

/** SSE `review:result`. */
export interface ReviewResultPayload {
  reviewId: string;
  /** The model's one-paragraph assessment. */
  summary: string;
  ops: ReviewOp[];
  rejected: RejectedOp[];
  model: string;
}

export interface ReviewErrorPayload {
  code: string;
  message: string;
  retryAfterSec?: number;
}

export interface ReviewUsagePayload {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * List prices per million tokens (input / output), the same table as the
 * comment in src/lib/ai/anthropicClient.ts. Cache reads bill at a tenth of
 * input, cache writes at 1.25 times. Kept here because that module is
 * server-only; the dialog uses it to show an estimate, never to bill.
 */
const PRICES: Record<PageGenModel, { input: number; output: number }> = {
  HAIKU: { input: 0.1, output: 0.5 },
  SONNET: { input: 2, output: 10 },
  OPUS: { input: 4, output: 20 },
};

/** Estimated cost of one call in US dollars, from its token counts. */
export function estimateCostUsd(model: PageGenModel, usage: ReviewUsagePayload): number {
  const p = PRICES[model];
  const perToken = (perMillion: number) => perMillion / 1_000_000;
  return (
    usage.inputTokens * perToken(p.input) +
    usage.cacheReadTokens * perToken(p.input) * 0.1 +
    usage.cacheWriteTokens * perToken(p.input) * 1.25 +
    usage.outputTokens * perToken(p.output)
  );
}

/** "$0.04", or "under $0.01". */
export function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd < 0.01) return 'under $0.01';
  return `$${usd.toFixed(2)}`;
}
