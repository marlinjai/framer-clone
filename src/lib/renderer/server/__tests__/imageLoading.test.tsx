// Image loading on published pages: the hero img loads with high priority and
// never lazily, every other img is lazy and decodes async, logos and icons are
// never the hero, explicit author values are kept, and a hero made of a photo
// background is preloaded instead. Also checked in the rendered HTML.

import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import { applyImageLoading } from '../imageLoading';
import { renderComponentNode } from '../renderComponentNode';

const img = (id: string, extra: Record<string, unknown> = {}): ComponentNode =>
  ({ id, type: 'img', props: { src: `https://img.test/${id}.jpg`, alt: id, ...extra } }) as ComponentNode;
const section = (id: string, children: ComponentNode[], style: Record<string, unknown> = {}): ComponentNode =>
  ({ id, type: 'section', props: { style }, children }) as ComponentNode;
const page = (...sections: ComponentNode[]): ComponentNode => ({ id: 'root', type: 'div', props: {}, children: sections }) as ComponentNode;

function find(root: ComponentNode, id: string): ComponentNode {
  const stack = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.id === id) return n;
    stack.push(...(n.children ?? []));
  }
  throw new Error(id);
}

describe('applyImageLoading', () => {
  it('gives the first large image of the first section priority and lazies the rest', () => {
    const tree = page(
      section('hero', [img('logo', { style: { width: '48px' } }), img('photo')]),
      section('more', [img('a'), img('b')]),
    );
    const { root, preloadUrl } = applyImageLoading(tree);
    expect(find(root, 'photo').props).toMatchObject({ fetchPriority: 'high' });
    expect(find(root, 'photo').props?.loading).toBeUndefined();
    expect(find(root, 'logo').props).toMatchObject({ loading: 'lazy', decoding: 'async' });
    expect(find(root, 'a').props).toMatchObject({ loading: 'lazy', decoding: 'async' });
    expect(find(root, 'b').props).toMatchObject({ loading: 'lazy', decoding: 'async' });
    expect(preloadUrl).toBeNull();
    // Pure: the input tree is untouched.
    expect(find(tree, 'a').props?.loading).toBeUndefined();
  });

  it('never picks an image from a later section as the hero', () => {
    const { root } = applyImageLoading(page(section('hero', []), section('more', [img('a')])));
    expect(find(root, 'a').props).toMatchObject({ loading: 'lazy' });
    expect(find(root, 'a').props?.fetchPriority).toBeUndefined();
  });

  it('keeps explicit author values, but never a lazy hero', () => {
    const { root } = applyImageLoading(
      page(section('hero', [img('photo', { loading: 'lazy' })]), section('more', [img('a', { loading: 'eager', decoding: 'sync' })])),
    );
    expect(find(root, 'photo').props?.loading).toBeUndefined();
    expect(find(root, 'a').props).toMatchObject({ loading: 'eager', decoding: 'sync' });
  });

  it('treats responsive and attribute sizes as logo sizes too', () => {
    const { root } = applyImageLoading(
      page(section('hero', [img('icon', { width: 32 }), img('mark', { style: { height: { base: '64px' } } }), img('photo')])),
    );
    expect(find(root, 'photo').props?.fetchPriority).toBe('high');
    expect(find(root, 'icon').props?.fetchPriority).toBeUndefined();
    expect(find(root, 'mark').props?.fetchPriority).toBeUndefined();
  });

  it('preloads a photo background when the hero has no image', () => {
    const { preloadUrl } = applyImageLoading(
      page(
        section('hero', [], {
          backgroundImage: { base: 'linear-gradient(rgba(0,0,0,.4), rgba(0,0,0,.4)), url("https://img.test/hero.jpg")' },
        }),
      ),
    );
    expect(preloadUrl).toBe('https://img.test/hero.jpg');
  });

  it('handles a page without sections', () => {
    expect(applyImageLoading({ id: 'root', type: 'div', props: {} } as ComponentNode)).toEqual({
      root: { id: 'root', type: 'div', props: {} },
      preloadUrl: null,
    });
  });

  it('reaches the HTML as fetchpriority, loading and decoding attributes', () => {
    const { root } = applyImageLoading(page(section('hero', [img('photo')]), section('more', [img('a')])));
    const html = renderToStaticMarkup(<>{renderComponentNode(root)}</>);
    expect(html).toMatch(/<img[^>]*src="https:\/\/img.test\/photo.jpg"[^>]*fetchPriority="high"|<img[^>]*fetchPriority="high"[^>]*photo/i);
    expect(html).toMatch(/<img[^>]*loading="lazy"[^>]*decoding="async"[^>]*>|<img[^>]*decoding="async"[^>]*loading="lazy"/);
    expect(html).not.toMatch(/photo.jpg"[^>]*loading="lazy"/);
  });
});
