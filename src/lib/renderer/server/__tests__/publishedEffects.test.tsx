// Effects on the published page: stored `props.effects` become data
// attributes plus custom properties (per breakpoint through the responsive
// stylesheet), the server HTML never hides content (the start state is only
// injected by the boot script), and the runtime island and Lenis are wired only
// when needed.
import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import type { CmsReadRepository } from '@/server/cms';
import { applyEffects } from '../applyEffects';
import { renderPublishedPage } from '../renderPublishedPage';
import { renderComponentNode } from '../renderComponentNode';
import { FX_ATTR, FX_VAR } from '@/lib/effects/effects';

const BPS = [
  { id: 'desktop', minWidth: 1200 },
  { id: 'phone', minWidth: 0 },
];
const slideUp = { kind: 'slide-up', distance: 24, duration: 280, delay: 0, stagger: 0 };
const none = { kind: 'none', distance: 16, duration: 280, delay: 0, stagger: 0 };

const cmsRepo = { listRows: async () => ({ rows: [], total: 0 }), getRow: async () => null } as unknown as CmsReadRepository;

function page(effects: Record<string, unknown> | undefined): ComponentNode {
  return {
    type: 'main',
    id: 'root',
    children: [
      { type: 'section', id: 'hero', props: { style: { padding: '24px' }, ...(effects ? { effects } : {}) }, children: [
        { type: 'h1', id: 'h', props: { children: 'Hello' } },
      ] },
    ],
  } as ComponentNode;
}

describe('applyEffects', () => {
  it('turns effects into attributes and custom properties and drops the prop', () => {
    const out = applyEffects(page({ appear: { base: slideUp, phone: none }, hover: 'lift' }), BPS);
    const hero = out.root.children![0];
    const props = hero.props as Record<string, unknown>;
    expect(props).not.toHaveProperty('effects');
    expect(props[FX_ATTR.appear]).toBe('');
    expect(props[FX_ATTR.hover]).toBe('lift');
    const style = props.style as Record<string, unknown>;
    expect(style.padding).toBe('24px');
    expect(style[FX_VAR.startOpacity]).toEqual({ base: '0', phone: '1' });
    expect(out.needsRuntime).toBe(true);
    expect(out.hasEffects).toBe(true);
  });

  it('a page without effects is unchanged and needs nothing', () => {
    const out = applyEffects(page(undefined), BPS);
    expect(out.hasEffects).toBe(false);
    expect(out.needsRuntime).toBe(false);
  });

  it('the server renderer never emits effects as an attribute', () => {
    const html = renderToString(<>{renderComponentNode(page({ hover: 'dim' }))}</>);
    expect(html).not.toContain('effects=');
  });
});

describe('renderPublishedPage with effects', () => {
  it('per-breakpoint values land in the responsive stylesheet; nothing is hidden in the HTML', async () => {
    const { body } = await renderPublishedPage({
      root: page({ appear: { base: slideUp, phone: none } }),
      pageParams: {},
      cmsRepo,
      breakpoints: BPS,
    });
    const html = renderToString(<>{body}</>);
    // The values ride the media-query stylesheet.
    expect(html).toContain('--fx-o0:0');
    expect(html).toMatch(/@media \(max-width:1199\.98px\)\{[^}]*--fx-o0:1/);
    expect(html).toContain('data-fx-a=""');
    // The start-state selector (which hides) is not a stylesheet in the HTML:
    // only the boot script carries it, as script text.
    const styles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n');
    expect(styles).not.toContain(':not([data-fx-in])');
    expect(html).toContain('data-fc-effects-boot');
    expect(html).toContain('prefers-reduced-motion: reduce');
  });

  it('a hover-only page gets the stylesheet but no boot script', async () => {
    const { body } = await renderPublishedPage({ root: page({ hover: 'dim' }), pageParams: {}, cmsRepo, breakpoints: BPS });
    const html = renderToString(<>{body}</>);
    expect(html).toContain('data-fc-effects=""');
    expect(html).not.toContain('data-fc-effects-boot');
  });

  it('smooth scrolling adds the Lenis rules only when the site turns it on', async () => {
    const off = renderToString(<>{(await renderPublishedPage({ root: page(undefined), pageParams: {}, cmsRepo, breakpoints: BPS })).body}</>);
    expect(off).not.toContain('html.lenis');
    const on = renderToString(<>{(await renderPublishedPage({ root: page(undefined), pageParams: {}, cmsRepo, breakpoints: BPS, smoothScroll: true })).body}</>);
    expect(on).toContain('html.lenis');
  });
});
