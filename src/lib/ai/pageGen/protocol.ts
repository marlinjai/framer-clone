// src/lib/ai/pageGen/protocol.ts
//
// Client-safe wire types shared by POST /api/ai/generate-page (server) and the
// editor's Generate page dialog (client). No server-only imports.

import type { GeneratedNodeSnapshot } from './validate';
import type { BreakpointInput } from './schema';
import { MODEL_CHOICES, type ModelChoice } from '@/lib/ai/modelChoice';
import type { SiteContext } from './promptSections/siteContext';

/**
 * Models the page generator may run on: the slider's three steps (Fast =
 * Haiku 5.5, Balanced = Sonnet 5.5, Best = Opus 5.5). The route validates the
 * key against this list and maps it to a model id on the server.
 */
export const PAGE_GEN_MODELS = MODEL_CHOICES;
export type PageGenModel = ModelChoice;
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
  /** Site language and real contact data from Site settings (promptSections/siteContext.ts). */
  siteContext?: SiteContext;
  /** The run's id (a UUID), chosen by the browser transport before sending. */
  runId?: string;
}

/**
 * SSE `gen:started`: the first event. The run's id, which the editor keeps so
 * it can collect the run (GET /api/ai/generate-page/[id]) after losing the
 * stream, or cancel it (DELETE on the same path).
 */
export interface PageGenStarted {
  generationId: string;
}

/** SSE `gen:progress`: the model is writing (or the server is checking / repairing). */
export interface PageGenProgress {
  phase: 'generating' | 'validating' | 'repairing' | 'images';
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
  /** Automatic fixes: the validator's repairs plus the design tells fixed (./tells.ts). */
  warnings: string[];
  /**
   * Tells of generated design still in the applied page (the repair round did
   * not remove them, or there was none left). Empty or absent when clean.
   */
  tells?: string[];
  stats: { nodeCount: number; maxDepth: number };
  model: string;
  /** What happened to the images the model asked stock photos for. */
  images: StockImageSummary;
}

/**
 * Why some (or all) images kept the placeholder instead of a stock photo:
 *   disabled      no UNSPLASH_ACCESS_KEY on the server (the feature is off)
 *   auth          Unsplash refused the key (401 / 403)
 *   rate_limited  the hourly Unsplash request limit is used up (429)
 *   unavailable   Unsplash answered 5xx or could not be reached
 *   timeout       Unsplash did not answer in time
 *   no_results    no (unused) photo matched the image's description
 *   cap           more images than one generation resolves
 *   invalid_query the model's description of the image was unusable
 */
export type StockImageFallbackReason =
  | 'disabled'
  | 'auth'
  | 'rate_limited'
  | 'unavailable'
  | 'timeout'
  | 'no_results'
  | 'cap'
  | 'invalid_query';

/** Photographer credit for one placed photo (Unsplash attribution). */
export interface StockPhotoCredit {
  photoId: string;
  photographerName: string;
  /** The photographer's Unsplash profile, with the referral utm parameters. */
  photographerUrl: string;
  /** unsplash.com, with the referral utm parameters. */
  unsplashUrl: string;
}

export interface StockImageSummary {
  /** Images the model described with an imageQuery (usable or not). */
  requested: number;
  /** Images that now show a stock photo. */
  resolved: number;
  /** Images that kept the placeholder, counted per reason. */
  fellBack: Partial<Record<StockImageFallbackReason, number>>;
  /** One credit per placed photo, in page order. */
  credits: StockPhotoCredit[];
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
