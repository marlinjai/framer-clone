// src/lib/ai/anthropicClient.ts
//
// Singleton Anthropic SDK client + model registry for the AI surface.
//
// Server-only. The key is loaded from `process.env.ANTHROPIC_API_KEY`
// (Infisical for local dev, Coolify env for prod). Never import this from
// a client component — Next.js will throw the moment it lands in a
// browser bundle.
//
// Model constants are exposed as a typed map so callers escalate via a
// key (`'HAIKU' | 'SONNET' | 'OPUS'`) instead of stringly-typed model IDs
// scattered across the codebase. Default is Haiku; Sonnet is the
// escalation lever; Opus drives the CMS content agent.
//
// Current-generation request rules (Claude Haiku 5.5, Sonnet 5.5, Opus 5.5):
//   - thinking is adaptive and on by default; `thinking: {type: "disabled"}`
//     and `budget_tokens` are rejected, so no route sends `thinking` at all and
//     every route sets `output_config.effort` explicitly (modelRequestFields),
//   - no `temperature` / `top_p` / `top_k`, no assistant prefill, no forced
//     `tool_choice` (`any` / `tool`): routes use `auto` and check the call,
//   - a response can start with `thinking` blocks (empty text by default), so
//     content is always read by block type, and multi-turn loops send the
//     assistant content back unchanged (replayableAssistantContent),
//   - a classifier decline is an HTTP 200 with `stop_reason: "refusal"`,
//     checked before any content is read (refusalMessage),
//   - Sonnet 5.5 and Opus 5.5 requests opt into server-side fallback
//     (`fallbacks: "default"`, beta server-side-fallback-2026-07-01) through
//     the beta Messages API; Haiku 5.5 has no server-side fallback.

import Anthropic from '@anthropic-ai/sdk';
import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaMessage,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';

/**
 * Public model registry. Keys are stable; values may be retargeted to
 * newer versions when Anthropic ships them. List prices per million tokens
 * (input / output, prompts up to the long-context threshold):
 *   HAIKU  claude-haiku-5-5   $0.10 / $0.50
 *   SONNET claude-sonnet-5-5  $2 / $10
 *   OPUS   claude-opus-5-5    $4 / $20
 */
export const AI_MODELS = {
  HAIKU: 'claude-haiku-5-5',
  SONNET: 'claude-sonnet-5-5',
  OPUS: 'claude-opus-5-5',
} as const;

export type AiModelKey = keyof typeof AI_MODELS;
export type AiModelId = (typeof AI_MODELS)[AiModelKey];

/** Effort levels of `output_config.effort` (the thinking and spend control). */
export type AiEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Beta header that gates `fallbacks: "default"`. */
export const SERVER_SIDE_FALLBACK_BETA = 'server-side-fallback-2026-07-01' as const;

/** Models with a server-side fallback (Haiku 5.5 has none: a list would 400). */
const FALLBACK_MODELS: ReadonlySet<AiModelKey> = new Set<AiModelKey>(['SONNET', 'OPUS']);

/**
 * Resolve the default model from env (`AI_DEFAULT_MODEL`), with a
 * conservative fallback to Haiku. Sonnet escalation happens explicitly
 * at the call site, not via env.
 */
export function getDefaultModelKey(): AiModelKey {
  const raw = process.env.AI_DEFAULT_MODEL;
  if (raw === 'SONNET' || raw === 'HAIKU') return raw;
  return 'HAIKU';
}

export function resolveModelId(key: AiModelKey = getDefaultModelKey()): AiModelId {
  return AI_MODELS[key];
}

/**
 * The model-dependent part of every beta Messages request: the model id, an
 * explicit effort (Haiku 5.5 and Opus 5.5 default to `medium`, Sonnet 5.5 to
 * `high`, so leaving it out would make cost depend on the model), and, for
 * Sonnet and Opus, the server-side fallback opt-in so a classifier false
 * positive is retried instead of failing the request.
 */
export function modelRequestFields(
  key: AiModelKey,
  effort: AiEffort,
): {
  model: AiModelId;
  output_config: { effort: AiEffort };
  betas?: Array<typeof SERVER_SIDE_FALLBACK_BETA>;
  fallbacks?: 'default';
} {
  return {
    model: AI_MODELS[key],
    output_config: { effort },
    ...(FALLBACK_MODELS.has(key)
      ? { betas: [SERVER_SIDE_FALLBACK_BETA], fallbacks: 'default' as const }
      : {}),
  };
}

/** Beta header that enables `thinking.display: "updates"`. */
export const THINKING_DISPLAY_UPDATES_BETA = 'thinking-display-updates-2026-08-18' as const;

