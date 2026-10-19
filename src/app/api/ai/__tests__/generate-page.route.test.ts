// @vitest-environment node
//
// Headless tests for POST /api/ai/generate-page. The Anthropic client is a
// scripted mock (no network); the auth-brain client (verifySession + can) is
// mocked while resolveActiveScope stays REAL, so the session -> scope ->
// permission contract runs for real, exactly like the CMS agent route tests.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// --- Scriptable Anthropic client -------------------------------------------
type Turn =
  | { content: unknown[]; stop_reason: string; inputJson?: string[]; wait?: Promise<void> }
  | { throws: unknown };

const anthropicState = vi.hoisted(() => ({
  turns: [] as Turn[],
  calls: [] as Array<{ params: Record<string, unknown>; options: unknown }>,
  missingKey: false,
}));

vi.mock('@/lib/ai/anthropicClient', () => {
  class MissingAnthropicKeyError extends Error {
    readonly code = 'missing_anthropic_key';
  }
  return {
    AI_MODELS: { HAIKU: 'claude-haiku-4-5', SONNET: 'claude-sonnet-4-6', OPUS: 'claude-opus-4-8' },
    MissingAnthropicKeyError,
    resolveModelId: (key: 'HAIKU' | 'SONNET' | 'OPUS') =>
      ({ HAIKU: 'claude-haiku-4-5', SONNET: 'claude-sonnet-4-6', OPUS: 'claude-opus-4-8' })[key],
    getAnthropicClient: () => {
      if (anthropicState.missingKey) throw new MissingAnthropicKeyError('ANTHROPIC_API_KEY is not set.');
      return {
        messages: {
          stream: (params: Record<string, unknown>, options: unknown) => {
            // Snapshot the messages: the route mutates the array between attempts.
            anthropicState.calls.push({
              params: { ...params, messages: structuredClone(params.messages) },
              options,
            });
            const turn = anthropicState.turns[anthropicState.calls.length - 1] ?? {
              content: [],
              stop_reason: 'end_turn',
            };
            const handlers: Record<string, (chunk: string, snap: unknown) => void> = {};
            return {
              on(event: string, cb: (chunk: string, snap: unknown) => void) {
                handlers[event] = cb;
                return this;
              },
              finalMessage: async () => {
                if ('throws' in turn) throw turn.throws;
                if (turn.wait) await turn.wait;
                for (const chunk of turn.inputJson ?? []) handlers.inputJson?.(chunk, {});
                return {
                  content: turn.content,
                  stop_reason: turn.stop_reason,
                  usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 },
                };
              },
            };
          },
        },
      };
    },
  };
});

// --- auth-brain mock (verifySession + can); resolveActiveScope stays real -----
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

import { POST } from '../generate-page/route';
import { __resetPageGenRateLimiterForTests, PAGE_GEN_RATE } from '@/lib/ai/pageGen/rateLimit';
import { parseSseFrames } from '@/lib/ai/parseSse';
import { GENERATION_LIMITS } from '@/lib/ai/pageGen/schema';

// --- Helpers ---------------------------------------------------------------
const authCookie = 'lumitra_session=good';

function makeRequest(body: unknown, opts: { cookie?: string | null; raw?: string } = {}): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const cookie = opts.cookie === undefined ? authCookie : opts.cookie;
  if (cookie) headers.cookie = cookie;
  return new Request('http://localhost/api/ai/generate-page', {
    method: 'POST',
    headers,
    body: opts.raw ?? JSON.stringify(body),
  });
}

const BREAKPOINTS = [
  { label: 'Desktop', minWidth: 1280 },
  { label: 'Tablet', minWidth: 768 },
  { label: 'Mobile', minWidth: 320 },
];

function baseBody(overrides: Record<string, unknown> = {}) {
  return {
    brief: 'A landing page for a bakery',
    breakpoints: BREAKPOINTS,
    target: { kind: 'newPage' },
    ...overrides,
  };
}

