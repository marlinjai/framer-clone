// renderPublishedPage: the SSR render seam. Given an adapted root + fake repos,
// it hydrates CMS/commerce LIVE and returns HTML containing that data; the
// analytics snippet is injected only when the binding is enabled (public key).
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ComponentNode, CommerceServerRepository } from '@/lib/renderer/publish/hydrateBindings';
import type { CmsReadRepository } from '@/server/cms';
import { renderPublishedPage } from '../renderPublishedPage';

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

  const enabled = {
    enabled: true,
    ingestionKey: 'ap_live_abc',
    ingestionEndpoint: 'https://ingest.lumitra.co',
    projectId: 'proj_x',
    trackerScriptSrc: 'https://cdn.lumitra.co/tracker.js',
  };

  async function html(analytics: Parameters<typeof renderPublishedPage>[0]['analytics'], language = 'de') {
    const page = await renderPublishedPage({
      root: { type: 'div', id: 'r' },
      pageParams: {},
      cmsRepo: fakeCmsRepo(),
      commerceRepo: fakeCommerceRepo(),
      analytics,
      consent: { language, privacyHref: '/datenschutz' },
    });
    return { ...page, markup: renderToStaticMarkup(<>{page.body}</>) };
  }

  it('gates analytics behind the consent banner: the tracker is never in the initial HTML', async () => {
    const { markup, analyticsGated } = await html(enabled);
    expect(analyticsGated).toBe(true);
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('data-fc-consent-runtime');
    // Only the loader stub: no executable tracker globals, no loader <script src>.
    expect(markup).not.toContain('window.__AP_CONFIG=');
    expect(markup).not.toContain('window.__AP_VARIANTS=');
    expect(markup).not.toMatch(/<script[^>]*src=/);
    // The public config travels as data inside the runtime, for after consent.
    expect(markup).toContain('ap_live_abc');
    expect(markup).toContain('proj_x');
    expect(markup).toContain('Akzeptieren');
    expect(markup).toContain('href="/datenschutz"');
  });

  it('speaks English on an English site', async () => {
    const { markup } = await html(enabled, 'en-GB');
    expect(markup).toContain('Accept');
    expect(markup).toContain('Decline');
  });

  it('renders no banner and hides cookie-settings links when analytics is disabled', async () => {
    const { markup, analyticsGated } = await html({ ...enabled, enabled: false });
    expect(analyticsGated).toBe(false);
    expect(markup).not.toContain('role="dialog"');
    expect(markup).not.toContain('ap_live_abc');
    expect(markup).toContain('a[href$="#cookie-settings"]{display:none!important}');
  });

  it('renders no banner without a resolved endpoint', async () => {
    const { analyticsGated } = await html({ ...enabled, ingestionEndpoint: null });
    expect(analyticsGated).toBe(false);
  });

  it('refuses a secret-shaped key (backstop) and loads nothing rather than failing', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { markup, analyticsGated } = await html({ ...enabled, ingestionKey: 'ap_secret_xyz' });
    expect(analyticsGated).toBe(false);
    expect(markup).not.toContain('ap_secret_xyz');
    expect(spy).toHaveBeenCalled();
  });
});
