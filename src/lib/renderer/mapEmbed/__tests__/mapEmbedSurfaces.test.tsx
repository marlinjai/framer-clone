// The Google Maps embed on every surface (src/lib/renderer/mapEmbed): the published
// page renders a placeholder and asks for maps consent, the island draws the frame
// only after consent and takes it out on a "no", and the editor surfaces never load it.

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, within } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import type { CmsReadRepository } from '@/server/cms';
import { renderPublishedPage } from '@/lib/renderer/server/renderPublishedPage';
import { renderComponentNode } from '@/lib/renderer/server/renderComponentNode';
import { createMapEmbedElement } from '../mapEmbedElement';
import MapEmbedIsland from '../MapEmbedIsland';
import { MAP_EMBED_ATTR, MAP_EMBED_MARKER } from '@/lib/mapEmbed/mapEmbed';

const SHARE = 'https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d2419.6!2d13.2834!3d52.6871!5e0';
const cmsRepo = { listRows: async () => ({ rows: [], total: 0 }), getRow: async () => null } as unknown as CmsReadRepository;

type Win = Window & { __lumitraConsent?: { get: (c?: string) => string | null; open: (c?: string) => void } };
const win = window as Win;

afterEach(() => {
  cleanup();
  delete win.__lumitraConsent;
  vi.restoreAllMocks();
});

const mapNode = (props: Record<string, unknown> = {}): ComponentNode => ({
  type: 'div',
  id: 'map',
  props: { [MAP_EMBED_ATTR]: MAP_EMBED_MARKER, mapUrl: SHARE, mapAddress: 'Werkstatt, Birkenwerder', style: { height: '320px' }, ...props },
});

async function publish(root: ComponentNode, language = 'de', analytics = false) {
  const page = await renderPublishedPage({
    root,
    pageParams: {},
    cmsRepo,
    consent: { language, privacyHref: '/datenschutz' },
    ...(analytics
      ? { analytics: { enabled: true, ingestionKey: 'ap_live_abc', ingestionEndpoint: 'https://ingest.lumitra.co', projectId: 'p' } }
      : {}),
  });
  return { ...page, markup: renderToStaticMarkup(<>{page.body}</>) };
}

