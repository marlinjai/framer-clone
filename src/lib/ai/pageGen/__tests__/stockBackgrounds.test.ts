// @vitest-environment node
//
// Photo backgrounds and crops in the stock-photo resolver: a background
// request resolves with a thumbnail for the focal-point pass, and
// applyStockPhotos layers the photo under the model's scrim, covers the box,
// writes the credit (without a hover title) and the focal position. No network.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetStockImageCacheForTests,
  applyStockPhotos,
  photoThumbSrc,
  resolveStockImages,
  type PlacedPhoto,
} from '../stockImages';
import type { GeneratedNodeSnapshot } from '../validate';
import { ComponentTypeEnum } from '@/models/ComponentModel';

const KEY = 'test-unsplash-key';

const credit = {
  photoId: 'b',
  photographerName: 'Ben',
  photographerUrl: 'https://unsplash.com/@ben?u=1',
  unsplashUrl: 'https://unsplash.com/?u=1',
};

function section(style: Record<string, unknown>): GeneratedNodeSnapshot {
  return { id: 'hero', type: 'section', componentType: ComponentTypeEnum.HOST, label: 'Hero', props: { style }, children: [] };
}

function background(extra: Partial<PlacedPhoto> = {}): PlacedPhoto {
  return {
    nodeId: 'hero',
    kind: 'background',
    src: 'https://images.unsplash.com/photo-b',
    thumbSrc: 'https://images.unsplash.com/photo-b?w=512',
    downloadLocation: 'https://api.unsplash.com/photos/b/download',
    credit,
    ...extra,
  };
}

beforeEach(() => {
  __resetStockImageCacheForTests();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('photo backgrounds', () => {
  it('resolves a background request with its kind, a 2x photo and a small thumbnail', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          results: [
            {
              id: 'a',
              urls: { raw: 'https://images.unsplash.com/photo-a?ixid=x', regular: 'https://images.unsplash.com/photo-a?w=1080' },
              user: { name: 'Ana', links: { html: 'https://unsplash.com/@ana' } },
              links: { download_location: 'https://api.unsplash.com/photos/a/download' },
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const out = await resolveStockImages(
      [{ nodeId: 'hero', kind: 'background', query: 'mountain lake at dawn', orientation: 'landscape', widthPx: 1200 }],
      { accessKey: KEY, fetch: fetchMock as unknown as typeof fetch },
    );
    expect(out.placed).toHaveLength(1);
    expect(out.placed[0].kind).toBe('background');
    expect(new URL(out.placed[0].src).searchParams.get('w')).toBe('2400');
    const thumb = new URL(out.placed[0].thumbSrc);
    expect(thumb.hostname).toBe('images.unsplash.com');
    expect(thumb.searchParams.get('w')).toBe('512');
    expect(thumb.searchParams.get('fm')).toBe('jpg');
    expect(thumb.searchParams.has('auto')).toBe(false);
    expect(out.summary.credits.map((c) => c.photoId)).toEqual(['a']);
  });

  it('puts the photo under the scrim, covers the box, writes the credit without a title and the focal point', () => {
    const scrim = 'linear-gradient(to top, rgba(0, 0, 0, 0.8), rgba(0, 0, 0, 0) 65%)';
    const input = section({ backgroundColor: '#111', backgroundImage: scrim });
    const [out] = applyStockPhotos([input], [background({ src: 'https://images.unsplash.com/photo-b?w=2400', focal: { x: 62.4, y: 31 } })]);
    expect(out.props).toEqual({
      'data-credit-name': 'Ben',
      'data-credit-url': 'https://unsplash.com/@ben?u=1',
      'data-credit-source-url': 'https://unsplash.com/?u=1',
      style: {
        backgroundColor: '#111',
        backgroundImage: `${scrim}, url("https://images.unsplash.com/photo-b?w=2400")`,
        backgroundSize: 'cover',
        backgroundRepeat: 'no-repeat',
        backgroundPosition: '62% 31%',
      },
    });
    expect(out.props).not.toHaveProperty('title');
    expect((input.props.style as Record<string, unknown>).backgroundImage).toBe(scrim); // input untouched
  });

  it('adds the photo under every breakpoint of a responsive scrim, centred without a focal point', () => {
    const even = (a: number) => `linear-gradient(rgba(0, 0, 0, ${a}), rgba(0, 0, 0, ${a}))`;
    const [out] = applyStockPhotos([section({ backgroundImage: { base: even(0.4), mobile: even(0.6) } })], [background()]);
    const style = out.props.style as Record<string, unknown>;
    expect(style.backgroundImage).toEqual({
      base: `${even(0.4)}, url("https://images.unsplash.com/photo-b")`,
      mobile: `${even(0.6)}, url("https://images.unsplash.com/photo-b")`,
    });
    expect(style.backgroundPosition).toBe('50% 50%');
  });

  it('a background without a scrim gets the photo alone', () => {
    const [out] = applyStockPhotos([section({})], [background()]);
    expect((out.props.style as Record<string, unknown>).backgroundImage).toBe('url("https://images.unsplash.com/photo-b")');
  });

  it('an img without a focal point gets an explicit centred crop', () => {
    const img: GeneratedNodeSnapshot = {
      id: 'i',
      type: 'img',
      componentType: ComponentTypeEnum.HOST,
      label: 'Image',
      props: { alt: 'x', style: { objectFit: 'cover' } },
      children: [],
    };
    const [out] = applyStockPhotos([img], [background({ nodeId: 'i', kind: 'img' })]);
    expect(out.props.style).toEqual({ objectFit: 'cover', objectPosition: '50% 50%' });
    expect(out.props.title).toBe('Photo by Ben on Unsplash');
  });

  it('photoThumbSrc falls back to the regular URL without a raw one', () => {
    expect(photoThumbSrc({ regularUrl: 'https://images.unsplash.com/photo-x?w=1080' })).toBe(
      'https://images.unsplash.com/photo-x?w=1080',
    );
  });
});
