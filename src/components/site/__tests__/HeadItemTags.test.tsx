// The tags of head items (slice H2 of docs/plans/2026-11-02-theme-and-head.md): exactly the
// attributes the kind has, written from parsed items, JSON-LD escaped. The browsers' own
// reading is test/renderGate/headItems.gate.tsx; the served HTML is test/behaviour/headItems.spec.ts.

import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { HeadItemTags } from '../HeadItemTags';
import { resolveHead, type HeadItem } from '@/lib/site/headItems';

const html = (items: HeadItem[]) => renderToStaticMarkup(<HeadItemTags items={items} />);

describe('HeadItemTags', () => {
  it('renders nothing for no items', () => {
    expect(html([])).toBe('');
  });

  it('writes each kind with exactly its own attributes', () => {
    const markup = html([
      { kind: 'meta', name: 'author', content: 'Marlin' },
      { kind: 'property', property: 'article:tag', content: 'news' },
      { kind: 'link', rel: 'alternate', href: '/de', hreflang: 'de', title: 'Deutsch' },
      { kind: 'link', rel: 'alternate', href: '/feed', type: 'application/rss+xml' },
      { kind: 'link', rel: 'me', href: 'https://example.com/me' },
    ]);
    expect(markup).toContain('<meta name="author" content="Marlin"/>');
    expect(markup).toContain('<meta property="article:tag" content="news"/>');
    expect(markup).toContain('<link rel="alternate" href="/de" hrefLang="de" title="Deutsch"/>');
    expect(markup).toContain('<link rel="alternate" href="/feed" type="application/rss+xml"/>');
    expect(markup).toContain('<link rel="me" href="https://example.com/me"/>');
  });

  it('escapes markup in a value as text', () => {
    expect(html([{ kind: 'meta', name: 'author', content: '"><script>alert(1)</script>' }])).toBe(
      '<meta name="author" content="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"/>',
    );
  });

  it('writes JSON-LD as escaped data that parses back, never as text that can close the element', () => {
    const data = { '@context': 'https://schema.org', '@type': 'Thing', name: '</script><script>alert(1)</script>', 'a<b': 'x y' };
    const markup = html([{ kind: 'jsonld', data }]);
    expect(markup).toMatch(/^<script type="application\/ld\+json" data-head-jsonld="">/);
    expect(markup.match(/<\/script/g)).toHaveLength(1);
    const body = /<script[^>]*>([\s\S]*)<\/script>$/.exec(markup)![1];
    expect(JSON.parse(body)).toEqual(data);
  });

  it('renders only what resolveHead lets through, for stored items of every refused kind', () => {
    const { items } = resolveHead(
      [{ kind: 'meta', 'http-equiv': 'refresh', content: '0;url=https://evil.test' }, { kind: 'link', rel: 'stylesheet', href: 'https://evil.test/x.css' }],
      [{ kind: 'meta', name: 'viewport', content: 'x' }, { kind: 'script', src: '/x.js' }, { kind: 'meta', name: 'rating', content: 'general' }],
    );
    expect(html(items)).toBe('<meta name="rating" content="general"/>');
  });
});