describe('the published page', () => {
  it('asks for maps consent and holds no frame and no embed address', async () => {
    const { markup, consentCategories, analyticsGated } = await publish({ type: 'div', id: 'root', children: [mapNode()] });
    expect(consentCategories).toEqual(['maps']);
    expect(analyticsGated).toBe(false);
    expect(markup).toContain('data-fc-consent');
    expect(markup).not.toContain('<iframe');
    expect(markup).not.toContain('/maps/embed');
    expect(markup).toContain('Karte laden');
    expect(markup).toContain('Werkstatt, Birkenwerder');
    expect(markup).toContain('In Google Maps öffnen');
    expect(markup).toContain('Google Ireland Limited');
    // The only Google address in the HTML is the plain link, which loads nothing.
    const google = [...markup.matchAll(/https:\/\/www\.google\.com[^"]*/g)].map((m) => m[0]);
    expect(google).toEqual([`https://www.google.com/maps/search/?api=1&amp;query=${encodeURIComponent('Werkstatt, Birkenwerder')}`]);
    expect(markup).not.toContain('mapUrl');
  });

  it('asks about both on a page with analytics and a map', async () => {
    const { consentCategories, markup } = await publish({ type: 'div', id: 'root', children: [mapNode()] }, 'en', true);
    expect(consentCategories).toEqual(['analytics', 'maps']);
    expect(markup).toMatch(/Lumitra Analytics[\s\S]*Google Maps/);
  });

  it('carries the runtime and the cookie settings link on every page of a site with a map', async () => {
    const page = await renderPublishedPage({
      root: { type: 'div', id: 'root', children: [{ type: 'p', id: 'p', props: { children: 'x' } }] },
      pageParams: {},
      cmsRepo,
      consent: { language: 'en', siteHasMap: true },
    });
    const markup = renderToStaticMarkup(<>{page.body}</>);
    expect(page.consentCategories).toEqual([]);
    expect(page.siteConsentCategories).toEqual(['maps']);
    expect(markup).toContain('data-fc-consent-runtime');
    expect(markup).not.toContain('data-fc-consent-none');
    expect(markup).not.toContain('<iframe');
  });

  it('asks each purpose in its own row on a site with analytics and a map', async () => {
    const { markup } = await publish({ type: 'div', id: 'root', children: [mapNode()] }, 'en', true);
    expect(markup).toContain('data-fc-consent-row="analytics"');
    expect(markup).toContain('data-fc-consent-row="maps"');
    expect(markup).toContain('data-fc-consent-accept="maps"');
  });

  it('has no banner and no maps question on a page without a map', async () => {
    const { consentCategories, markup } = await publish({ type: 'div', id: 'root', children: [{ type: 'p', id: 'p', props: { children: 'x' } }] });
    expect(consentCategories).toEqual([]);
    expect(markup).not.toContain('data-fc-consent-runtime');
  });

  it('still refuses every stored iframe, a Google one too, and a forged map part', () => {
    const iframe: ComponentNode = { type: 'iframe', id: 'f', props: { src: SHARE, [MAP_EMBED_ATTR]: MAP_EMBED_MARKER } };
    expect(renderComponentNode(iframe)).toBeNull();
    const forged: ComponentNode = { type: 'button', id: 'b', props: { 'data-fc-map-load': '', 'data-fc-map-frame': '', children: 'x' } };
    const markup = renderToStaticMarkup(<>{renderComponentNode(forged)}</>);
    expect(markup).toBe('<button>x</button>');
  });

  it('renders the placeholder without a load button when nothing is usable', async () => {
    const { markup } = await publish({ type: 'div', id: 'root', children: [mapNode({ mapUrl: 'https://evil.test/x', mapAddress: undefined })] }, 'en');
    expect(markup).not.toContain('data-fc-map-load');
    expect(markup).toContain('No map has been set here yet.');
    expect(markup).not.toContain('evil.test');
  });
});

describe('the island', () => {
  const config = { mapUrl: SHARE, mapAddress: 'Werkstatt, Birkenwerder', mapLanguage: 'en' };
  /** The platform's own part of the box: its shadow tree, out of reach of page styles. */
  const shadowRoot = () => Array.from(document.querySelectorAll('div')).find((d) => d.shadowRoot)?.shadowRoot ?? null;
  const own = () => {
    const root = shadowRoot();
    if (!root) throw new Error('no shadow root on the map box');
    return within(root as unknown as HTMLElement);
  };
  const frame = () => shadowRoot()?.querySelector('iframe') ?? document.querySelector('iframe');

  it('"Load map" only opens the banner; the frame comes with the banner\'s yes and goes with a no', () => {
    const open = vi.fn();
    win.__lumitraConsent = { get: () => null, open };
    render(<MapEmbedIsland domProps={{ 'data-map-embed': 'google', style: { height: 300 } }} config={config} />);
    expect(frame()).toBeNull();
    fireEvent.click(own().getByRole('button', { name: 'Load map' }));
    expect(open).toHaveBeenCalledWith('maps');
    // Asking is not answering.
    expect(frame()).toBeNull();
    (document.activeElement as HTMLElement | null)?.blur();
    act(() => {
      window.dispatchEvent(new CustomEvent('lumitra:consent', { detail: { maps: true } }));
    });
    const loaded = frame() as HTMLIFrameElement;
    expect(loaded.getAttribute('src')).toBe(SHARE);
    expect(loaded.getAttribute('title')).toBe('Map: Werkstatt, Birkenwerder');
    expect(loaded.getAttribute('referrerpolicy')).toBe('strict-origin-when-cross-origin');
    expect(loaded.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox');
    expect(loaded.getAttribute('allow')).toBe('fullscreen');
    // Focus inside a shadow tree: the document sees the box, the tree sees the frame.
    expect(shadowRoot()!.activeElement).toBe(loaded);
    act(() => {
      window.dispatchEvent(new CustomEvent('lumitra:consent', { detail: { maps: false } }));
    });
    expect(frame()).toBeNull();
    expect(own().getByRole('button', { name: 'Load map' })).toBeTruthy();
  });

  it('shows the map at once for a visitor who already consented, and ignores other categories', () => {
    win.__lumitraConsent = { get: (c) => (c === 'maps' ? 'granted' : null), open: vi.fn() };
    render(<MapEmbedIsland domProps={{}} config={config} />);
    expect(frame()).not.toBeNull();
    act(() => {
      window.dispatchEvent(new CustomEvent('lumitra:consent', { detail: { analytics: false } }));
    });
    expect(frame()).not.toBeNull();
  });

  it('never draws a frame for an address it did not rebuild', () => {
    win.__lumitraConsent = { get: () => 'granted', open: vi.fn() };
    render(<MapEmbedIsland domProps={{}} config={{ mapUrl: 'https://evil.test/maps/embed?pb=x' }} />);
    expect(frame()).toBeNull();
  });

  it('without a consent runtime, loads nothing, says so, and keeps the open link', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<MapEmbedIsland domProps={{}} config={config} />);
    fireEvent.click(own().getByRole('button', { name: 'Load map' }));
    expect(frame()).toBeNull();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('no consent runtime'));
    expect(own().getByRole('link', { name: 'Open in Google Maps' })).toBeTruthy();
  });

  it('keeps its own part out of reach of page styles, and leaves a light copy for a page without JavaScript', () => {
    win.__lumitraConsent = { get: () => null, open: vi.fn() };
    const { container } = render(<MapEmbedIsland domProps={{ 'data-map-embed': 'google' }} config={config} />);
    const box = container.firstElementChild as HTMLElement;
    expect(box.shadowRoot).not.toBeNull();
    const rootStyle = (box.shadowRoot!.querySelector('[data-fc-map-root]') as HTMLElement).style;
    expect(rootStyle.getPropertyValue('all')).toBe('initial');
    expect(own().getByRole('button', { name: 'Load map' })).toBeTruthy();
    // The light copy is what the server sent: no working button, the plain link.
    expect(box.querySelector(':scope > [data-fc-map-placeholder] button')).toBeNull();
    expect(box.querySelector(':scope > [data-fc-map-placeholder] a[data-fc-map-open]')).not.toBeNull();
  });

  it('opens Google Maps through a plain link that needs no consent', () => {
    render(<MapEmbedIsland domProps={{}} config={config} />);
    const link = own().getByRole('link', { name: 'Open in Google Maps' });
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });
});

describe('the editor surfaces', () => {
  it('draw the placeholder with a label on the canvas, never a frame or a live link', () => {
    const markup = renderToStaticMarkup(createMapEmbedElement({ 'data-map-embed': 'google', mapUrl: SHARE, mapAddress: 'Berlin' }, 'editor'));
    expect(markup).not.toContain('<iframe');
    expect(markup).not.toContain('<a ');
    expect(markup).not.toContain('<button');
    expect(markup).toContain('loads after consent');
    expect(markup).not.toContain('mapUrl');
  });

  it('draw the placeholder in the preview, with the plain link only', () => {
    const markup = renderToStaticMarkup(createMapEmbedElement({ 'data-map-embed': 'google', mapUrl: SHARE, mapAddress: 'Berlin' }, 'preview'));
    expect(markup).not.toContain('<iframe');
    expect(markup).not.toContain('/maps/embed');
    expect(markup).toContain('href="https://www.google.com/maps/search/?api=1&amp;query=Berlin"');
  });
});
