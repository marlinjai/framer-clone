// The image route on a preview host (the public preview link of a site branch, S8): the branch's site's images,
// served privately, and nothing once the link is gone. On a published host it is unchanged: public and immutable.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const { preview, published, image } = vi.hoisted(() => ({ preview: vi.fn(), published: vi.fn(), image: vi.fn() }));
vi.mock('@/server/sites/branches/previewLinks', () => ({ resolvePreviewLink: preview }));
vi.mock('@/server/sites/cachedResolver', () => ({ getCachedPublishedSite: published }));
vi.mock('@/server/sites/siteImages', async (importActual) => {
  const actual = await importActual<typeof import('@/server/sites/siteImages')>();
  return { ...actual, readSiteImage: image, readSiteImageType: vi.fn(async () => 'image/png') };
});

import { GET } from '../route';

const SHA = 'a'.repeat(64);
const FILE = `${SHA}.png`;
const PREVIEW = `preview-${'a2'.repeat(16)}.sites.lumitra.co`;
const get = (host: string, headers: Record<string, string> = {}) =>
  GET(new Request(`https://${host}/site-images/${FILE}`, { headers: { host, ...headers } }), { params: Promise.resolve({ file: FILE }) });

beforeEach(() => {
  process.env.PUBLIC_SITE_BASE_HOST = 'sites.lumitra.co';
  preview.mockReset().mockResolvedValue({ siteId: 'main-1' });
  published.mockReset().mockResolvedValue({ siteId: 'site-9' });
  image.mockReset().mockResolvedValue({ bytes: new Uint8Array([1, 2, 3]), contentType: 'image/png' });
});

describe('site images on a preview host', () => {
  it('serves the image of the previewed branch\'s site, asked for again every time, never indexed, same origin only', async () => {
    const res = await get(PREVIEW);
    expect(res.status).toBe(200);
    expect(image).toHaveBeenCalledWith('main-1', SHA);
    expect(published).not.toHaveBeenCalled();
    // Kept by the visitor's own browser only, and never used without asking again.
    expect(res.headers.get('cache-control')).toBe('private, no-cache');
    expect(res.headers.get('etag')).toBe(`"${SHA}"`);
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    const cached = await get(PREVIEW, { 'if-none-match': `"${SHA}"` });
    expect(cached.status).toBe(304);
    expect(cached.headers.get('cache-control')).toBe('private, no-cache');
    // The link was resolved for the 304 too: asking again is what ends a picture with its link.
    expect(preview).toHaveBeenCalledTimes(2);
  });

  it('answers 404, not stored either, once the link names nothing, also to a browser that holds the picture', async () => {
    preview.mockResolvedValue(null);
    const res = await get(PREVIEW);
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const held = await get(PREVIEW, { 'if-none-match': `"${SHA}"` });
    expect(held.status).toBe(404);
    expect(held.headers.get('cache-control')).toBe('private, no-store');
    expect(image).not.toHaveBeenCalled();
  });

  it('leaves a published host as it was: public, immutable, resolved through the published cache', async () => {
    const res = await get('acme.sites.lumitra.co');
    expect(res.status).toBe(200);
    expect(image).toHaveBeenCalledWith('site-9', SHA);
    expect(preview).not.toHaveBeenCalled();
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('x-robots-tag')).toBeNull();
  });

  it('marks its other answers on a preview host too: a file name that is none, and a failed lookup', async () => {
    const bad = await GET(new Request(`https://${PREVIEW}/site-images/nope.png`, { headers: { host: PREVIEW } }), { params: Promise.resolve({ file: 'nope.png' }) });
    expect(bad.status).toBe(404);
    expect(bad.headers.get('cache-control')).toBe('private, no-store');
    preview.mockRejectedValue(new Error('database down'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const down = await get(PREVIEW);
    expect(down.status).toBe(503);
    expect(down.headers.get('cache-control')).toBe('private, no-store');
    errors.mockRestore();
  });
});
