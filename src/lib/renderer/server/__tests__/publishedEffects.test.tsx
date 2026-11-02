// Effects on the published page: stored `props.effects` become data
// attributes plus custom properties (per breakpoint through the responsive
// stylesheet), a hover preset becomes a shared class with one rule per kind, the
// server HTML never hides content (the start state is only injected by the boot
// script), and the runtime island and Lenis are wired only when needed.
import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import type { CmsReadRepository } from '@/server/cms';
import { applyEffects } from '../applyEffects';
import { applyResponsiveStyles } from '../applyResponsiveStyles';
import { renderPublishedPage } from '../renderPublishedPage';
import { renderComponentNode } from '../renderComponentNode';
import { FX_ATTR, FX_VAR } from '@/lib/effects/effects';
import { STICKY_CTA_ATTR, STICKY_CTA_MARKER } from '@/lib/stickyCta/stickyCta';

const BPS = [
  { id: 'desktop', minWidth: 1200 },
  { id: 'phone', minWidth: 0 },
];
const slideUp = { kind: 'slide-up', distance: 24, duration: 280, delay: 0, stagger: 0 };
const none = { kind: 'none', distance: 16, duration: 280, delay: 0, stagger: 0 };

const cmsRepo = { listRows: async () => ({ rows: [], total: 0 }), getRow: async () => null } as unknown as CmsReadRepository;

const sheetOf = (html: string): string => /<style data-fc-responsive="">([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';

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
    expect(props).not.toHaveProperty('data-fx-h');
    expect(hero.hoverPreset).toBe('lift');
    const style = props.style as Record<string, unknown>;
    expect(style.padding).toBe('24px');
    expect(style[FX_VAR.startOpacity]).toEqual({ base: '0', phone: '1' });
    expect(out.needsRuntime).toBe(true);
  });

  it('a page without effects is unchanged and needs nothing', () => {
    const out = applyEffects(page(undefined), BPS);
    expect(out.root.children![0].hoverPreset).toBeUndefined();
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

  it('a hover-only page gets the rule in its stylesheet but no boot script', async () => {
    const { body } = await renderPublishedPage({ root: page({ hover: 'dim' }), pageParams: {}, cmsRepo, breakpoints: BPS });
    const html = renderToString(<>{body}</>);
    expect(sheetOf(html)).toContain('.fc_fx-dim:hover{opacity:0.8}');
    expect(html).toContain('class="fc_fx-dim"');
    expect(html).not.toContain('data-fx-h');
    expect(html).not.toContain('data-fc-effects');
  });

  it('an appear and a hover on one node keep the runtime attribute beside the class', async () => {
    const { body } = await renderPublishedPage({ root: page({ appear: slideUp, hover: 'lift' }), pageParams: {}, cmsRepo, breakpoints: BPS });
    const html = renderToString(<>{body}</>);
    expect(html).toContain('data-fx-a=""');
    expect(html).toContain('class="fc_fx-lift"');
    expect(html).toContain('data-fc-effects-boot');
  });

  it('smooth scrolling adds the Lenis rules only when the site turns it on, and no hover text with them', async () => {
    const off = renderToString(<>{(await renderPublishedPage({ root: page(undefined), pageParams: {}, cmsRepo, breakpoints: BPS })).body}</>);
    expect(off).not.toContain('html.lenis');
    const on = renderToString(<>{(await renderPublishedPage({ root: page(undefined), pageParams: {}, cmsRepo, breakpoints: BPS, smoothScroll: true })).body}</>);
    expect(on).toContain('html.lenis');
    expect(on).not.toContain('data-fx-h');
  });
});

