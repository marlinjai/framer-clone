// @vitest-environment node
//
// Headless tests for POST /api/ai/review-page. The Anthropic client is a
// scripted mock (no network, the real model is never called); the auth-brain
// client is mocked while resolveActiveScope stays real, like the generate-page
// route tests.

import { describe, it, expect, beforeEach, vi } from 'vitest';

type Turn =
  | { content: unknown[]; stop_reason: string; stop_details?: unknown; inputJson?: string[] }
  | { throws: unknown };

const anthropicState = vi.hoisted(() => ({
  turns: [] as Turn[],
  calls: [] as Array<{ params: Record<string, unknown>; options: unknown }>,
  missingKey: false,
}));

vi.mock('@/lib/ai/anthropicClient', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/ai/anthropicClient')>();
  return {
    ...actual,
    getAnthropicClient: () => {
      if (anthropicState.missingKey) throw new actual.MissingAnthropicKeyError();
      const stream = (params: Record<string, unknown>, options: unknown) => {
        anthropicState.calls.push({ params, options });
        const turn = anthropicState.turns[anthropicState.calls.length - 1] ?? { content: [], stop_reason: 'end_turn' };
        const handlers: Record<string, (chunk: string, snap: unknown) => void> = {};
        return {
          on(event: string, cb: (chunk: string, snap: unknown) => void) {
            handlers[event] = cb;
            return this;
          },
          get currentMessage() {
            return undefined;
          },
          finalMessage: async () => {
            if ('throws' in turn) throw turn.throws;
            for (const chunk of turn.inputJson ?? []) handlers.inputJson?.(chunk, {});
            return {
              content: turn.content,
              stop_reason: turn.stop_reason,
              stop_details: turn.stop_details ?? null,
              usage: { input_tokens: 4000, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 1200 },
            };
          },
        };
      };
      return { beta: { messages: { stream } } };
    },
  };
});

const mockVerifySession = vi.fn();
const mockCan = vi.fn();
vi.mock('@/lib/auth-brain', () => ({
  authBrainClient: {
    verifySession: (...args: unknown[]) => mockVerifySession(...args),
    can: (...args: unknown[]) => mockCan(...args),
    verifyApiKey: vi.fn(),
    getCurrentUser: vi.fn(),
  },
}));

function sessionA() {
  return {
    user: { id: 'user-a' },
    session: {},
    tenants: [{ id: 'tenant-a', app_grants: ['sites'], group_id: 'tg_a' }],
    workspaces: [{ id: 'ws_a', tenant_id: 'tenant-a' }],
    active_tenant: { id: 'tenant-a' },
    active_workspace: { id: 'ws_a' },
  };
}

import { POST } from '../review-page/route';
import { __resetReviewRateLimiterForTests, REVIEW_RATE } from '@/lib/ai/review/rateLimit';
import { parseSseFrames } from '@/lib/ai/parseSse';
import { REVIEW_LIMITS } from '@/lib/ai/review/protocol';

function makeRequest(body: unknown, opts: { cookie?: string | null; raw?: string } = {}): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const cookie = opts.cookie === undefined ? 'lumitra_session=good' : opts.cookie;
  if (cookie) headers.cookie = cookie;
  return new Request('http://localhost/api/ai/review-page', { method: 'POST', headers, body: opts.raw ?? JSON.stringify(body) });
}

const PHOTO = 'https://images.unsplash.com/photo-1?w=1600';
const TREE = {
  id: 'root',
  type: 'div',
  props: {},
  children: [
    {
      id: 'hero',
      type: 'section',
      props: { style: { backgroundImage: `url("${PHOTO}")` } },
      children: [{ id: 'h1', type: 'h1', props: { children: 'Ride further', style: { fontSize: { desktop: '96px' } } }, children: [] }],
    },
  ],
};

const IMAGE = { breakpoint: 'desktop', mediaType: 'image/jpeg', data: 'A'.repeat(400), width: 1000, height: 1800, cssWidth: 1280, truncated: false };

