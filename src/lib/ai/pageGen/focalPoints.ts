// src/lib/ai/pageGen/focalPoints.ts
//
// Server-only: find where each placed stock photo's subject is, so the crop
// keeps it in view. The page generator's model never sees the photos (it only
// writes a search query), and the editor crops every photo with
// `object-fit: cover` (img) or `background-size: cover` (photo background),
// so without this pass every crop is centred and a subject off-centre (a face
// near the top, a product at the side) is cut off on a wide or tall box.
//
// One batched call per generation to the Haiku tier (cheap and vision
// capable, AI_MODELS.HAIKU at effort low), with a small thumbnail of every
// placed photo passed by URL (Anthropic fetches images.unsplash.com
// directly; nothing is downloaded here). The model answers through one tool
// call, `report_focal_points`, with a point per photo in percent; the route
// writes it as objectPosition / backgroundPosition (./stockImages.ts).
//
// Bounded and fail-soft: at most GENERATION_LIMITS.maxStockImages photos, one
// request with a timeout (DEFAULT_TIMEOUT_MS) that also stops when the
// generation is cancelled, a small max_tokens. Any failure (timeout, refusal,
// no tool call, malformed or out-of-range answers, an API error) leaves the
// affected photos without a point, which the caller writes as a centred
// crop; it is logged with a warning and never fails the generation. Logs
// carry counts and error names, never photo URLs or the brief.

import 'server-only';
import type Anthropic from '@anthropic-ai/sdk';
import type {
  BetaContentBlockParam,
  BetaTool,
  BetaToolUseBlock,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { AI_MODELS, modelRequestFields, refusalMessage } from '@/lib/ai/anthropicClient';
import type { FocalPoint } from '@/lib/images/imageStyle';
import { GENERATION_LIMITS } from './schema';

export const FOCAL_TOOL_NAME = 'report_focal_points';
/** The whole pass, from request to answer. */
export const DEFAULT_FOCAL_TIMEOUT_MS = 12_000;
/** A point per photo is about 20 tokens; adaptive thinking shares the cap. */
const MAX_OUTPUT_TOKENS = 2_000;
/** The model the pass runs on (exported for the call log). */
export const FOCAL_MODEL = AI_MODELS.HAIKU;

export type FocalPassStatus = 'ok' | 'partial' | 'failed' | 'skipped';

export interface FocalPassResult {
  /** One entry per input photo, in order; undefined where no usable point came back. */
  points: Array<FocalPoint | undefined>;
  status: FocalPassStatus;
  /** Why the pass failed or was partial (an error name or a short code), for the log. */
  reason?: string;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
}

export interface FocalPassDeps {
  client: Pick<Anthropic, 'beta'>;
  /** The generation's signal: a cancelled generation stops the pass. */
  signal?: AbortSignal;
  timeoutMs?: number;
}

const INSTRUCTIONS = [
  'You frame photos for a website builder. Each photo below follows a line "Photo N".',
  'The page crops every photo to fill its box, so part of it is cut away. For each photo, report the',
  'point that must stay visible:',
  '- a person: the face, between the eyes; several people: the centre of the group,',
  '- an object, animal, dish or building: the centre of that subject,',
  '- a landscape, interior or texture without one subject: the most interesting area (the horizon',
  '  line, the lit part), or the centre when nothing stands out.',
  'x is the percent from the left edge, y the percent from the top edge, both 0 to 100.',
  `Call ${FOCAL_TOOL_NAME} exactly once with one entry per photo. Never answer in prose.`,
].join('\n');

function focalTool(): BetaTool {
  return {
    name: FOCAL_TOOL_NAME,
    description: 'Report where the subject of each numbered photo is, in percent of the photo.',
    input_schema: {
      type: 'object',
      properties: {
        points: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              photo: { type: 'integer', description: 'The photo number N from "Photo N".' },
              x: { type: 'number', description: 'Percent from the left edge, 0 to 100.' },
              y: { type: 'number', description: 'Percent from the top edge, 0 to 100.' },
            },
            required: ['photo', 'x', 'y'],
          },
        },
      },
      required: ['points'],
    },
  };
}

