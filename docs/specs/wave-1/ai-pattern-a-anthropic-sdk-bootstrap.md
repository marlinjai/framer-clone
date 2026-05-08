---
name: ai-pattern-a-anthropic-sdk-bootstrap
track: ai-pattern-a
wave: 1
priority: P0
status: draft
depends_on: []
estimated_value: 8
estimated_cost: 3
owner: unassigned
---

# Anthropic SDK bootstrap and AI route scaffold

## Goal

Stand up the server-side AI surface: install `@anthropic-ai/sdk`, wire a Next.js API route at `/api/ai/edit`, configure prompt-caching plumbing (cache breakpoints, 1-hour TTL), structured logging, and per-request error handling. No tools registered yet, no MST mutations. This is the foundation every other ai-pattern-a spec builds on. Without it, no AI feature can run.

## Scope

**In:**
- Add `@anthropic-ai/sdk` dependency
- New API route `src/app/api/ai/edit/route.ts` (POST), accepts `{ prompt, sessionId, pageId, selection? }`, returns SSE stream
- Anthropic client singleton with `ANTHROPIC_API_KEY` from env (loaded via Infisical for local dev, set in Coolify for prod)
- Model selection helper: Haiku 4.5 default, Sonnet 4.6 escalation flag, Opus 4.7 reserved (Phase 2 scaffolding)
- Prompt-caching primitives: helper to assemble system blocks with `cache_control: { type: "ephemeral", ttl: "1h" }` markers. Cache breakpoint placed at end of stable prefix (registry + tool schemas + instructions), volatile state (page snapshot, selection) sits AFTER the cached block.
- Stub system prompt that just echoes "AI not yet wired" until the tool registry spec lands
- Structured JSON logging per request: `requestId`, `userId` (placeholder until auth-brain), `model`, `inputTokens`, `outputTokens`, `cachedReadTokens`, `cachedWriteTokens`, `latencyMs`
- Per-user cost cap stub: `aiUsageStub.ts` records calls in-memory keyed by sessionId, no enforcement yet
- SSE response infrastructure: `text/event-stream`, heartbeat every 10s, error envelope shape

**Out (explicitly deferred):**
- Tool registration (separate spec: `ai-pattern-a-tool-schema-registry`)
- Read-tool implementations (separate spec: `ai-pattern-a-read-tools-and-context`)
- MST mutations (Wave 2: `ai-pattern-a-canvas-mutation-tools`)
- Real auth (auth-brain v1 dependency, Phase 1 later)
- Real cost cap enforcement (Phase 2 ops concern)
- Client-side assistant panel UI (separate spec)

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `package.json` | edit | Add `@anthropic-ai/sdk` dep |
| `src/lib/ai/anthropicClient.ts` | new | Singleton client + model constants |
| `src/lib/ai/promptCache.ts` | new | Helper to build cache-aware system blocks |
| `src/lib/ai/aiLogger.ts` | new | Structured JSON logger for AI calls |
| `src/lib/ai/aiUsageStub.ts` | new | In-memory usage counter (placeholder) |
| `src/lib/ai/sse.ts` | new | SSE writer with heartbeat + error envelope |
| `src/app/api/ai/edit/route.ts` | new | POST handler, returns SSE stream |
| `.env.example` | edit | Add `ANTHROPIC_API_KEY` placeholder |

## API surface