function baseBody(over: Record<string, unknown> = {}) {
  return {
    breakpoints: [
      { label: 'Desktop', minWidth: 1280 },
      { label: 'Tablet', minWidth: 768 },
      { label: 'Phone', minWidth: 0 },
    ],
    tree: TREE,
    findings: [
      {
        kind: 'text-clipped',
        severity: 'error',
        nodeId: 'h1',
        breakpoint: 'phone',
        measured: { contentHeight: 200, boxHeight: 120 },
        message: 'Text "Ride further" is cut off.',
      },
    ],
    images: [IMAGE],
    brief: 'A bike repair shop',
    ...over,
  };
}

function toolTurn(input: unknown, inputJson?: string[]): Turn {
  return { content: [{ type: 'tool_use', id: 'tu_1', name: 'apply_fixes', input }], stop_reason: 'tool_use', inputJson };
}

async function events(res: Response) {
  const text = await res.text();
  return parseSseFrames(text).frames.map((f) => ({ event: f.event, data: JSON.parse(f.data) as Record<string, unknown> }));
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetReviewRateLimiterForTests();
  mockVerifySession.mockResolvedValue(sessionA());
  mockCan.mockResolvedValue(true);
  anthropicState.turns = [toolTurn({ summary: 'ok', ops: [] })];
  anthropicState.calls = [];
  anthropicState.missingKey = false;
});

describe('POST /api/ai/review-page guards', () => {
  it('401 without a session, and never calls the model', async () => {
    const res = await POST(makeRequest(baseBody(), { cookie: null }));
    expect(res.status).toBe(401);
    expect(anthropicState.calls).toHaveLength(0);
  });

  it('403 when the user may not edit the workspace', async () => {
    mockCan.mockResolvedValue(false);
    const res = await POST(makeRequest(baseBody()));
    expect(res.status).toBe(403);
    expect(anthropicState.calls).toHaveLength(0);
  });

  it('401 missing_anthropic_key', async () => {
    anthropicState.missingKey = true;
    const res = await POST(makeRequest(baseBody()));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('missing_anthropic_key');
  });

  it('400 on bad JSON, a broken tree, too many images, non-base64 data, an unknown model', async () => {
    expect((await POST(makeRequest(null, { raw: '{' }))).status).toBe(400);
    const broken = await POST(makeRequest(baseBody({ tree: { id: 'root', type: 'div', props: {}, children: [{ id: 'root', type: 'p', props: {}, children: [] }] } })));
    expect(broken.status).toBe(400);
    expect((await broken.json()).error.message).toMatch(/duplicate node id/);
    expect((await POST(makeRequest(baseBody({ images: [IMAGE, IMAGE, IMAGE] })))).status).toBe(400);
    expect((await POST(makeRequest(baseBody({ images: [{ ...IMAGE, data: 'not base64!'.repeat(20) }] })))).status).toBe(400);
    expect((await POST(makeRequest(baseBody({ model: 'HAIKU' })))).status).toBe(400);
    expect(anthropicState.calls).toHaveLength(0);
  });

  it('400 tree_too_large over the character budget', async () => {
    const big = { ...TREE, props: { children: 'x'.repeat(REVIEW_LIMITS.maxTreeChars) } };
    const res = await POST(makeRequest(baseBody({ tree: big })));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('tree_too_large');
  });

  it('429 after the window limit', async () => {
    for (let i = 0; i < REVIEW_RATE.maxPerWindow; i++) {
      anthropicState.turns[i] = toolTurn({ summary: 'ok', ops: [] });
      await (await POST(makeRequest(baseBody()))).text();
    }
    const res = await POST(makeRequest(baseBody()));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
  });
});

