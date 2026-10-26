// The sticky call to action primitive (src/lib/stickyCta/stickyCta.ts) and its
// published rendering: the hoist (first bar to the end of the page root, at
// most one), the stylesheet (pinned below the smallest breakpoint, safe area,
// body padding, the consent banner lifted above it), unsafe values left out, and the
// server renderer's output.
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  STICKY_CTA_FALLBACK_MAX_WIDTH,
  STICKY_CTA_PINNED_ATTR,
  hoistStickyCta,
  readStickyCta,
  stickyCtaCss,
  stickyCtaMaxWidth,
  stickyCtaMeasureScript,
  treeHasStickyCta,
  type StickyCtaTreeNode,
} from '../stickyCta';
import { renderComponentNode } from '@/lib/renderer/server/renderComponentNode';
import { renderPublishedPage } from '@/lib/renderer/server/renderPublishedPage';
import { CONSENT_BANNER_ID } from '@/lib/consent/consent';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';

const bar = (id: string, props: Record<string, unknown> = {}): StickyCtaTreeNode => ({
  id,
  type: 'div',
  props: { 'data-sticky-cta': 'bar', ctaLabel: 'Book a table', ctaHref: '#booking', ...props },
  children: [],
});
const section = (id: string, children: StickyCtaTreeNode[] = []): StickyCtaTreeNode => ({ id, type: 'section', props: {}, children });

describe('hoistStickyCta', () => {
  it('moves the first bar to the end of the root and drops further ones', () => {
    const root = section('root', [section('hero', [bar('b1')]), section('menu'), bar('b2')]);
    const out = hoistStickyCta(root);
    expect(out.removed).toBe(1);
    expect(out.root.children!.map((c) => c.id)).toEqual(['hero', 'menu', 'b1']);
    expect(out.root.children![0].children).toEqual([]);
    expect(out.bar!.props![STICKY_CTA_PINNED_ATTR]).toBe('');
    // The input is not mutated.
    expect(root.children![0].children!.map((c) => c.id)).toEqual(['b1']);
    expect(treeHasStickyCta(root)).toBe(true);
  });

  it('leaves a page without a bar unchanged', () => {
    const root = section('root', [section('hero')]);
    const out = hoistStickyCta(root);
    expect(out.bar).toBeNull();
    expect(out.removed).toBe(0);
    expect(out.root.children!.map((c) => c.id)).toEqual(['hero']);
    expect(treeHasStickyCta(root)).toBe(false);
  });
});

describe('stickyCtaCss', () => {
  it('pins the bar below the second smallest breakpoint and hides it above', () => {
    const bps = [
      { id: 'd', minWidth: 1200 },
      { id: 't', minWidth: 810 },
      { id: 'm', minWidth: 0 },
    ];
    expect(stickyCtaMaxWidth(bps)).toBe(809.98);
    const css = stickyCtaCss(bps);
    expect(css.startsWith(`[${STICKY_CTA_PINNED_ATTR}]{display:none!important}`)).toBe(true);
    expect(css).toContain('@media (max-width:809.98px){');
    expect(css).toContain('position:fixed!important');
    expect(css).toContain('bottom:0!important');
    expect(css).toContain('env(safe-area-inset-bottom,0px)');
    expect(css).toContain('body{padding-bottom:var(--fc-sticky-cta-h,72px)!important}');
    // The consent banner sits above the bar, so both stay usable.
    expect(css).toContain(`#${CONSENT_BANNER_ID}{bottom:calc(var(--fc-sticky-cta-h,72px) + 12px)!important}`);
    expect(css).toMatch(/z-index:2147482000/);
  });

  it('uses the fallback width with a single breakpoint', () => {
    expect(stickyCtaMaxWidth([{ minWidth: 1280 }])).toBe(STICKY_CTA_FALLBACK_MAX_WIDTH);
    expect(stickyCtaCss([])).toContain(`(max-width:${STICKY_CTA_FALLBACK_MAX_WIDTH}px)`);
  });

  it('measures the bar into a custom property', () => {
    const script = stickyCtaMeasureScript();
    expect(script).toContain(`[${STICKY_CTA_PINNED_ATTR}]`);
    expect(script).toContain('--fc-sticky-cta-h');
    expect(script).toContain('ResizeObserver');
  });
});

describe('link checks', () => {
  it('reads a bar with unsafe values left out or defaulted', () => {
    const link = readStickyCta({ ctaLabel: '  Book  ', ctaHref: 'javascript:alert(1)', buttonBackground: 'red;x:y', buttonRadius: '4px' });
    expect(link).toEqual({
      label: 'Book',
      href: '',
      buttonBackground: '#111827',
      buttonTextColor: '#ffffff',
      buttonRadius: '4px',
    });
  });
});

describe('published rendering', () => {
  it('renders the bar with a real link and without its config props', () => {
    const html = renderToStaticMarkup(
      <>{renderComponentNode(bar('b1', { style: { backgroundColor: '#fff' }, buttonBackground: '#b45309' }) as ComponentNode)}</>,
    );
    expect(html).toContain('data-sticky-cta="bar"');
    expect(html).toContain('href="#booking"');
    expect(html).toContain('>Book a table</a>');
    expect(html).toContain('background-color:#b45309');
    expect(html).not.toMatch(/ctaLabel|ctaHref|buttonBackground/);
  });

  it('renders the label without a link when the link is not safe', () => {
    const html = renderToStaticMarkup(<>{renderComponentNode(bar('b1', { ctaHref: 'javascript:alert(1)' }) as ComponentNode)}</>);
    expect(html).not.toContain('<a');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('Book a table');
  });

  it('puts the bar last, adds its stylesheet and measurement, and renders only one', async () => {
    const root = section('root', [section('hero', [bar('b1')]), bar('b2', { ctaLabel: 'Second' })]) as ComponentNode;
    const page = await renderPublishedPage({
      root,
      pageParams: {},
      cmsRepo: {} as never,
      breakpoints: [
        { id: 'd', minWidth: 1200 },
        { id: 'm', minWidth: 0 },
      ],
    });
    const html = renderToStaticMarkup(<>{page.body}</>);
    expect(html).toContain('data-fc-sticky-cta-style');
    expect(html).toContain('@media (max-width:1199.98px)');
    expect(html).toContain('data-fc-sticky-cta-measure');
    expect(html.match(/data-sticky-cta="bar"/g)).toHaveLength(1);
    expect(html).not.toContain('Second');
    // The bar comes after the hero section in the reading order.
    expect(html.indexOf('data-sticky-cta="bar"')).toBeGreaterThan(html.indexOf('<section'));
  });

  it('adds nothing for a page without a bar', async () => {
    const page = await renderPublishedPage({ root: section('root', [section('hero')]) as ComponentNode, pageParams: {}, cmsRepo: {} as never });
    const html = renderToStaticMarkup(<>{page.body}</>);
    expect(html).not.toContain('data-fc-sticky-cta');
  });
});
