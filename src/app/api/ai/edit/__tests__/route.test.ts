// @vitest-environment node
//
// src/app/api/ai/edit/__tests__/route.test.ts
//
// Integration test for the POST /api/ai/edit handler. We don't hit the
// real Anthropic API — instead we mock the client singleton to return a
// hand-rolled MessageStream-like object that emits a few text deltas
// and resolves with a usage block.
//
// We assert:
//   - 400 on malformed body / missing fields
//   - 401 when ANTHROPIC_API_KEY is missing
//   - 200 + ordered SSE events on the happy path
//     (token … token … usage … done)

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// --- Mock the anthropic client BEFORE importing the route -----------
//
// vi.mock is hoisted to the top of the file, so any locals it
// references must be declared via vi.hoisted (which is also hoisted).
const { mockGetAnthropicClient, mockMissingKey } = vi.hoisted(() => {
  return {
    mockGetAnthropicClient: vi.fn(),
    mockMissingKey: class MissingAnthropicKeyError extends Error {
      readonly code = 'missing_anthropic_key';
    },
  };
});

vi.mock('@/lib/ai/anthropicClient', () => {
  return {
    AI_MODELS: {
      HAIKU: 'claude-haiku-4-5',
      SONNET: 'claude-sonnet-4-6',
      OPUS: 'claude-opus-4-7',
    },
    getAnthropicClient: () => mockGetAnthropicClient(),
    MissingAnthropicKeyError: mockMissingKey,
    getDefaultModelKey: () => 'HAIKU',
    resolveModelId: () => 'claude-haiku-4-5',
  };
});

// Imported AFTER the mock declaration so the mock applies.
import { POST } from '../route';
import { __resetAiUsageForTests, getUsage } from '@/lib/ai/aiUsageStub';

type Listener = (delta: string) => void;

function fakeStreamingClient(deltas: string[]) {
  // Build a minimal MessageStream-like object. The route uses:
  //   stream.on('text', cb)
  //   await stream.finalMessage()
  //
  // We construct the streaming state *per stream() call* so each
  // request gets a fresh listener slot, and we only start emitting
  // deltas when `finalMessage()` is awaited — by that point the route
  // has had a chance to attach its `.on('text')` listener.
  return {
    messages: {
      stream: () => {
        let textListener: Listener | null = null;
        return {
          on(event: string, cb: Listener) {
            if (event === 'text') textListener = cb;
            return this;
          },
          finalMessage: async () => {
            // Yield one microtask so any synchronous `.on(...)` call
            // after `.stream(...)` has registered before we emit.
            await Promise.resolve();
            for (const d of deltas) textListener?.(d);
            return {
              usage: {
                input_tokens: 42,
                output_tokens: 17,
                cache_read_input_tokens: 5,
                cache_creation_input_tokens: 3,
              },
            };
          },
        };
      },
    },
  };
}

async function readSse(res: Response): Promise<string> {
  const body = res.body;
  if (!body) throw new Error('no body');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let out = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

function makeReq(body: unknown): Request {
  return new Request('http://localhost/api/ai/edit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/ai/edit', () => {
  beforeEach(() => {
    __resetAiUsageForTests();
    mockGetAnthropicClient.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 400 on invalid JSON body', async () => {
    const req = new Request('http://localhost/api/ai/edit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: { code: string } };
    expect(data.error.code).toBe('bad_json');
  });

  it('returns 400 when required fields are missing', async () => {
    const res = await POST(makeReq({ prompt: '' }));
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: { code: string } };
    expect(data.error.code).toBe('bad_body');
  });

  it('returns 401 when ANTHROPIC_API_KEY is missing', async () => {
    mockGetAnthropicClient.mockImplementation(() => {
      throw new mockMissingKey();
    });
    const res = await POST(
      makeReq({ prompt: 'hi', sessionId: 's1', pageId: 'p1' }),
    );
    expect(res.status).toBe(401);
    const data = (await res.json()) as { error: { code: string } };
    expect(data.error.code).toBe('missing_anthropic_key');
  });

  it('streams ordered SSE events on the happy path', async () => {
    mockGetAnthropicClient.mockReturnValue(
      fakeStreamingClient(['hello, ', 'world']),
    );

    // Silence the route's structured log line.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const res = await POST(
      makeReq({ prompt: 'hi', sessionId: 's1', pageId: 'p1' }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);

    const text = await readSse(res);

    // Strip heartbeats (none expected in this fast path, but the
    // assertion stays robust if a tester slows down).
    const events = text
      .split('\n\n')
      .filter((chunk) => chunk.startsWith('event:'))
      .map((chunk) => {
        const [eLine, dLine] = chunk.split('\n');
        return {
          event: eLine.replace(/^event:\s*/, ''),
          data: JSON.parse(dLine.replace(/^data:\s*/, '')),
        };
      });

    // Ordering: tokens first, then usage, then done.
    const types = events.map((e) => e.event);
    expect(types).toEqual(['token', 'token', 'usage', 'done']);

    expect(events[0].data).toEqual({ delta: 'hello, ' });
    expect(events[1].data).toEqual({ delta: 'world' });
    expect(events[2].data).toEqual({
      inputTokens: 42,
      outputTokens: 17,
      cachedReadTokens: 5,
      cachedWriteTokens: 3,
    });
    expect(events[3].data.turnId).toMatch(/.+/);

    // Usage stub was updated.
    const usage = getUsage('s1');
    expect(usage?.calls).toBe(1);
    expect(usage?.inputTokens).toBe(42);
    expect(usage?.outputTokens).toBe(17);
    expect(usage?.cachedReadTokens).toBe(5);
    expect(usage?.cachedWriteTokens).toBe(3);

    // Structured log emitted exactly once.
    const aiLogs = logSpy.mock.calls
      .map((args) => String(args[0] ?? ''))
      .filter((line) => line.startsWith('[ai] '));
    expect(aiLogs).toHaveLength(1);
    const parsed = JSON.parse(aiLogs[0].slice('[ai] '.length));
    expect(parsed).toMatchObject({
      sessionId: 's1',
      model: 'claude-haiku-4-5',
      inputTokens: 42,
      outputTokens: 17,
      status: 'ok',
    });
  });
});
