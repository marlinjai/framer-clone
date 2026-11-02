// The Google Maps embed on every surface (src/lib/renderer/mapEmbed): the published
// page renders a placeholder and asks for maps consent, the island draws the frame
// only after consent and takes it out on a "no", and the editor surfaces never load it.

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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

type Win = Window & { __lumitraConsent?: { get: (c?: string) => string | null; grant: (c: string) => void } };
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
    expect(markup).toMatch(/Lumitra Analytics.*Google Maps/);
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
  const frame = () => document.querySelector('iframe');

  it('shows the placeholder until consent, then the frame, and the placeholder again on a no', () => {
    let state: string | null = null;
    const grant = vi.fn(() => {
      state = 'granted';
      window.dispatchEvent(new CustomEvent('lumitra:consent', { detail: { maps: true } }));
    });
    win.__lumitraConsent = { get: (c) => (c === 'maps' ? state : null), grant };
    render(<MapEmbedIsland domProps={{ 'data-map-embed': 'google', style: { height: 300 } }} config={config} />);
    expect(frame()).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Load map' }));
    expect(grant).toHaveBeenCalledWith('maps');
    const loaded = frame() as HTMLIFrameElement;
    expect(loaded.getAttribute('src')).toBe(SHARE);
    expect(loaded.getAttribute('title')).toBe('Map: Werkstatt, Birkenwerder');
    expect(loaded.getAttribute('referrerpolicy')).toBe('strict-origin-when-cross-origin');
    expect(document.activeElement).toBe(loaded);
    act(() => {
      window.dispatchEvent(new CustomEvent('lumitra:consent', { detail: { maps: false } }));
    });
    expect(frame()).toBeNull();
    expect(screen.getByRole('button', { name: 'Load map' })).toBeTruthy();
  });

  it('shows the map at once for a visitor who already consented, and ignores other categories', () => {
    win.__lumitraConsent = { get: (c) => (c === 'maps' ? 'granted' : null), grant: vi.fn() };
    render(<MapEmbedIsland domProps={{}} config={config} />);
    expect(frame()).not.toBeNull();
    act(() => {
      window.dispatchEvent(new CustomEvent('lumitra:consent', { detail: { analytics: false } }));
    });
    expect(frame()).not.toBeNull();
  });

  it('never draws a frame for an address it did not rebuild', () => {
    win.__lumitraConsent = { get: () => 'granted', grant: vi.fn() };
    render(<MapEmbedIsland domProps={{}} config={{ mapUrl: 'https://evil.test/maps/embed?pb=x' }} />);
    expect(frame()).toBeNull();
  });

  it('without a consent runtime, the click loads the map for this page view and says so', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<MapEmbedIsland domProps={{}} config={config} />);
    fireEvent.click(screen.getByRole('button', { name: 'Load map' }));
    expect(frame()).not.toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no consent runtime'));
  });

  it('opens Google Maps through a plain link that needs no consent', () => {
    render(<MapEmbedIsland domProps={{}} config={config} />);
    const link = screen.getByRole('link', { name: 'Open in Google Maps' });
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