describe('POST /api/ai/review-page review', () => {
  it('sends images, findings, brief and tree to Sonnet with the cached system prompt and the tool', async () => {
    const res = await POST(makeRequest(baseBody()));
    expect(res.status).toBe(200);
    await events(res);
    const params = anthropicState.calls[0].params as Record<string, unknown> & {
      messages: Array<{ content: Array<{ type: string; text?: string; source?: { data: string } }> }>;
      system: Array<{ text: string; cache_control?: unknown }>;
      tools: Array<{ name: string }>;
    };
    expect(params.model).toBe('claude-sonnet-5-5');
    expect(params.output_config).toEqual({ effort: 'medium' });
    expect(params.tools.map((t) => t.name)).toEqual(['apply_fixes']);
    expect(params.system[0].cache_control).toBeDefined();
    expect(params.system[1].text).toContain('"desktop": Desktop');
    const content = params.messages[0].content;
    expect(content.filter((b) => b.type === 'image')).toHaveLength(1);
    const text = content.map((b) => b.text ?? '').join('\n');
    expect(text).toContain('[error] text-clipped on "phone", node h1');
    expect(text).toContain('<brief>\nA bike repair shop\n</brief>');
    expect(text).toContain('"id":"hero"');
  });

  it('Opus when asked', async () => {
    await (await POST(makeRequest(baseBody({ model: 'OPUS' })))).text();
    expect(anthropicState.calls[0].params.model).toBe('claude-opus-5-5');
  });

  it('streams validated ops, reports the refused ones, then usage', async () => {
    const ops = [
      { op: 'update_style', nodeId: 'h1', breakpoint: 'phone', property: 'fontSize', value: 'clamp(2.5rem, 9vw, 3.5rem)', reason: 'Headline clipped on phone' },
      { op: 'update_style', nodeId: 'hero', breakpoint: null, property: 'backgroundImage', value: `linear-gradient(rgba(0, 0, 0, 0.55), rgba(0, 0, 0, 0.55)), url("${PHOTO}")`, reason: 'Scrim' },
      { op: 'update_style', nodeId: 'ghost', breakpoint: null, property: 'color', value: 'red', reason: 'x' },
      { op: 'update_style', nodeId: 'h1', breakpoint: null, property: 'onClick', value: 'x', reason: 'x' },
      { op: 'update_text', nodeId: 'h1', text: 'Ride — further', reason: 'x' },
    ];
    anthropicState.turns = [toolTurn({ summary: 'Fixed the hero.', ops }, [JSON.stringify({ summary: 'Fixed the hero.', ops })])];
    const evs = await events(await POST(makeRequest(baseBody())));
    expect(evs.map((e) => e.event)).toEqual(['review:progress', 'review:progress', 'review:result', 'usage']);
    const result = evs[2].data as { ops: unknown[]; rejected: Array<{ index: number }>; summary: string; model: string };
    expect(result.summary).toBe('Fixed the hero.');
    expect(result.model).toBe('claude-sonnet-5-5');
    expect(result.ops).toHaveLength(2);
    expect(result.rejected.map((r) => r.index)).toEqual([2, 3, 4]);
    expect(evs[3].data).toEqual({ inputTokens: 4000, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 1200 });
  });

  it('an empty ops list is a valid "nothing to fix"', async () => {
    const evs = await events(await POST(makeRequest(baseBody())));
    expect(evs.find((e) => e.event === 'review:result')?.data).toMatchObject({ ops: [], rejected: [] });
  });

  it('review:error when the model makes no tool call, refuses, is cut off or writes malformed JSON', async () => {
    const cases: Array<[Turn, string]> = [
      [{ content: [{ type: 'text', text: 'Looks fine' }], stop_reason: 'end_turn' }, 'invalid_output'],
      [{ content: [], stop_reason: 'refusal', stop_details: { category: 'cyber' } }, 'refused'],
      [{ ...toolTurn({ summary: 'x', ops: [] }), stop_reason: 'max_tokens' }, 'invalid_output'],
      [toolTurn({ summary: 'x', ops: [] }, ['{"summary": "x", "ops": [']), 'invalid_output'],
    ];
    for (const [turn, code] of cases) {
      __resetReviewRateLimiterForTests();
      anthropicState.turns = [turn];
      anthropicState.calls = [];
      const evs = await events(await POST(makeRequest(baseBody())));
      expect(evs.find((e) => e.event === 'review:error')?.data.code).toBe(code);
      expect(evs.at(-1)?.event).toBe('usage');
    }
  });

  it('maps provider failures to actionable codes and releases the slot', async () => {
    anthropicState.turns = [{ throws: Object.assign(new Error('overloaded'), { status: 529 }) }, toolTurn({ summary: 'ok', ops: [] })];
    const first = await events(await POST(makeRequest(baseBody())));
    expect(first.find((e) => e.event === 'review:error')?.data.code).toBe('overloaded');
    // The in-flight slot was released: the next review runs.
    const second = await POST(makeRequest(baseBody()));
    expect(second.status).toBe(200);
    expect((await events(second)).some((e) => e.event === 'review:result')).toBe(true);
  });
});
