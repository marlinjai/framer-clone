// applyResponsiveStyles + the published render: responsive styles leave the
// inline style for a per-page stylesheet keyed by a stable class per node, and
// the published HTML carries both (plan decision 5).
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ComponentNode, CommerceServerRepository } from '@/lib/renderer/publish/hydrateBindings';
import type { CmsReadRepository } from '@/server/cms';
import type { BreakpointRef } from '@/lib/responsive/cascade';
import { applyResponsiveStyles } from '../applyResponsiveStyles';
import { nodeDomProps } from '../renderComponentNode';
import { renderPublishedPage } from '../renderPublishedPage';
import { extractBreakpoints } from '../snapshotToComponentNode';

afterEach(() => {
  vi.restoreAllMocks();
});

const BPS: BreakpointRef[] = [
  { id: 'bp-desktop', minWidth: 1200 },
  { id: 'bp-tablet', minWidth: 810 },
  { id: 'bp-phone', minWidth: 390 },
];

describe('applyResponsiveStyles', () => {
  it('gives a node with a responsive style a class, merges className and moves all its styles', () => {
    const root: ComponentNode = {
      type: 'div',
      id: 'hero',
      props: {
        className: 'hero',
        style: { padding: '8px', color: { base: 'black', 'bp-tablet': 'red' } },
      },
    };
    const { root: out, css } = applyResponsiveStyles(root, BPS);
    expect(out.props).toEqual({ className: 'hero fc-hero' });
    expect(css).toBe(
      '.fc-hero.fc-hero{padding:8px;color:black}\n' +
        '@media (max-width:1199.98px){\n.fc-hero.fc-hero{color:red}\n}',
    );
    // The input tree is not mutated.
    expect((root.props as Record<string, unknown>).style).toBeDefined();
  });

  it('leaves a node with only plain styles inline and untouched', () => {
    const root: ComponentNode = { type: 'p', id: 'p', props: { style: { color: 'red', margin: 0 } } };
    const { root: out, css } = applyResponsiveStyles(root, BPS);
    expect(out.props).toEqual({ style: { color: 'red', margin: 0 } });
    expect(css).toBe('');
  });

  it('resolves a responsive attribute to the largest breakpoint value', () => {
    const root: ComponentNode = {
      type: 'img',
      id: 'img',
      props: { alt: { base: 'Wide', 'bp-phone': 'Narrow' }, src: { 'bp-desktop': '/a.png', base: '/b.png' } },
    };
    expect(applyResponsiveStyles(root, BPS).root.props).toEqual({ alt: 'Wide', src: '/a.png' });
  });

  it('shares one class across cloned rows with identical styles and numbers a differing one', () => {
    const row = (color: string): ComponentNode => ({
      type: 'p',
      id: 'tpl',
      props: { children: 'x', style: { color: { base: color, 'bp-phone': 'gray' } } },
    });
    const root: ComponentNode = { type: 'div', id: 'list', children: [row('red'), row('red'), row('blue')] };
    const { root: out, css } = applyResponsiveStyles(root, BPS);
    const classes = out.children!.map(c => (c.props as Record<string, unknown>).className);
    expect(classes).toEqual(['fc-tpl', 'fc-tpl', 'fc-tpl--2']);
    expect(css).toBe(
      '.fc-tpl.fc-tpl{color:red}\n.fc-tpl--2.fc-tpl--2{color:blue}\n' +
        '@media (max-width:809.98px){\n.fc-tpl.fc-tpl{color:gray}\n.fc-tpl--2.fc-tpl--2{color:gray}\n}',
    );
  });

  it('never reuses a class name, even when an id looks like a suffixed or anonymous one', () => {
    const styled = (id: string | undefined, color: string): ComponentNode => ({
      type: 'div',
      ...(id ? { id } : {}),
      props: { style: { color: { base: color } } },
    });
    const root: ComponentNode = {
      type: 'div',
      children: [styled('a', 'red'), styled('a', 'blue'), styled('a--2', 'green'), styled(undefined, 'pink'), styled('anon-1', 'teal'), styled('a b', 'gold')],
    };
    const { root: out } = applyResponsiveStyles(root, BPS);
    const classes = out.children!.map(c => (c.props as Record<string, unknown>).className);
    expect(classes).toEqual(['fc-a', 'fc-a--2', 'fc-a--2_', 'fc-anon-1', 'fc-anon-1--2', 'fc-a_b']);
    expect(new Set(classes).size).toBe(classes.length);
  });

  it('passes the class (and no inline responsive map) to a commerce island through nodeDomProps', () => {
    const root: ComponentNode = {
      type: 'div',
      id: 'cart',
      props: { 'data-component-kind': 'cart-view', style: { width: { base: '50%', 'bp-phone': '100%' } } },
    };
    const props = nodeDomProps(applyResponsiveStyles(root, BPS).root);
    expect(props.className).toBe('fc-cart');
    expect(props.style).toBeUndefined();
  });

  it('logs dropped unsafe declarations once per page', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const root: ComponentNode = {
      type: 'div',
      children: [
        { type: 'div', id: 'a', props: { style: { color: { base: 'red}x{' } } } },
        { type: 'div', id: 'b', props: { style: { color: { base: 'a</style>' } } } },
      ],
    };
    const { css } = applyResponsiveStyles(root, BPS);
    expect(css).toBe('');
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('extractBreakpoints', () => {
  it('reads viewport canvas nodes, skips others and malformed ones, dedupes and sorts largest first', () => {
    expect(
      extractBreakpoints({
        v1: { canvasNodeType: 'viewport', breakpointId: 'bp-phone', breakpointMinWidth: 390 },
        v2: { canvasNodeType: 'viewport', breakpointId: 'bp-desktop', breakpointMinWidth: 1200 },
        v3: { canvasNodeType: 'viewport', breakpointId: 'bp-phone', breakpointMinWidth: 400 },
        f1: { canvasNodeType: 'floating', breakpointId: 'x', breakpointMinWidth: 10 },
        v4: { canvasNodeType: 'viewport', breakpointId: 'bp-bad' },
      }),
    ).toEqual([
      { id: 'bp-desktop', minWidth: 1200 },
      { id: 'bp-phone', minWidth: 390 },
    ]);
    expect(extractBreakpoints(undefined)).toEqual([]);
  });
});

describe('renderPublishedPage: responsive styles', () => {
  const cmsRepo = {
    listRows: async () => ({ rows: [], total: 0 }),
    getRow: async () => null,
  } as unknown as CmsReadRepository;
  const commerceRepo = {
    listProducts: async () => ({ products: [], total: 0 }),
    getProductByHandle: async () => null,
    listVariants: async () => [],
    getPrices: async () => [],
    getAvailability: async () => ({ variantId: 'x', locationId: 'all', availableQuantity: 0, stale: false }),
  } as CommerceServerRepository;

  it('publishes the class and a style tag with the media queries, never an inline responsive map', async () => {
    const root: ComponentNode = {
      type: 'div',
      id: 'root',
      children: [
        {
          type: 'h1',
          id: 'title',
          props: {
            children: 'Hello',
            style: {
              color: { base: 'black', 'bp-desktop': 'red' },
              fontSize: { base: '', 'bp-tablet': '20px', 'bp-phone': '16px' },
            },
          },
        },
        { type: 'p', id: 'plain', props: { children: 'Plain', style: { margin: 0 } } },
      ],
    };
    const { body } = await renderPublishedPage({
      root,
      pageParams: {},
      cmsRepo,
      commerceRepo,
      breakpoints: BPS,
    });
    const html = renderToStaticMarkup(<>{body}</>);
    expect(html).toContain(
      '<style data-fc-responsive="">.fc-title.fc-title{color:red}\n' +
        '@media (max-width:1199.98px){\n.fc-title.fc-title{font-size:20px}\n}\n' +
        '@media (max-width:809.98px){\n.fc-title.fc-title{font-size:16px}\n}</style>',
    );
    expect(html).toContain('<h1 class="fc-title">Hello</h1>');
    expect(html).toContain('<p style="margin:0">Plain</p>');
    // The style tag comes before the content it styles.
    expect(html.indexOf('<style data-fc-responsive')).toBeLessThan(html.indexOf('<h1'));
    // One responsive stylesheet (the other style tag hides cookie-settings links on a
    // site where nothing needs consent, src/lib/consent/consent.ts).
    expect(html.match(/<style data-fc-responsive/g)).toHaveLength(1);
  });

  it('emits no style tag when the page has no responsive style', async () => {
    const { body } = await renderPublishedPage({
      root: { type: 'div', id: 'r', props: { style: { color: 'red' } } },
      pageParams: {},
      cmsRepo,
      commerceRepo,
      breakpoints: BPS,
    });
    const html = renderToStaticMarkup(<>{body}</>);
    expect(html).not.toContain('<style data-fc-responsive');
    expect(html).toContain('<div style="color:red"></div>');
  });
});