function emptyUsage(): FocalPassResult['usage'] {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

function logWarn(message: string, meta: Record<string, unknown>): void {
  console.warn(`[focal-points] ${message} ${JSON.stringify(meta)}`);
}

function isTimeout(err: unknown): boolean {
  return !!err && typeof err === 'object' && 'name' in err && (err as { name: unknown }).name === 'TimeoutError';
}

/** A finite number in 0 to 100 (a value slightly outside is clamped; far outside is refused). */
function percent(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  if (value < -5 || value > 105) return undefined;
  return Math.min(100, Math.max(0, value));
}

/**
 * Read the tool input into one point per photo. Entries with a photo number
 * outside 1..count, a non-numeric or far out-of-range coordinate, or a repeat
 * of an earlier photo are skipped.
 */
export function parseFocalPoints(input: unknown, count: number): Array<FocalPoint | undefined> {
  const points: Array<FocalPoint | undefined> = Array.from({ length: count }, () => undefined);
  const list = (input as { points?: unknown } | null | undefined)?.points;
  if (!Array.isArray(list)) return points;
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as { photo?: unknown; x?: unknown; y?: unknown };
    const n = typeof e.photo === 'number' && Number.isInteger(e.photo) ? e.photo : undefined;
    if (n === undefined || n < 1 || n > count || points[n - 1]) continue;
    const x = percent(e.x);
    const y = percent(e.y);
    if (x === undefined || y === undefined) continue;
    points[n - 1] = { x, y };
  }
  return points;
}

/**
 * Find the focal point of each photo (thumbnail URLs, in page order). Never
 * throws: see the file header for what happens on failure.
 */
export async function detectFocalPoints(thumbUrls: string[], deps: FocalPassDeps): Promise<FocalPassResult> {
  const count = Math.min(thumbUrls.length, GENERATION_LIMITS.maxStockImages);
  const none = (status: FocalPassStatus, reason?: string, usage = emptyUsage()): FocalPassResult => ({
    points: Array.from({ length: thumbUrls.length }, () => undefined),
    status,
    ...(reason ? { reason } : {}),
    usage,
  });
  if (count === 0) return none('skipped', 'no_photos');
  if (deps.signal?.aborted) return none('skipped', 'aborted');

  const content: BetaContentBlockParam[] = [];
  for (let i = 0; i < count; i++) {
    content.push({ type: 'text', text: `Photo ${i + 1}` });
    content.push({ type: 'image', source: { type: 'url', url: thumbUrls[i] } });
  }
  content.push({ type: 'text', text: `Report the focal point of all ${count} photos.` });

  const timeout = AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_FOCAL_TIMEOUT_MS);
  const signal = deps.signal ? AbortSignal.any([deps.signal, timeout]) : timeout;
  const usage = emptyUsage();
  try {
    const message = await deps.client.beta.messages.create(
      {
        ...modelRequestFields('HAIKU', 'low'),
        max_tokens: MAX_OUTPUT_TOKENS,
        system: INSTRUCTIONS,
        tools: [focalTool()],
        // Current models reject a forced tool_choice: `auto` plus the instruction.
        tool_choice: { type: 'auto', disable_parallel_tool_use: true },
        messages: [{ role: 'user', content }],
      },
      { signal },
    );
    usage.inputTokens = message.usage.input_tokens;
    usage.outputTokens = message.usage.output_tokens;
    usage.cacheReadTokens = message.usage.cache_read_input_tokens ?? 0;
    usage.cacheWriteTokens = message.usage.cache_creation_input_tokens ?? 0;

    if (refusalMessage(message)) {
      logWarn('declined', { photos: count });
      return none('failed', 'refused', usage);
    }
    const toolUse = message.content.find(
      (b): b is BetaToolUseBlock => b.type === 'tool_use' && b.name === FOCAL_TOOL_NAME,
    );
    if (!toolUse) {
      logWarn('no tool call', { photos: count, stopReason: message.stop_reason });
      return none('failed', 'no_tool_call', usage);
    }
    const parsed = parseFocalPoints(toolUse.input, count);
    const points = [...parsed, ...Array.from({ length: thumbUrls.length - count }, () => undefined)];
    const found = parsed.filter(Boolean).length;
    if (found === 0) {
      logWarn('no usable point', { photos: count });
      return { points, status: 'failed', reason: 'malformed', usage };
    }
    if (found < count) {
      logWarn('some photos without a point', { photos: count, found });
      return { points, status: 'partial', reason: 'missing_points', usage };
    }
    return { points, status: 'ok', usage };
  } catch (err) {
    if (deps.signal?.aborted) return none('skipped', 'aborted', usage);
    const reason = isTimeout(err) || timeout.aborted ? 'timeout' : err instanceof Error ? err.name : 'error';
    logWarn('failed, crops stay centred', { photos: count, reason });
    return none('failed', reason, usage);
  }
}
