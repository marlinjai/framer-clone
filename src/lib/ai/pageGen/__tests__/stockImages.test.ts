// @vitest-environment node
//
// The Unsplash resolver with a stubbed fetch: success, no results, auth and
// rate-limit refusals, timeouts, the key unset, distinct photos per page, the
// per-generation cap, the per-query cache, attribution, and the download
// trigger. No network.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTH_PAUSE_MS,
  CACHE_TTL_MS,
  RATE_LIMIT_PAUSE_MS,
  __resetStockImageCacheForTests,
  applyStockPhotos,
  photoSrc,
  resolveStockImages,
  triggerStockDownloads,
} from '../stockImages';
import { GENERATION_LIMITS } from '../schema';
import type { GeneratedNodeSnapshot, ImageRequest } from '../validate';
import { ComponentTypeEnum } from '@/models/ComponentModel';

const KEY = 'test-unsplash-key';

function photo(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    urls: {
      raw: `https://images.unsplash.com/photo-${id}?ixid=x`,
      regular: `https://images.unsplash.com/photo-${id}?ixid=x&w=1080`,
    },
    user: { name: `Name ${id}`, links: { html: `https://unsplash.com/@user${id}` } },
    links: { download_location: `https://api.unsplash.com/photos/${id}/download?ixid=x` },
    ...overrides,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function req(nodeId: string, query: string, extra: Partial<ImageRequest> = {}): ImageRequest {
  return { nodeId, kind: 'img', query, ...extra };
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  __resetStockImageCacheForTests();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('resolveStockImages', () => {
  it('resolves each image to a hotlinked photo with photographer and Unsplash credit', async () => {
    const fetchMock = vi.fn(async () => json({ results: [photo('a')] }));
    const out = await resolveStockImages([req('img-1', 'bakery counter', { orientation: 'landscape', widthPx: 600 })], {
      accessKey: KEY,
      appName: 'Lumitra Sites',
      fetch: fetchMock as unknown as typeof fetch,
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://api.unsplash.com/search/photos');
    expect(u.searchParams.get('query')).toBe('bakery counter');
    expect(u.searchParams.get('orientation')).toBe('landscape');
    expect(u.searchParams.get('content_filter')).toBe('high');
    expect(init.headers).toMatchObject({ Authorization: `Client-ID ${KEY}`, 'Accept-Version': 'v1' });

    expect(out.placed).toHaveLength(1);
    const src = new URL(out.placed[0].src);
    expect(src.hostname).toBe('images.unsplash.com');
    expect(src.searchParams.get('w')).toBe('1200');
    expect(out.summary).toEqual({
      requested: 1,
      resolved: 1,
      fellBack: {},
      credits: [
        {
          photoId: 'a',
          photographerName: 'Name a',
          photographerUrl: 'https://unsplash.com/@usera?utm_source=lumitra_sites&utm_medium=referral',
          unsplashUrl: 'https://unsplash.com/?utm_source=lumitra_sites&utm_medium=referral',
        },
      ],
    });
  });

  it('is off without a key: every image keeps the placeholder, nothing is fetched', async () => {
    const fetchMock = vi.fn();
    const out = await resolveStockImages([req('a', 'one'), req('b', 'two')], {
      accessKey: '  ',
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(out.placed).toEqual([]);
    expect(out.summary.fellBack).toEqual({ disabled: 2 });
  });

  it('does nothing for a page without image requests', async () => {
    const fetchMock = vi.fn();
    const out = await resolveStockImages([], { accessKey: KEY, fetch: fetchMock as unknown as typeof fetch });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(out.summary).toEqual({ requested: 0, resolved: 0, fellBack: {}, credits: [] });
  });

  it('never repeats a photo on one page, and counts a query that runs out as no_results', async () => {
    const fetchMock = vi.fn(async () => json({ results: [photo('a'), photo('b')] }));
    const out = await resolveStockImages([req('1', 'bread'), req('2', 'Bread'), req('3', 'bread')], {
      accessKey: KEY,
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1); // one search per distinct query
    expect(out.placed.map((p) => p.credit.photoId)).toEqual(['a', 'b']);
    expect(out.summary.fellBack).toEqual({ no_results: 1 });
  });

  it('a search without results falls back for that image only', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      new URL(url).searchParams.get('query') === 'nothing' ? json({ results: [] }) : json({ results: [photo('a')] }),
    );
    const out = await resolveStockImages([req('1', 'nothing'), req('2', 'bread')], {
      accessKey: KEY,
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(out.placed.map((p) => p.nodeId)).toEqual(['2']);
    expect(out.summary.fellBack).toEqual({ no_results: 1 });
  });

  it('skips results it cannot hotlink or attribute', async () => {
    const fetchMock = vi.fn(async () =>
      json({
        results: [
          photo('evil', { urls: { regular: 'https://evil.example/x.jpg' } }),
          photo('anon', { user: { name: '', links: { html: 'https://unsplash.com/@x' } } }),
          photo('nodl', { links: { download_location: 'https://evil.example/track' } }),
          photo('ok'),
        ],
      }),
    );
    const out = await resolveStockImages([req('1', 'bread')], { accessKey: KEY, fetch: fetchMock as unknown as typeof fetch });
    expect(out.placed.map((p) => p.credit.photoId)).toEqual(['ok']);
  });

  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [429, 'rate_limited'],
    [503, 'unavailable'],
  ] as const)('HTTP %i stops further searches and falls back the rest as %s', async (status, reason) => {
    const fetchMock = vi.fn(async () => new Response('no', { status }));
    const requests = Array.from({ length: 8 }, (_, i) => req(`n${i}`, `query number ${i}`));
    const out = await resolveStockImages(requests, { accessKey: KEY, fetch: fetchMock as unknown as typeof fetch });
    // At most one search per concurrent worker before the stop takes effect.
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(4);
    expect(out.placed).toEqual([]);
    expect(out.summary.fellBack).toEqual({ [reason]: 8 });
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0][0])).not.toContain(KEY);
  });

  it('times out a search that does not answer and falls back', async () => {
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );
    const out = await resolveStockImages([req('1', 'slow photo')], {
      accessKey: KEY,
      fetch: fetchMock as unknown as typeof fetch,
      timeoutMs: 20,
    });
    expect(out.summary.fellBack).toEqual({ timeout: 1 });
  });

  it('a network failure falls back as unavailable', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const out = await resolveStockImages([req('1', 'bread')], { accessKey: KEY, fetch: fetchMock as unknown as typeof fetch });
    expect(out.summary.fellBack).toEqual({ unavailable: 1 });
  });

  it('resolves at most maxStockImages images per generation', async () => {
    let n = 0;
    const fetchMock = vi.fn(async () => json({ results: [photo(`p${(n += 1)}`)] }));
    const total = GENERATION_LIMITS.maxStockImages + 3;
    const requests = Array.from({ length: total }, (_, i) => req(`n${i}`, `subject ${i}`));
    const out = await resolveStockImages(requests, { accessKey: KEY, fetch: fetchMock as unknown as typeof fetch });
    expect(fetchMock).toHaveBeenCalledTimes(GENERATION_LIMITS.maxStockImages);
    expect(out.summary.resolved).toBe(GENERATION_LIMITS.maxStockImages);
    expect(out.summary.fellBack).toEqual({ cap: 3 });
  });

  it('caches a query for the TTL, then searches again', async () => {
    let now = 1_000;
    const fetchMock = vi.fn(async () => json({ results: [photo('a')] }));
    const deps = { accessKey: KEY, fetch: fetchMock as unknown as typeof fetch, now: () => now };
    await resolveStockImages([req('1', 'bread')], deps);
    await resolveStockImages([req('2', 'BREAD')], deps);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    now += CACHE_TTL_MS + 1;
    await resolveStockImages([req('3', 'bread')], deps);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failed search', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(json({ results: [photo('a')] }));
    const deps = { accessKey: KEY, fetch: fetchMock as unknown as typeof fetch };
    expect((await resolveStockImages([req('1', 'bread')], deps)).summary.resolved).toBe(0);
    expect((await resolveStockImages([req('1', 'bread')], deps)).summary.resolved).toBe(1);
  });
});