async function events(res: Response): Promise<Array<{ event: string; data: Record<string, unknown> }>> {
  const text = await res.text();
  return parseSseFrames(text).frames.map((f) => ({ event: f.event, data: JSON.parse(f.data) }));
}

function toolTurn(input: unknown, extra: Partial<{ stop_reason: string; inputJson: string[] }> = {}): Turn {
  return {
    content: [{ type: 'tool_use', id: 'tu_1', name: 'emit_page', input }],
    stop_reason: extra.stop_reason ?? 'tool_use',
    inputJson: extra.inputJson,
  };
}

const VALID_PAGE = {
  title: 'Bakery',
  description: 'Fresh bread daily',
  nodes: [
    {
      type: 'section',
      label: 'Hero',
      props: { style: { padding: { base: '64px', mobile: '24px' } } },
      children: [{ type: 'h1', props: { children: 'Fresh bread' } }],
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  __resetPageGenRateLimiterForTests();
  mockVerifySession.mockResolvedValue(sessionA());
  mockCan.mockResolvedValue(true);
  anthropicState.turns = [toolTurn(VALID_PAGE)];
  anthropicState.calls = [];
  anthropicState.missingKey = false;
});

// --- Guard codes -------------------------------------------------------------
describe('POST /api/ai/generate-page guards', () => {
  it('401 without a session cookie, and never calls the model', async () => {
    const res = await POST(makeRequest(baseBody(), { cookie: null }));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('unauthorized');
    expect(anthropicState.calls).toHaveLength(0);
  });

  it('401 when the session does not verify', async () => {
    mockVerifySession.mockResolvedValue(null);
    const res = await POST(makeRequest(baseBody()));
    expect(res.status).toBe(401);
  });

  it('403 forbidden when the user may not edit the workspace', async () => {
    mockCan.mockResolvedValue(false);
    const res = await POST(makeRequest(baseBody()));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('forbidden');
    expect(mockCan).toHaveBeenCalledWith('user-a', 'workspace.admin', expect.objectContaining({ id: 'ws_a' }));
    expect(anthropicState.calls).toHaveLength(0);
  });

  it('403 sites_not_enabled when no company of the session has the Sites grant', async () => {
    mockVerifySession.mockResolvedValue({
      ...sessionA(),
      tenants: [{ id: 'tenant-a', app_grants: [], group_id: 'tg_a' }],
    });
    const res = await POST(makeRequest(baseBody()));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('sites_not_enabled');
  });

  it('503 auth_unavailable (never 401) when auth-brain cannot answer', async () => {
    const { AuthBrainNetworkError } = await import('@marlinjai/auth-brain-sdk');
    mockVerifySession.mockRejectedValue(new AuthBrainNetworkError(new Error('ECONNREFUSED')));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await POST(makeRequest(baseBody()));
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe('auth_unavailable');
  });

  it('503 authz_unavailable (never 403) when OpenFGA cannot answer', async () => {
    const { AuthBrainError } = await import('@marlinjai/auth-brain-sdk');
    mockCan.mockRejectedValue(new AuthBrainError('OpenFGA check failed: 503', 503));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await POST(makeRequest(baseBody()));
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe('authz_unavailable');
    expect(anthropicState.calls).toHaveLength(0);
  });

  it('401 missing_anthropic_key when the server has no key', async () => {
    anthropicState.missingKey = true;
    const res = await POST(makeRequest(baseBody()));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('missing_anthropic_key');
  });
});

describe('POST /api/ai/generate-page validation and budget', () => {
  it('400 bad_json on an unparseable body', async () => {
    const res = await POST(makeRequest(null, { raw: '{nope' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('bad_json');
  });

  it('400 bad_body on an empty brief, a brief over budget, or no breakpoints', async () => {
    for (const body of [
      baseBody({ brief: '   ' }),
      baseBody({ brief: 'x'.repeat(GENERATION_LIMITS.maxBriefChars + 1) }),
      baseBody({ breakpoints: [] }),
      baseBody({ model: 'OPUS' }),
    ]) {
      const res = await POST(makeRequest(body));
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe('bad_body');
    }
  });

  it('400 when replace has no context, context_too_large when it is huge', async () => {
    let res = await POST(makeRequest(baseBody({ target: { kind: 'replace' } })));
    expect(res.status).toBe(400);
    res = await POST(makeRequest(baseBody({ target: { kind: 'insert', context: { blob: 'x'.repeat(70_000) } } })));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('context_too_large');
  });

  it('429 when the window budget is spent, with retry-after', async () => {
    for (let i = 0; i < PAGE_GEN_RATE.maxPerWindow; i++) {
      anthropicState.turns = [toolTurn(VALID_PAGE)];
      anthropicState.calls = [];
      const ok = await POST(makeRequest(baseBody()));
      expect(ok.status).toBe(200);
      await ok.text(); // drain so the in-flight slot is released
    }
    const res = await POST(makeRequest(baseBody()));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toMatch(/^\d+$/);
    expect((await res.json()).error.code).toBe('rate_limited');
  });

  it('429 while the same user already has a generation running, free again after it ends', async () => {
    let release!: () => void;
    const wait = new Promise<void>((r) => (release = r));
    anthropicState.turns = [{ ...(toolTurn(VALID_PAGE) as object), wait } as Turn, toolTurn(VALID_PAGE)];
    const first = await POST(makeRequest(baseBody()));
    expect(first.status).toBe(200);

    const second = await POST(makeRequest(baseBody()));
    expect(second.status).toBe(429);
    expect((await second.json()).error.retryAfterSec).toBeGreaterThan(0);

    release();
    await first.text();
    const third = await POST(makeRequest(baseBody()));
    expect(third.status).toBe(200);
    await third.text();
  });
});

describe('POST /api/ai/generate-page generation', () => {
  it('streams progress then a validated result, then usage', async () => {
    anthropicState.turns = [toolTurn(VALID_PAGE, { inputJson: ['x'.repeat(1600), 'y'.repeat(10)] })];
    const res = await POST(makeRequest(baseBody({ projectName: 'Crumb', existingPageTitles: ['Home'] })));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const evs = await events(res);
    const names = evs.map((e) => e.event);
    expect(names[0]).toBe('gen:progress');
    expect(names).toContain('gen:result');
    expect(names.at(-1)).toBe('usage');
    expect(evs.some((e) => e.event === 'gen:progress' && (e.data.receivedChars as number) >= 1500)).toBe(true);

    const result = evs.find((e) => e.event === 'gen:result')!.data as {
      title: string;
      nodes: Array<{ id: string; props: { style: Record<string, unknown> }; children: Array<{ parentId: string }> }>;
      model: string;
    };
    expect(result.title).toBe('Bakery');
    expect(result.model).toBe('claude-sonnet-4-6');
    expect(result.nodes[0].props.style.padding).toEqual({ base: '64px', mobile: '24px', desktop: '64px' });
    expect(result.nodes[0].children[0].parentId).toBe(result.nodes[0].id);

    // The request the model saw: cached schema prefix, per-request context after it.
    const { params, options } = anthropicState.calls[0];
    const system = params.system as Array<{ text: string; cache_control?: unknown }>;
    expect(system[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(system[0].text).toContain('### preset "card"');
    expect(system[1].cache_control).toBeUndefined();
    expect(system[1].text).toContain('"desktop": Desktop, from 1280px');
    expect(system[1].text).toContain('Existing pages');
    expect(params.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true });
    expect(params.max_tokens).toBe(24_000);
    expect((options as { signal: unknown }).signal).toBeDefined();
    expect(evs.at(-1)!.data).toMatchObject({ inputTokens: 100, outputTokens: 50, attempts: 1 });
  });

  it('honours the HAIKU model choice', async () => {
    const res = await POST(makeRequest(baseBody({ model: 'HAIKU' })));
    await res.text();
    expect(anthropicState.calls[0].params.model).toBe('claude-haiku-4-5');
  });

  it('sends the selected component as context for replace', async () => {
    const res = await POST(
      makeRequest(baseBody({ target: { kind: 'replace', context: { id: 'hero-1', type: 'section', label: 'Old hero' } } })),
    );
    await res.text();
    const system = anthropicState.calls[0].params.system as Array<{ text: string }>;
    expect(system[1].text).toContain('REPLACE');
    expect(system[1].text).toContain('Old hero');
  });

  it('repairs once: invalid first output, valid second, the model sees the problems', async () => {
    anthropicState.turns = [toolTurn({ nodes: [] }), toolTurn(VALID_PAGE)];
    const evs = await events(await POST(makeRequest(baseBody())));
    expect(evs.some((e) => e.event === 'gen:progress' && e.data.phase === 'repairing')).toBe(true);
    expect(evs.some((e) => e.event === 'gen:result')).toBe(true);
    const second = anthropicState.calls[1].params.messages as Array<{ role: string; content: unknown }>;
    const last = second.at(-1)!;
    expect(last.role).toBe('user');
    expect(JSON.stringify(last.content)).toContain('tool_result');
    expect(JSON.stringify(last.content)).toContain('is empty');
    expect(evs.at(-1)!.data).toMatchObject({ attempts: 2, inputTokens: 200 });
  });

  it('rejects invalid output after the repair round: gen:error invalid_output, never a result', async () => {
    anthropicState.turns = [toolTurn({ nodes: ['<div/>'] }), toolTurn({ root: {} })];
    const evs = await events(await POST(makeRequest(baseBody())));
    expect(evs.some((e) => e.event === 'gen:result')).toBe(false);
    const err = evs.find((e) => e.event === 'gen:error')!.data;
    expect(err.code).toBe('invalid_output');
    expect((err.details as string[]).join(' ')).toMatch(/nodes/);
    expect(anthropicState.calls).toHaveLength(2);
  });

  it('treats a missing tool call and a truncated output as repairable problems', async () => {
    anthropicState.turns = [
      { content: [{ type: 'text', text: 'Here is your page!' }], stop_reason: 'end_turn' },
      toolTurn({ nodes: [{ type: 'div' }] }, { stop_reason: 'max_tokens' }),
    ];
    const evs = await events(await POST(makeRequest(baseBody())));
    const err = evs.find((e) => e.event === 'gen:error')!.data;
    expect(err.code).toBe('invalid_output');
    expect((err.details as string[])[0]).toMatch(/cut off/);
    const repairTurn = (anthropicState.calls[1].params.messages as Array<{ content: unknown }>).at(-1)!;
    expect(String(repairTurn.content)).toContain('no emit_page call was made');
  });

  it('surfaces a refusal without a repair round', async () => {
    anthropicState.turns = [{ content: [], stop_reason: 'refusal' }];
    const evs = await events(await POST(makeRequest(baseBody())));
    expect(evs.find((e) => e.event === 'gen:error')!.data.code).toBe('refused');
    expect(anthropicState.calls).toHaveLength(1);
  });

  it.each([
    [{ status: 429 }, 'rate_limited'],
    [{ status: 529 }, 'overloaded'],
    [{ status: 401 }, 'provider_auth'],
    [{ status: 500 }, 'provider_unavailable'],
    [new Error('fetch failed'), 'provider_unavailable'],
    [{ name: 'APIUserAbortError' }, 'aborted'],
  ])('maps a provider failure %j to gen:error %s', async (thrown, code) => {
    anthropicState.turns = [{ throws: thrown }];
    const evs = await events(await POST(makeRequest(baseBody())));
    expect(evs.find((e) => e.event === 'gen:error')!.data.code).toBe(code);
    expect(evs.at(-1)!.event).toBe('usage');
  });

  it('releases the in-flight slot after a failure, so the next request runs', async () => {
    anthropicState.turns = [{ throws: { status: 500 } }];
    await (await POST(makeRequest(baseBody()))).text();
    anthropicState.turns = [toolTurn(VALID_PAGE)];
    anthropicState.calls = [];
    const res = await POST(makeRequest(baseBody()));
    expect(res.status).toBe(200);
    await res.text();
  });
});
