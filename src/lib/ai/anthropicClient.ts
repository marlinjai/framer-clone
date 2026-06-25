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
// escalation lever; Opus is reserved for Pattern B planning passes
// (Phase 2 scaffolding only — not wired here).

import Anthropic from '@anthropic-ai/sdk';

/**
 * Public model registry. Keys are stable; values may be retargeted to
 * newer minor versions when Anthropic ships them.
 */
export const AI_MODELS = {
  HAIKU: 'claude-haiku-4-5',
  SONNET: 'claude-sonnet-4-6',
  // Drives the CMS content agent's tool-use loop (Pattern B). Bumped from
  // claude-opus-4-7; Opus 4.8 is a drop-in upgrade, no behavior change.
  OPUS: 'claude-opus-4-8',
} as const;

export type AiModelKey = keyof typeof AI_MODELS;
export type AiModelId = (typeof AI_MODELS)[AiModelKey];

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