describe('photoSrc', () => {
  const p = { rawUrl: 'https://images.unsplash.com/photo-a?ixid=x', regularUrl: 'https://images.unsplash.com/photo-a?w=1080' };
  it('sizes the raw URL to twice the box width, capped', () => {
    expect(new URL(photoSrc(p, 300)).searchParams.get('w')).toBe('600');
    expect(new URL(photoSrc(p, 5000)).searchParams.get('w')).toBe('2400');
    expect(new URL(photoSrc(p, 300)).searchParams.get('ixid')).toBe('x');
  });
  it('uses the regular URL when the width is unknown', () => {
    expect(photoSrc(p)).toBe(p.regularUrl);
  });
});

describe('applyStockPhotos', () => {
  it('writes src and the credit into the matching img only', () => {
    const img = (id: string): GeneratedNodeSnapshot => ({
      id,
      type: 'img',
      componentType: ComponentTypeEnum.HOST,
      label: 'Image',
      props: { src: '/images/sample-image.jpg', alt: 'Brot' },
      children: [],
    });
    const nodes: GeneratedNodeSnapshot[] = [
      { id: 's', type: 'section', componentType: ComponentTypeEnum.HOST, label: 'S', props: {}, children: [img('i1'), img('i2')] },
    ];
    const out = applyStockPhotos(nodes, [
      {
        nodeId: 'i2',
        kind: 'img',
        src: 'https://images.unsplash.com/photo-a',
        thumbSrc: 'https://images.unsplash.com/photo-a?w=512',
        focal: { x: 30, y: 20 },
        downloadLocation: 'https://api.unsplash.com/photos/a/download',
        credit: { photoId: 'a', photographerName: 'Ana', photographerUrl: 'https://unsplash.com/@ana?u=1', unsplashUrl: 'https://unsplash.com/?u=1' },
      },
    ]);
    expect(out[0].children[0].props.src).toBe('/images/sample-image.jpg');
    expect(out[0].children[1].props).toEqual({
      src: 'https://images.unsplash.com/photo-a',
      alt: 'Brot',
      title: 'Photo by Ana on Unsplash',
      'data-credit-name': 'Ana',
      'data-credit-url': 'https://unsplash.com/@ana?u=1',
      'data-credit-source-url': 'https://unsplash.com/?u=1',
      style: { objectPosition: '30% 20%' },
    });
    expect(nodes[0].children[1].props.src).toBe('/images/sample-image.jpg'); // input untouched
  });
});