/** Models that return between-tool progress notes as `thinking` blocks. */
const PROGRESS_UPDATE_MODELS: ReadonlySet<AiModelKey> = new Set<AiModelKey>(['SONNET', 'OPUS']);

/**
 * For agent loops that show the model's narration: on Sonnet 5.5 and Opus 5.5
 * the notes written between tool calls come back as `thinking` blocks that are
 * empty by default, so a panel that renders only text would go quiet.
 * `display: "updates"` returns a short summary of each note (reasoning itself
 * stays hidden). Merge the result into the request; combine `betas` with
 * modelRequestFields' list (mergeBetas). Haiku keeps its default.
 */
export function progressUpdateFields(key: AiModelKey): {
  thinking?: { type: 'adaptive'; display: 'updates' };
  betas?: Array<typeof THINKING_DISPLAY_UPDATES_BETA>;
} {
  return PROGRESS_UPDATE_MODELS.has(key)
    ? { thinking: { type: 'adaptive', display: 'updates' }, betas: [THINKING_DISPLAY_UPDATES_BETA] }
    : {};
}

/** Union of beta lists, undefined when empty (a request may omit `betas`). */
export function mergeBetas<T extends string>(...lists: Array<T[] | undefined>): T[] | undefined {
  const all = [...new Set(lists.flatMap((l) => l ?? []))];
  return all.length > 0 ? all : undefined;
}

/**
 * When the response is a classifier decline, a message the user can act on;
 * otherwise null. Callers check this BEFORE reading `content`.
 */
export function refusalMessage(message: Pick<BetaMessage, 'stop_reason'> & { stop_details?: unknown }): string | null {
  if (message.stop_reason !== 'refusal') return null;
  const details = message.stop_details as { category?: string | null } | null | undefined;
  const category = details?.category ? ` (category: ${details.category})` : '';
  return `The AI declined this request${category}. Rephrase it and try again.`;
}

/**
 * The assistant turn to send back in the next request of a multi-turn loop:
 * the response content unchanged (thinking blocks included: removing them
 * breaks the conversation's thinking chain), with one exception the API
 * defines. After a mid-output server-side fallback, thinking, redacted
 * thinking and tool_use blocks that appear BEFORE the last `fallback` block
 * belong to the declined model and must be omitted; everything after the
 * boundary, text blocks, and the marker itself echo normally.
 */
export function replayableAssistantContent(content: BetaContentBlock[]): BetaContentBlockParam[] {
  let boundary = -1;
  content.forEach((block, i) => {
    if (block.type === 'fallback') boundary = i;
  });
  const kept =
    boundary < 0
      ? content
      : content.filter(
          (block, i) =>
            i >= boundary ||
            !(block.type === 'thinking' || block.type === 'redacted_thinking' || block.type === 'tool_use'),
        );
  return kept as unknown as BetaContentBlockParam[];
}

/**
 * True for the SDK's local "could not parse the tool input JSON" failure
 * (eager input streaming hands over unvalidated fragments). It is not an API
 * error, so callers treat it like invalid model output, never like an outage.
 */
export function isToolInputParseError(err: unknown): boolean {
  return (
    err instanceof Anthropic.AnthropicError &&
    !(err instanceof Anthropic.APIError) &&
    /Unable to parse tool parameter JSON/.test(err.message)
  );
}

/**
 * Thrown when `ANTHROPIC_API_KEY` is missing. Callers should map this
 * to a 401 in API routes (the spec uses 401 for "key missing").
 */
export class MissingAnthropicKeyError extends Error {
  readonly code = 'missing_anthropic_key';
  constructor() {
    super(
      'ANTHROPIC_API_KEY is not set. Run via `infisical run --env=dev -- pnpm dev` or set the env var directly.',
    );
    this.name = 'MissingAnthropicKeyError';
  }
}

let _client: Anthropic | null = null;

/**
 * Returns a process-wide Anthropic client. Throws
 * `MissingAnthropicKeyError` synchronously if the key is missing — fail
 * fast so misconfigured deploys surface immediately at route time
 * instead of mid-stream.
 *
 * The client is cached per-process; calling this in a hot path is fine.
 */
export function getAnthropicClient(): Anthropic {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey.length === 0) {
    throw new MissingAnthropicKeyError();
  }
  _client = new Anthropic({ apiKey });
  return _client;
}

/**
 * Test-only: drop the cached client so the next `getAnthropicClient()`
 * re-reads `process.env`. Not exported from the package index — only
 * unit tests reach for this.
 */
export function __resetAnthropicClientForTests(): void {
  _client = null;
}
