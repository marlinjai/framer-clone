// src/lib/ai/brief/schema.ts
//
// The request and response shapes of the two brief helpers of the Generate
// dialog (plan docs/plans/2026-11-04-page-generator-ideas-and-streaming.md,
// pull request 1):
//   - POST /api/ai/page-ideas: six page or section ideas tailored to the site,
//   - POST /api/ai/enhance-brief: the brief rewritten with more structure,
//     streamed back as Server-Sent Events (SSE).
//
// Shared by the routes (validation) and the browser client (types), so it
// holds no server import.

import { z } from 'zod';
import { GENERATION_LIMITS } from '@/lib/ai/pageGen/schema';
import { SiteContextSchema } from '@/lib/ai/pageGen/promptSections/siteContext';

export const BRIEF_LIMITS = {
  /** Ideas per set. */
  ideasPerSet: 6,
  maxIdeaTitleChars: 60,
  maxIdeaBriefChars: 400,
  /** The serialized selected component sent for replace/insert ideas and Enhance. */
  maxContextChars: 12_000,
  /** Titles already shown, sent with "More ideas" so the next set differs. */
  maxExclude: 30,
  /** The enhanced brief never exceeds what the generator accepts. */
  maxBriefChars: GENERATION_LIMITS.maxBriefChars,
} as const;

export type BriefTargetKind = 'newPage' | 'replace' | 'insert';

export interface PageIdea {
  title: string;
  brief: string;
}

const TargetKindSchema = z.enum(['newPage', 'replace', 'insert']);

/** The site the ideas or the rewrite are for (the fields buildRequest already sends). */
const ContextFields = {
  targetKind: TargetKindSchema,
  projectName: z.string().max(120).optional(),
  existingPageTitles: z.array(z.string().max(120)).max(100).optional(),
  siteContext: SiteContextSchema.optional(),
  /** replace / insert: the selected component, serialized and capped by the client. */
  context: z.unknown().optional(),
};

export const IdeasBodySchema = z.strictObject({
  ...ContextFields,
  exclude: z.array(z.string().max(BRIEF_LIMITS.maxIdeaTitleChars * 2)).max(BRIEF_LIMITS.maxExclude).optional(),
});
export type IdeasRequest = z.infer<typeof IdeasBodySchema>;

export const EnhanceBodySchema = z.strictObject({
  ...ContextFields,
  brief: z
    .string()
    .trim()
    .min(1, 'brief must not be empty')
    .max(BRIEF_LIMITS.maxBriefChars, `brief must be at most ${BRIEF_LIMITS.maxBriefChars} characters`),
});
export type EnhanceRequest = z.infer<typeof EnhanceBodySchema>;

export interface IdeasResponse {
  ideas: PageIdea[];
}

/** An error as the routes and the stream report it. */
export interface BriefErrorPayload {
  code: string;
  message: string;
  retryAfterSec?: number;
}

/** SSE events of POST /api/ai/enhance-brief, in order: delta*, then done or error, then usage. */
export const ENHANCE_EVENTS = {
  delta: 'enhance:delta',
  done: 'enhance:done',
  error: 'enhance:error',
} as const;

export interface EnhanceDelta {
  text: string;
}
export interface EnhanceDone {
  text: string;
}

/** True when the serialized context fits the budget (the routes refuse more). */
export function contextFits(context: unknown): boolean {
  if (context === undefined || context === null) return true;
  return JSON.stringify(context).length <= BRIEF_LIMITS.maxContextChars;
}