describe('triggerStockDownloads', () => {
  const placed = (id: string, nodeId = id) => ({
    nodeId,
    kind: 'img' as const,
    src: `https://images.unsplash.com/photo-${id}`,
    thumbSrc: `https://images.unsplash.com/photo-${id}?w=512`,
    downloadLocation: `https://api.unsplash.com/photos/${id}/download`,
    credit: { photoId: id, photographerName: 'N', photographerUrl: 'https://unsplash.com/@n', unsplashUrl: 'https://unsplash.com/' },
  });

  it('calls each placed photo download endpoint once, authenticated', async () => {
    const fetchMock = vi.fn(async () => json({ url: 'x' }));
    triggerStockDownloads([placed('a'), placed('b'), placed('a', 'other-node')], {
      accessKey: KEY,
      fetch: fetchMock as unknown as typeof fetch,
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls.map((c) => (c as unknown as [string])[0]).sort()).toEqual([
      'https://api.unsplash.com/photos/a/download',
      'https://api.unsplash.com/photos/b/download',
    ]);
    expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({
      Authorization: `Client-ID ${KEY}`,
    });
  });

  it('logs a failed trigger instead of throwing', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    expect(() => triggerStockDownloads([placed('a')], { accessKey: KEY, fetch: fetchMock as unknown as typeof fetch })).not.toThrow();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining('download trigger failed')));
  });

  it('never calls a download location outside api.unsplash.com', async () => {
    const fetchMock = vi.fn(async () => json({}));
    triggerStockDownloads([{ ...placed('a'), downloadLocation: 'https://evil.example/x' }], {
      accessKey: KEY,
      fetch: fetchMock as unknown as typeof fetch,
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('circuit breaker and shared searches', () => {
  it('a 429 pauses searching across generations, then searches again after the pause', async () => {
    let now = 10_000;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('limit', { status: 429 }))
      .mockResolvedValue(json({ results: [photo('a')] }));
    const deps = { accessKey: KEY, fetch: fetchMock as unknown as typeof fetch, now: () => now };
    await resolveStockImages([req('1', 'bread')], deps);
    const second = await resolveStockImages([req('2', 'cake')], deps);
    expect(fetchMock).toHaveBeenCalledTimes(1); // answered at once, no request spent
    expect(second.summary.fellBack).toEqual({ rate_limited: 1 });
    now += RATE_LIMIT_PAUSE_MS + 1;
    expect((await resolveStockImages([req('3', 'cake')], deps)).summary.resolved).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a refused key pauses searching too', async () => {
    let now = 0;
    const fetchMock = vi.fn(async () => new Response('no', { status: 401 }));
    const deps = { accessKey: KEY, fetch: fetchMock as unknown as typeof fetch, now: () => now };
    await resolveStockImages([req('1', 'bread')], deps);
    expect((await resolveStockImages([req('2', 'cake')], deps)).summary.fellBack).toEqual({ auth: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    now += AUTH_PAUSE_MS + 1;
    await resolveStockImages([req('3', 'pie')], deps);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('pauses before the next 429 when Unsplash reports no requests left', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ results: [photo('a')] }), { status: 200, headers: { 'X-Ratelimit-Remaining': '0' } }),
    );
    const deps = { accessKey: KEY, fetch: fetchMock as unknown as typeof fetch };
    expect((await resolveStockImages([req('1', 'bread')], deps)).summary.resolved).toBe(1);
    expect((await resolveStockImages([req('2', 'cake')], deps)).summary.fellBack).toEqual({ rate_limited: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('two generations asking the same thing at once share one search', async () => {
    let release: (r: Response) => void = () => {};
    const fetchMock = vi.fn(() => new Promise<Response>((r) => (release = r)));
    const deps = { accessKey: KEY, fetch: fetchMock as unknown as typeof fetch };
    const a = resolveStockImages([req('1', 'bread')], deps);
    const b = resolveStockImages([req('2', 'Bread')], deps);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    release(json({ results: [photo('a')] }));
    expect((await a).summary.resolved).toBe(1);
    expect((await b).summary.resolved).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never writes the query text to the logs', async () => {
    const fetchMock = vi.fn(async () => new Response('busy', { status: 503 }));
    await resolveStockImages([req('1', 'secret customer launch')], { accessKey: KEY, fetch: fetchMock as unknown as typeof fetch });
    expect(warn).toHaveBeenCalled();
    for (const call of warn.mock.calls) expect(String(call[0])).not.toContain('secret customer launch');
  });
});