```ts
// src/lib/ai/anthropicClient.ts
import Anthropic from '@anthropic-ai/sdk';

export const AI_MODELS = {
  HAIKU: 'claude-haiku-4-5',
  SONNET: 'claude-sonnet-4-6',
  OPUS: 'claude-opus-4-7', // reserved for Phase 2 (Pattern B planning pass)
} as const;
export type AiModelKey = keyof typeof AI_MODELS;

export function getAnthropicClient(): Anthropic;

// src/lib/ai/promptCache.ts
export type SystemBlock =
  | { type: 'text'; text: string; cache?: boolean };

// Builds the messages.create system param with cache_control on the last
// block flagged cache=true. Volatile blocks (snapshots) go AFTER the cached
// boundary so the prefix stays stable.
export function buildSystemPrompt(blocks: SystemBlock[]): Anthropic.TextBlockParam[];

// src/lib/ai/sse.ts
export function createSseStream(): {
  stream: ReadableStream<Uint8Array>;
  send: (event: string, data: unknown) => void;
  heartbeat: () => void;
  close: (err?: Error) => void;
};

// src/app/api/ai/edit/route.ts
export async function POST(req: Request): Promise<Response>;
// Body: { prompt: string; sessionId: string; pageId: string; selection?: string[] }
// Response: SSE stream of events:
//   event: token        data: { delta: string }
//   event: tool_use     data: { name: string; input: unknown }   // Wave 2+
//   event: usage        data: { inputTokens, outputTokens, cachedReadTokens, cachedWriteTokens }
//   event: error        data: { message: string; code: string }
//   event: done         data: { turnId: string }
```

## Data shapes

```ts
// Logged per request
type AiCallLog = {
  requestId: string;
  sessionId: string;
  userId: string | 'anonymous';
  model: string;
  promptChars: number;
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  cachedWriteTokens: number;
  latencyMs: number;
  status: 'ok' | 'error' | 'rate_limited' | 'overloaded';
  errorCode?: string;
};

// Env contract
type AiEnv = {
  ANTHROPIC_API_KEY: string;
  AI_DEFAULT_MODEL?: 'HAIKU' | 'SONNET'; // defaults to HAIKU
  AI_DAILY_TOKEN_CAP?: string;            // unenforced in this spec
};
```

## Test plan

- [ ] Unit: `promptCache.test.ts` verifies `cache_control` marker is placed on the last cache=true block and not on volatile blocks
- [ ] Unit: `sse.test.ts` verifies event framing (`event:` + `data:` + double newline), heartbeat emits at 10s
- [ ] Unit: `anthropicClient.test.ts` errors fast on missing `ANTHROPIC_API_KEY`
- [ ] Integration: hit `/api/ai/edit` with a stub prompt against a recorded fixture (or `MSW`-mocked Anthropic), assert SSE events arrive in order: token deltas, usage, done
- [ ] Manual: with a real key in Infisical (`infisical run --env=dev -- pnpm dev`), POST `{ prompt: "say hi" }` from curl, observe streamed tokens

## Definition of done

- [ ] `pnpm tsc --noEmit` clean
- [ ] `pnpm test` green
- [ ] `/api/ai/edit` returns 200 SSE for a valid body, 400 for malformed body, 401 if key missing
- [ ] Structured logs visible in dev console with token counts
- [ ] No regressions in editor (route is additive)
- [ ] Spec status moved to `done` in `STATUS.md`

## Open questions

- **Where does `ANTHROPIC_API_KEY` live in production?** Recommend Infisical project `framer-clone`, env `prod`, surfaced to Coolify via `infisical run`. Confirm with Marlin before deploy.
- **Should the route live under `/api/ai/edit` (verb-specific) or `/api/ai/turn` (generic)?** Verb-specific reads better today but Pattern B will want `/api/ai/scaffold` later. Recommended: `/api/ai/edit` for Pattern A, `/api/ai/scaffold` reserved for Phase 2.
- **Cache TTL: 5min default vs 1h opt-in?** 1h costs 2x to write but pays back after 2 reuses. For a 20+ minute editor session, 1h wins. Default to 1h for the system prefix.
- **Rate limit handling: silent retry vs surface to user?** Recommend surface ("AI is busy, retry in a moment") with a 1-attempt internal retry on 529 overloaded, no retry on 429 (let user re-trigger).

## References

- Plan: `docs/plans/2026-05-05-ai-agent-layer-research.md` sections 4d, 7a, 7b, 7d, 7e
- Memory: `memory/project_strategic_thesis_bubble_killer.md`
- Code touchpoints: `src/app/api/` (Next.js route conventions), `src/stores/RootStore.ts` (server has no MST access; reads come from client snapshots)
- External: https://platform.claude.com/docs/en/build-with-claude/prompt-caching, https://github.com/anthropics/anthropic-sdk-typescript
- Skill: `~/.claude/skills/claude-api/SKILL.md` (prompt caching pattern)
