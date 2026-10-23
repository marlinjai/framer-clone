// @vitest-environment node
//
// The focal-point pass with a mocked Anthropic client: the request it sends
// (Haiku, effort low, numbered URL images, the tool), a full answer, a partial
// and a malformed one, a refusal, no tool call, an API error, a timeout and a
// cancelled generation. No network, no real API.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { AI_MODELS } from '@/lib/ai/anthropicClient';
import { FOCAL_TOOL_NAME, detectFocalPoints, parseFocalPoints } from '../focalPoints';
import { GENERATION_LIMITS } from '../schema';

const THUMBS = ['https://images.unsplash.com/photo-1?w=512', 'https://images.unsplash.com/photo-2?w=512'];

function message(content: unknown[], extra: Record<string, unknown> = {}) {
  return {
    id: 'msg',
    type: 'message',
    role: 'assistant',
    model: AI_MODELS.HAIKU,
    stop_reason: 'tool_use',
    content,
    usage: { input_tokens: 900, output_tokens: 60, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    ...extra,
  };
}

function toolUse(input: unknown) {
  return { type: 'tool_use', id: 'tu_1', name: FOCAL_TOOL_NAME, input };
}

function clientWith(create: (...args: unknown[]) => Promise<unknown>) {
  const fn = vi.fn(create);
  return { client: { beta: { messages: { create: fn } } } as unknown as Pick<Anthropic, 'beta'>, create: fn };
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('detectFocalPoints', () => {
  it('sends one Haiku request with numbered URL images and reads a point per photo', async () => {
    const { client, create } = clientWith(async () =>
      message([{ type: 'thinking', thinking: '' }, toolUse({ points: [{ photo: 2, x: 70, y: 25 }, { photo: 1, x: 40.5, y: 30 }] })]),
    );
    const out = await detectFocalPoints(THUMBS, { client });
    expect(out.status).toBe('ok');
    expect(out.points).toEqual([{ x: 40.5, y: 30 }, { x: 70, y: 25 }]);
    expect(out.usage.inputTokens).toBe(900);

    expect(create).toHaveBeenCalledTimes(1);
    const [body, opts] = create.mock.calls[0] as [Record<string, unknown>, { signal: AbortSignal }];
    expect(body.model).toBe(AI_MODELS.HAIKU);
    expect(body.output_config).toEqual({ effort: 'low' });
    expect(body.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true });
    expect((body.tools as Array<{ name: string }>).map((t) => t.name)).toEqual([FOCAL_TOOL_NAME]);
    const content = (body.messages as Array<{ content: Array<Record<string, unknown>> }>)[0].content;
    expect(content.filter((b) => b.type === 'image').map((b) => b.source)).toEqual(
      THUMBS.map((url) => ({ type: 'url', url })),
    );
    expect(content[0]).toEqual({ type: 'text', text: 'Photo 1' });
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it('a partial answer keeps the points it has and logs the gap', async () => {
    const { client } = clientWith(async () => message([toolUse({ points: [{ photo: 1, x: 10, y: 90 }] })]));
    const out = await detectFocalPoints(THUMBS, { client });
    expect(out.status).toBe('partial');
    expect(out.points).toEqual([{ x: 10, y: 90 }, undefined]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('some photos without a point'));
  });

  it('a malformed answer fails soft', async () => {
    const { client } = clientWith(async () => message([toolUse({ points: 'centre' })]));
    const out = await detectFocalPoints(THUMBS, { client });
    expect(out).toMatchObject({ status: 'failed', reason: 'malformed', points: [undefined, undefined] });
  });

  it('no tool call fails soft', async () => {
    const { client } = clientWith(async () => message([{ type: 'text', text: 'The subject is centred.' }], { stop_reason: 'end_turn' }));
    const out = await detectFocalPoints(THUMBS, { client });
    expect(out).toMatchObject({ status: 'failed', reason: 'no_tool_call' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no tool call'));
  });

  it('a refusal fails soft and is never read as points', async () => {
    const { client } = clientWith(async () =>
      message([toolUse({ points: [{ photo: 1, x: 1, y: 1 }] })], { stop_reason: 'refusal' }),
    );
    const out = await detectFocalPoints(THUMBS, { client });
    expect(out).toMatchObject({ status: 'failed', reason: 'refused', points: [undefined, undefined] });
  });

  it('an API error fails soft with its name and a warning', async () => {
    const { client } = clientWith(async () => {
      throw new TypeError('fetch failed');
    });
    const out = await detectFocalPoints(THUMBS, { client });
    expect(out).toMatchObject({ status: 'failed', reason: 'TypeError', points: [undefined, undefined] });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('failed, crops stay centred'));
  });

  it('times out and fails soft', async () => {
    const { client } = clientWith(
      (_body, opts) =>
        new Promise((_, reject) => {
          const signal = (opts as { signal: AbortSignal }).signal;
          signal.addEventListener('abort', () => reject(signal.reason));
        }),
    );
    const out = await detectFocalPoints(THUMBS, { client, timeoutMs: 20 });
    expect(out).toMatchObject({ status: 'failed', reason: 'timeout' });
  });

  it('a cancelled generation skips the pass without a warning', async () => {
    const controller = new AbortController();
    controller.abort();
    const { client, create } = clientWith(async () => message([]));
    const out = await detectFocalPoints(THUMBS, { client, signal: controller.signal });
    expect(out.status).toBe('skipped');
    expect(create).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('skips the call when nothing was placed', async () => {
    const { client, create } = clientWith(async () => message([]));
    const out = await detectFocalPoints([], { client });
    expect(out).toMatchObject({ status: 'skipped', points: [] });
    expect(create).not.toHaveBeenCalled();
  });

  it('never sends more photos than one generation places', async () => {
    const many = Array.from({ length: GENERATION_LIMITS.maxStockImages + 3 }, (_, i) => `https://images.unsplash.com/p-${i}`);
    const { client, create } = clientWith(async () => message([toolUse({ points: [] })]));
    const out = await detectFocalPoints(many, { client });
    const content = (create.mock.calls[0][0] as { messages: Array<{ content: Array<{ type: string }> }> }).messages[0].content;
    expect(content.filter((b) => b.type === 'image')).toHaveLength(GENERATION_LIMITS.maxStockImages);
    expect(out.points).toHaveLength(many.length);
  });
});

describe('parseFocalPoints', () => {
  it('clamps slightly out-of-range values and skips bad entries', () => {
    expect(
      parseFocalPoints(
        {
          points: [
            { photo: 1, x: 101, y: -2 },
            { photo: 1, x: 5, y: 5 }, // repeat of photo 1
            { photo: 2, x: 400, y: 10 }, // far out of range
            { photo: 3, x: '50', y: 50 }, // not a number
            { photo: 4, x: 20, y: 20 }, // no such photo
            null,
          ],
        },
        3,
      ),
    ).toEqual([{ x: 100, y: 0 }, undefined, undefined]);
    expect(parseFocalPoints(undefined, 2)).toEqual([undefined, undefined]);
  });
});