describe('hover presets as shared rules', () => {
  const box = (id: string, props: Record<string, unknown>): ComponentNode => ({ type: 'div', id, props }) as ComponentNode;
  const root = (...children: ComponentNode[]): ComponentNode => ({ type: 'main', id: 'root', children }) as ComponentNode;
  const published = (tree: ComponentNode) => applyResponsiveStyles(applyEffects(tree, BPS).root, BPS);
  const classOf = (node: ComponentNode) => (node.props as Record<string, unknown>).className;

  it('emits each kind in use once, and only those', () => {
    const { css, root: out } = published(root(box('a', { effects: { hover: 'dim' } }), box('b', { effects: { hover: 'dim' } })));
    expect(css).toBe(
      '@media (hover:hover) and (pointer:fine){\n.fc_fx-dim:hover{opacity:0.8}\n}\n' +
        '@media (hover:hover) and (pointer:fine) and (prefers-reduced-motion:no-preference){\n' +
        '.fc_fx-dim{transition:translate 160ms ease,opacity 160ms ease}\n}',
    );
    expect(out.children!.map(classOf)).toEqual(['fc_fx-dim', 'fc_fx-dim']);
  });

  it('holds the numbers and gates of each kind', () => {
    const { css } = published(root(box('a', { effects: { hover: 'lift' } }), box('b', { effects: { hover: 'underline' } })));
    expect(css).toBe(
      '@media (hover:hover) and (pointer:fine) and (prefers-reduced-motion:no-preference){\n' +
        '.fc_fx-lift{transition:translate 160ms ease,opacity 160ms ease}\n.fc_fx-lift:hover{translate:0 -2px}\n}\n' +
        '@media (hover:hover) and (pointer:fine){\n.fc_fx-underline:hover{text-decoration-line:underline;text-underline-offset:0.2em}\n}',
    );
  });

  it('sits after every Normal block and before the authored rules', () => {
    const { css } = published(
      root(
        box('a', { style: { color: { base: 'red', phone: 'blue' } }, effects: { hover: 'dim' } }),
        box('b', { rules: [{ id: 'r', selector: '&:hover', style: { color: 'green' } }] }),
      ),
    );
    expect(css.indexOf('.fc_fx-dim:hover')).toBeGreaterThan(css.indexOf('@media (max-width:1199.98px)'));
    expect(css.indexOf('.fc_fx-dim:hover')).toBeLessThan(css.indexOf('.fc_r-b.fc_r-b:hover'));
  });

  it('adds to the classes a node already has', () => {
    const { root: out } = published(root(box('a', { className: 'card', style: { color: { base: 'red', phone: 'blue' } }, effects: { hover: 'lift' } })));
    expect(classOf(out.children![0])).toBe('card fc-a fc_fx-lift');
  });

  it('moves nothing: Normal stays inline, with a value the sheet refuses, and the page gets no guard', () => {
    const style = { backgroundImage: 'url("data:image/svg+xml,<svg/>")', transition: 'color 1s linear', translate: '3px 4px', '--x': 'url(https://example.com/a.png)' };
    const { css, root: out } = published(root(box('a', { style, effects: { hover: 'lift' } })));
    expect((out.children![0].props as Record<string, unknown>).style).toEqual(style);
    expect(css).not.toContain('field-sizing');
  });

  it('a stored className cannot claim a preset', () => {
    const { css, root: out } = published(root(box('a', { className: 'card fc_fx-dim' })));
    expect(classOf(out.children![0])).toBe('card');
    expect(css).toBe('');
  });

  it('a text node has no element, so it takes no class and costs no text', () => {
    const { css, root: out } = published(root({ type: '#text', id: 't', props: { children: 'Hi', effects: { hover: 'dim' } } } as ComponentNode));
    expect(classOf(out.children![0])).toBeUndefined();
    expect(css).toBe('');
  });

  it('the mark never leaves the step, and a node that draws its own element still takes the class', async () => {
    const tree = root(
      box('cart', { 'data-component-kind': 'add-to-cart', effects: { hover: 'dim' } }),
      box('sticky', { [STICKY_CTA_ATTR]: STICKY_CTA_MARKER, effects: { hover: 'lift' } }),
    );
    expect(published(tree).root.children!.every(child => !('hoverPreset' in child))).toBe(true);
    const { body } = await renderPublishedPage({ root: tree, pageParams: {}, cmsRepo, breakpoints: BPS });
    const html = renderToString(<>{body}</>);
    expect(html).toMatch(/<div[^>]*class="fc_fx-dim"[^>]*data-island-pending="add-to-cart"/);
    expect(html).toMatch(/<div[^>]*class="fc_fx-lift"[^>]*>\s*(<a|<span)[^>]*data-fc-sticky-cta-link/);
  });
});
