import { describe, it, expect } from 'vitest';
import {
  collectPageAssets,
  collectProjectAssets,
  buildAssetBundleMap,
  isRelativeAsset,
} from '@/lib/renderer/publish/assetCollector';
import { makeSampleProject } from './fixtures/sampleProject';
import type { ComponentInstance } from '@/models/ComponentModel';

// A small ad-hoc tree builder for targeted detection cases (plain objects shaped
// like the read-only surface the collector walks: { props, children }).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function node(props: any, children: any[] = []): ComponentInstance {
  return { props, children } as unknown as ComponentInstance;
}

describe('assetCollector — detection', () => {
  it('collects <img src>, style backgroundImage url(), ignores external CDN', () => {
    const project = makeSampleProject();
    const assets = collectProjectAssets(project);
    expect(assets).toEqual(['/media/banner.png', '/media/hero.jpg']);
    // external https URL is excluded
    expect(assets).not.toContain('https://cdn.example.com/logo.png');
  });

  it('collects per-page (home has assets, about does not)', () => {
    const project = makeSampleProject();
    const home = project.getPage('page-home')!;
    const about = project.getPage('page-about')!;
    expect(collectPageAssets(home)).toEqual([
      '/media/banner.png',
      '/media/hero.jpg',
    ]);
    expect(collectPageAssets(about)).toEqual([]);
  });

  it('parses srcset candidate lists, taking each URL', () => {
    const tree = node({}, [
      node({
        srcset: '/img/small.jpg 320w, /img/large.jpg 1024w, https://cdn.x/y.jpg 2048w',
      }),
    ]);
    const assets = collectPageAssets({ appComponentTree: tree });
    expect(assets).toEqual(['/img/large.jpg', '/img/small.jpg']);
  });

  it('extracts url() from a top-level CSS-shaped prop and from style object', () => {
    const tree = node({}, [
      node({ backgroundImage: "url('/bg/top.png')" }),
      node({ style: { backgroundImage: 'url(/bg/nested.png)' } }),
    ]);
    expect(collectPageAssets({ appComponentTree: tree })).toEqual([
      '/bg/nested.png',
      '/bg/top.png',
    ]);
  });

  it('flattens responsive prop maps so every breakpoint URL is collected', () => {
    const tree = node({}, [
      node({ src: { base: '/r/a.jpg', 'bp-desktop': '/r/b.jpg' } }),
    ]);
    expect(collectPageAssets({ appComponentTree: tree })).toEqual([
      '/r/a.jpg',
      '/r/b.jpg',
    ]);
  });

  it('isRelativeAsset rejects external/special schemes, accepts relative + root-relative', () => {
    expect(isRelativeAsset('/media/hero.jpg')).toBe(true);
    expect(isRelativeAsset('media/hero.jpg')).toBe(true);
    expect(isRelativeAsset('https://x/y.png')).toBe(false);
    expect(isRelativeAsset('//cdn/y.png')).toBe(false);
    expect(isRelativeAsset('data:image/png;base64,AAAA')).toBe(false);
    expect(isRelativeAsset('#frag')).toBe(false);
    expect(isRelativeAsset('')).toBe(false);
  });
});

describe('assetCollector — bundle map', () => {
  it('maps each URL to assets/<basename>', () => {
    const map = buildAssetBundleMap(['/media/hero.jpg', '/a/b/banner.png']);
    expect(map.get('/media/hero.jpg')).toBe('assets/hero.jpg');
    expect(map.get('/a/b/banner.png')).toBe('assets/banner.png');
  });

  it('disambiguates a basename collision across distinct source URLs', () => {
    const map = buildAssetBundleMap(['/one/logo.png', '/two/logo.png']);
    const a = map.get('/one/logo.png')!;
    const b = map.get('/two/logo.png')!;
    expect(a).not.toBe(b);
    // one keeps the plain name, the other is prefixed; both end in logo.png
    expect(a.endsWith('logo.png')).toBe(true);
    expect(b.endsWith('logo.png')).toBe(true);
  });

  it('strips query/hash when deriving the basename', () => {
    const map = buildAssetBundleMap(['/media/hero.jpg?v=2#x']);
    expect(map.get('/media/hero.jpg?v=2#x')).toBe('assets/hero.jpg');
  });
});
