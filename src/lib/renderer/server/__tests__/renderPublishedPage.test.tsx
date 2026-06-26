// renderPublishedPage: the SSR render seam. Given an adapted root + fake repos,
// it hydrates CMS/commerce LIVE and returns HTML containing that data; the
// analytics snippet is injected only when the binding is enabled (public key).
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import type { ComponentNode, CommerceServerRepository } from '@/lib/renderer/publish/hydrateBindings';
import type { CmsReadRepository } from '@/server/cms';
import { renderPublishedPage, pageSeoToMetadata } from '../renderPublishedPage';
import type { PageSeoMetadata } from '../snapshotToComponentNode';

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

/** A CMS repo that returns two rows for any collection. */
function fakeCmsRepo(): CmsReadRepository {
  return {
    listRows: async () => ({
      rows: [
        { id: 'r1', values: { title: 'Alpha' } },
        { id: 'r2', values: { title: 'Beta' } },
      ],
      total: 2,
    }),
    getRow: async () => null,
  } as unknown as CmsReadRepository;
}

/** An unused commerce repo (the seam still requires one). */
function fakeCommerceRepo(): CommerceServerRepository {
  return {
    listProducts: async () => ({ products: [], total: 0 }),
    getProductByHandle: async () => null,
    listVariants: async () => [],
    getPrices: async () => [],
    getAvailability: async () => ({
      variantId: 'x',
      locationId: 'all',
      availableQuantity: 0,
      stale: false,
    }),
  };
}

/** A collection node bound to `col1` with a per-row text template ({{row.title}}). */
function collectionRoot(): ComponentNode {
  return {
    type: 'div',
    id: 'root',
    children: [
      {
        type: 'div',
        id: 'col',
        props: { 'data-component-kind': 'collection' },
        bindings: { collection: { mode: 'read', expression: 'col1' } },
        children: [
          {
            type: 'p',
            id: 'tpl',
            props: { children: '' },
            bindings: { children: { mode: 'read', expression: '{{row.title}}' } },
          },
        ],
      },
    ],
  };
}

describe('renderPublishedPage', () => {
  it('hydrates CMS data per request and renders it into the HTML', async () => {
    const { body } = await renderPublishedPage({
      root: collectionRoot(),
      pageParams: {},
      cmsRepo: fakeCmsRepo(),
      commerceRepo: fakeCommerceRepo(),
    });
    const { container } = render(<>{body}</>);
    expect(container.textContent).toContain('Alpha');
    expect(container.textContent).toContain('Beta');
  });

  it('injects the analytics snippet with the PUBLIC key when enabled', async () => {
    const { headSnippet } = await renderPublishedPage({
      root: { type: 'div', id: 'r' },
      pageParams: {},
      cmsRepo: fakeCmsRepo(),
      commerceRepo: fakeCommerceRepo(),
      analytics: {
        enabled: true,
        ingestionKey: 'ap_live_abc',
        ingestionEndpoint: 'https://ingest.lumitra.co',
        projectId: 'proj_x',
      },
    });
    expect(headSnippet).toContain('window.__AP_CONFIG');
    expect(headSnippet).toContain('ap_live_abc');
    expect(headSnippet).toContain('proj_x');
    // A/B deferred: control baseline ships an empty variants object.
    expect(headSnippet).toContain('window.__AP_VARIANTS={}');
  });

  it('injects the tracker LOADER script when a tracker URL is configured (so the page EMITS)', async () => {
    const { headSnippet } = await renderPublishedPage({
      root: { type: 'div', id: 'r' },
      pageParams: {},
      cmsRepo: fakeCmsRepo(),
      commerceRepo: fakeCommerceRepo(),
      analytics: {
        enabled: true,
        ingestionKey: 'ap_live_abc',
        ingestionEndpoint: 'https://ingest.lumitra.co',
        trackerScriptSrc: 'https://cdn.lumitra.co/tracker.js',
      },
    });
    expect(headSnippet).toContain('<script async src="https://cdn.lumitra.co/tracker.js">');
  });

  it('emits config-only (no loader script) when the tracker URL is not configured', async () => {
    const { headSnippet } = await renderPublishedPage({
      root: { type: 'div', id: 'r' },
      pageParams: {},
      cmsRepo: fakeCmsRepo(),
      commerceRepo: fakeCommerceRepo(),
      analytics: {
        enabled: true,
        ingestionKey: 'ap_live_abc',
        ingestionEndpoint: 'https://ingest.lumitra.co',
        // no trackerScriptSrc
      },
    });
    expect(headSnippet).toContain('window.__AP_CONFIG');
    expect(headSnippet).not.toContain('<script async src');
  });

  it('injects nothing when analytics is disabled', async () => {
    const { headSnippet } = await renderPublishedPage({
      root: { type: 'div', id: 'r' },
      pageParams: {},
      cmsRepo: fakeCmsRepo(),
      commerceRepo: fakeCommerceRepo(),
      analytics: {
        enabled: false,
        ingestionKey: 'ap_live_abc',
        ingestionEndpoint: 'https://ingest.lumitra.co',
      },
    });
    expect(headSnippet).toBeNull();
  });

  it('refuses a secret-shaped key (backstop) and injects nothing rather than failing', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { headSnippet } = await renderPublishedPage({
      root: { type: 'div', id: 'r' },
      pageParams: {},
      cmsRepo: fakeCmsRepo(),
      commerceRepo: fakeCommerceRepo(),
      analytics: {
        enabled: true,
        ingestionKey: 'ap_secret_xyz',
        ingestionEndpoint: 'https://ingest.lumitra.co',
      },
    });
    expect(headSnippet).toBeNull();
    expect(spy).toHaveBeenCalled();
  });
});

describe('pageSeoToMetadata', () => {
  const base: PageSeoMetadata = {
    title: 'My Page',
    description: 'A description',
    keywords: ['k1', 'k2'],
    ogTitle: '',
    ogDescription: '',
    ogImage: 'https://x/og.png',
    canonicalUrl: 'https://x/p',
  };

  it('maps title/description/keywords/canonical and falls back OG to title/description', () => {
    const meta = pageSeoToMetadata(base);
    expect(meta.title).toBe('My Page');
    expect(meta.description).toBe('A description');
    expect(meta.keywords).toEqual(['k1', 'k2']);
    expect(meta.alternates).toEqual({ canonical: 'https://x/p' });
    expect(meta.openGraph).toMatchObject({
      title: 'My Page',
      description: 'A description',
      images: [{ url: 'https://x/og.png' }],
    });
  });

  it('omits empty fields', () => {
    const meta = pageSeoToMetadata({
      title: '',
      description: '',
      keywords: [],
      ogTitle: '',
      ogDescription: '',
      ogImage: '',
      canonicalUrl: '',
    });
    expect(meta.title).toBeUndefined();
    expect(meta.openGraph).toBeUndefined();
    expect(meta.keywords).toBeUndefined();
  });
});
