// @vitest-environment node
//
// Headless tests for POST /api/ai/page-ideas and POST /api/ai/enhance-brief.
// The Anthropic client is a scripted fake (no network); the auth-brain client
// (verifySession + can) is mocked while resolveActiveScope stays REAL, as in
// the generate-page route tests.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const anthropicState = vi.hoisted(() => ({
  missingKey: false,
  createCalls: [] as Array<Record<string, unknown>>,
  createResult: null as unknown,
  createError: null as unknown,
  streamCalls: [] as Array<{ params: Record<string, unknown>; signal?: AbortSignal }>,
  deltas: [] as string[],
  streamError: null as unknown,
  /** Resolves when the test lets the stream finish. */
  hold: null as Promise<void> | null,
}));

vi.mock('@/lib/ai/anthropicClient', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/ai/anthropicClient')>();
  return {
    ...actual,
    getAnthropicClient: () => {
      if (anthropicState.missingKey) throw new actual.MissingAnthropicKeyError();
      const create = async (params: Record<string, unknown>) => {
        anthropicState.createCalls.push(params);
        if (anthropicState.createError) throw anthropicState.createError;
        return anthropicState.createResult;
      };
      const stream = (params: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
        anthropicState.streamCalls.push({ params, signal: options?.signal });
        const handlers: Record<string, (d: string) => void> = {};
        return {
          on(event: string, cb: (d: string) => void) {
            handlers[event] = cb;
            return this;
          },
          currentMessage: { usage: { input_tokens: 50, output_tokens: 3 } },
          finalMessage: async () => {
            for (const d of anthropicState.deltas) handlers.text?.(d);
            if (anthropicState.hold) {
              const signal = options?.signal;
              await Promise.race([
                anthropicState.hold,
                new Promise((_, reject) => {
                  const abort = () => reject(Object.assign(new Error('aborted'), { name: 'APIUserAbortError' }));
                  if (signal?.aborted) abort();
                  signal?.addEventListener('abort', abort);
                }),
              ]);
            }
            if (anthropicState.streamError) throw anthropicState.streamError;
            return {
              content: [{ type: 'text', text: anthropicState.deltas.join('') }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 100, output_tokens: 40 },
            };
          },
        };
      };
      return { beta: { messages: { create, stream } } };
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

import { POST as IDEAS } from '../page-ideas/route';
import { POST as ENHANCE } from '../enhance-brief/route';
import { __resetBriefRateLimitersForTests, BRIEF_RATE } from '@/lib/ai/brief/rateLimit';
import { IDEAS_TOOL_NAME } from '@/lib/ai/brief/ideas';
import { parseSseFrames } from '@/lib/ai/parseSse';

const authCookie = 'lumitra_session=good';

function makeRequest(path: string, body: unknown, opts: { cookie?: string | null; raw?: string } = {}): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const cookie = opts.cookie === undefined ? authCookie : opts.cookie;
  if (cookie) headers.cookie = cookie;
  return new Request(`http://localhost${path}`, { method: 'POST', headers, body: opts.raw ?? JSON.stringify(body) });
}

const ideasReq = (body: unknown = { targetKind: 'newPage', projectName: 'Crumb' }, opts = {}) =>
  makeRequest('/api/ai/page-ideas', body, opts);
const enhanceReq = (body: unknown = { targetKind: 'newPage', brief: 'a bakery page' }, opts = {}) =>
  makeRequest('/api/ai/enhance-brief', body, opts);

async function events(res: Response) {
  const text = await res.text();
  return parseSseFrames(text).frames.map((f) => ({ event: f.event, data: JSON.parse(f.data) as Record<string, unknown> }));
}

const SIX = Array.from({ length: 6 }, (_, i) => ({ title: `Idea ${i + 1}`, brief: `Brief ${i + 1}.` }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  __resetBriefRateLimitersForTests();
  mockVerifySession.mockResolvedValue(sessionA());
  mockCan.mockResolvedValue(true);
  Object.assign(anthropicState, {
    missingKey: false,
    createCalls: [],
    createResult: {
      content: [{ type: 'tool_use', id: 'tu', name: IDEAS_TOOL_NAME, input: { ideas: SIX } }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 100, output_tokens: 60 },
    },
    createError: null,
    streamCalls: [],
    deltas: ['A landing page', ' for a bakery.'],
    streamError: null,
    hold: null,
  });
});

describe.each([
  ['page-ideas', ideasReq],
  ['enhance-brief', enhanceReq],
] as const)('POST /api/ai/%s guards', (name, req) => {
  const handler = name === 'page-ideas' ? IDEAS : ENHANCE;
  const modelCalls = () => anthropicState.createCalls.length + anthropicState.streamCalls.length;

  it('401 without a session cookie, and never calls the model', async () => {
    const res = await handler(req(undefined, { cookie: null }));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('unauthorized');
    expect(modelCalls()).toBe(0);
  });

  it('403 forbidden when the user may not edit the workspace', async () => {
    mockCan.mockResolvedValue(false);
    const res = await handler(req());
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('forbidden');
    expect(mockCan).toHaveBeenCalledWith('user-a', 'workspace.admin', expect.objectContaining({ id: 'ws_a' }));
    expect(modelCalls()).toBe(0);
  });

  it('403 sites_not_enabled without the Sites grant', async () => {
    mockVerifySession.mockResolvedValue({ ...sessionA(), tenants: [{ id: 'tenant-a', app_grants: [], group_id: 'tg_a' }] });
    const res = await handler(req());
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('sites_not_enabled');
  });

  it('503 auth_unavailable when auth-brain cannot answer', async () => {
    const { AuthBrainNetworkError } = await import('@marlinjai/auth-brain-sdk');
    mockVerifySession.mockRejectedValue(new AuthBrainNetworkError(new Error('ECONNREFUSED')));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await handler(req());
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe('auth_unavailable');
  });

  it('401 missing_anthropic_key when the server has no key', async () => {
    anthropicState.missingKey = true;
    const res = await handler(req());
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('missing_anthropic_key');
  });

  it('400 on bad JSON, unknown fields and an oversized context', async () => {
    let res = await handler(req(undefined, { raw: '{nope' }));
    expect((await res.json()).error.code).toBe('bad_json');
    const base = name === 'page-ideas' ? { targetKind: 'newPage' } : { targetKind: 'newPage', brief: 'x' };
    res = await handler(req({ ...base, model: 'OPUS' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('bad_body');
    res = await handler(req({ ...base, targetKind: 'replace', context: { text: 'x'.repeat(20_000) } }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('context_too_large');
    expect(modelCalls()).toBe(0);
  });

  it(`429 with retry-after after ${BRIEF_RATE.maxPerWindow} calls in the window`, async () => {
    for (let i = 0; i < BRIEF_RATE.maxPerWindow; i++) {
      const res = await handler(req());
      expect(res.status).toBe(200);
      await res.text(); // drain (enhance releases its slot when the stream ends)
    }
    const res = await handler(req());
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    const body = await res.json();
    expect(body.error).toMatchObject({ code: 'rate_limited', retryAfterSec: expect.any(Number) });
    expect(body.error.message).toMatch(/Try again in \d+ seconds/);
  });
});

describe('POST /api/ai/page-ideas output', () => {
  it('returns six ideas from one Haiku call, and logs it', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const res = await IDEAS(ideasReq({ targetKind: 'newPage', projectName: 'Crumb', existingPageTitles: ['Home'] }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ideas: SIX });
    expect(anthropicState.createCalls).toHaveLength(1);
    expect(anthropicState.createCalls[0].model).toBe('claude-haiku-5-5');
    const line = log.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith('[ai]'));
    expect(JSON.parse(line!.slice(5))).toMatchObject({ sessionId: 'page-ideas:ws_a', userId: 'user-a', status: 'ok', outputTokens: 60 });
  });

  it('unusable output is 502 invalid_output, a provider outage 503', async () => {
    anthropicState.createResult = { content: [], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
    let res = await IDEAS(ideasReq());
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe('invalid_output');
    anthropicState.createError = Object.assign(new Error('down'), { status: 529 });
    res = await IDEAS(ideasReq());
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe('overloaded');
  });

  it('overlapping idea calls (a quick target switch) are both answered: no in-flight rule for ideas', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const result = anthropicState.createResult;
    anthropicState.createResult = gate.then(() => result);
    const first = IDEAS(ideasReq());
    const second = IDEAS(ideasReq({ targetKind: 'insert' }));
    release();
    const [a, b] = await Promise.all([first, second]);
    expect([a.status, b.status]).toEqual([200, 200]);
  });

  it('a provider rate limit is a 429 with retry-after', async () => {
    anthropicState.createError = Object.assign(new Error('slow'), { status: 429 });
    const res = await IDEAS(ideasReq());
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
  });
});

describe('POST /api/ai/enhance-brief stream', () => {
  it('streams deltas, then done with the full text, then usage', async () => {
    const res = await ENHANCE(enhanceReq());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const ev = await events(res);
    expect(ev.map((e) => e.event)).toEqual(['enhance:delta', 'enhance:delta', 'enhance:done', 'usage']);
    expect(ev[2].data).toEqual({ text: 'A landing page for a bakery.' });
    expect(anthropicState.streamCalls[0].params.model).toBe('claude-haiku-5-5');
  });

  it('a stream cut off midway ends in enhance:error after the partial deltas, never a bare close', async () => {
    anthropicState.deltas = ['A landing'];
    anthropicState.streamError = Object.assign(new Error('reset'), { status: 500 });
    const ev = await events(await ENHANCE(enhanceReq()));
    expect(ev.map((e) => e.event)).toEqual(['enhance:delta', 'enhance:error', 'usage']);
    expect(ev[1].data).toMatchObject({ code: 'provider_unavailable' });
    // The slot was released: the next call is allowed.
    anthropicState.streamError = null;
    expect((await ENHANCE(enhanceReq())).status).toBe(200);
  });

  it('a second Enhance while one runs is 429; the client going away stops the model call and frees the slot', async () => {
    let finish!: () => void;
    anthropicState.hold = new Promise<void>((r) => (finish = r));
    const first = await ENHANCE(enhanceReq());
    const busy = await ENHANCE(enhanceReq());
    expect(busy.status).toBe(429);
    expect((await busy.json()).error.message).toMatch(/still running/);

    // The reader cancels (Stop in the dialog closes the connection).
    await first.body!.cancel();
    await vi.waitFor(() => expect(anthropicState.streamCalls[0].signal?.aborted).toBe(true));
    finish();
    anthropicState.hold = null;
    await vi.waitFor(async () => {
      const again = await ENHANCE(enhanceReq());
      expect(again.status).toBe(200);
      await again.text();
    });
  });
});
