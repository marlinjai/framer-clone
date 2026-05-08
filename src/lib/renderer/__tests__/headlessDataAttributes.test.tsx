/* eslint-disable @typescript-eslint/no-explicit-any */
// Verifies that the headless render path (HeadlessPageRenderer ->
// HeadlessComponentRenderer -> createComponentElement) emits
// `data-component-id` and `data-inner-component-id` on every host element,
// every void tag, and every FUNCTION component that spreads props to its
// root. Cross-track consumers (Lumitra Studio, drag-resolve, selection
// overlays) all key off these attributes; this test is the regression net.
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import PageModel from '@/models/PageModel';
import HeadlessPageRenderer from '../HeadlessPageRenderer';

const BP_DESKTOP = 'bp-desktop';

function makePage(appTreeSnapshot: any) {
  return PageModel.create({
    id: 'page-test',
    slug: 'test',
    metadata: {
      title: 'Test page',
      description: '',
      keywords: [],
      ogTitle: '',
      ogDescription: '',
      ogImage: '',
      canonicalUrl: '',
    },
    appComponentTree: appTreeSnapshot,
    canvasNodes: {
      'viewport-desktop': {
        id: 'viewport-desktop',
        type: 'div',
        componentType: 'host',
        canvasNodeType: 'viewport',
        label: 'Desktop',
        breakpointId: BP_DESKTOP,
        breakpointMinWidth: 1280,
        viewportWidth: 1280,
        viewportHeight: 800,
        canvasX: 0,
        canvasY: 0,
        props: {},
      },
    },
  });
}

afterEach(() => {
  cleanup();
  delete (window as any).__componentRegistry;
});

describe('HeadlessPageRenderer data-component-id emission', () => {
  it('attaches data-component-id and data-inner-component-id to every host element in a 3-node tree', () => {
    const page = makePage({
      id: 'root',
      type: 'div',
      componentType: 'host',
      canvasNodeType: 'component',
      props: {},
      children: [
        {
          id: 'child-a',
          type: 'p',
          componentType: 'host',
          canvasNodeType: 'component',
          props: { children: 'Hello' },
        },
        {
          id: 'child-b',
          type: 'section',
          componentType: 'host',
          canvasNodeType: 'component',
          props: {},
          children: [
            {
              id: 'grandchild',
              type: 'span',
              componentType: 'host',
              canvasNodeType: 'component',
              props: { children: 'nested' },
            },
          ],
        },
      ],
    });

    const { container } = render(
      <HeadlessPageRenderer page={page} breakpointId={BP_DESKTOP} />,
    );

    const expected: Record<string, string> = {
      root: 'div',
      'child-a': 'p',
      'child-b': 'section',
      grandchild: 'span',
    };

    for (const [innerId, tag] of Object.entries(expected)) {
      const el = container.querySelector(`${tag}[data-inner-component-id="${innerId}"]`);
      expect(el, `expected <${tag}> with inner id ${innerId}`).not.toBeNull();
      expect(el?.getAttribute('data-component-id')).toBe(`${BP_DESKTOP}-${innerId}`);
      expect(el?.getAttribute('data-inner-component-id')).toBe(innerId);
    }

    // Sanity: no element should be missing data-component-id.
    const allElements = Array.from(container.querySelectorAll('*'));
    for (const el of allElements) {
      expect(el.getAttribute('data-component-id')).not.toBeNull();
      expect(el.getAttribute('data-inner-component-id')).not.toBeNull();
    }
  });

  it('attaches identity attributes to void tags (img) without trying to inject children', () => {
    const page = makePage({
      id: 'root',
      type: 'div',
      componentType: 'host',
      canvasNodeType: 'component',
      props: {},
      children: [
        {
          id: 'hero-img',
          type: 'img',
          componentType: 'host',
          canvasNodeType: 'component',
          props: { src: '/a.jpg', alt: 'A' },
        },
      ],
    });

    const { container } = render(
      <HeadlessPageRenderer page={page} breakpointId={BP_DESKTOP} />,
    );

    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('data-component-id')).toBe(`${BP_DESKTOP}-hero-img`);
    expect(img?.getAttribute('data-inner-component-id')).toBe('hero-img');
    // Void tag must have no children.
    expect(img?.childNodes.length).toBe(0);
  });

  it('forwards identity attributes to FUNCTION components that spread props to their root', () => {
    // Fake registry component that spreads props to its root element. This
    // mirrors the unwritten contract that real registry entries (Container,
    // Stack, Grid, Flex, Card, etc.) must follow for identity attributes to
    // surface in the DOM.
    const FancyBox = (props: Record<string, any>) => {
      const { children, ...rest } = props;
      return (
        <section data-fancy="true" {...rest}>
          {children}
        </section>
      );
    };
    (window as any).__componentRegistry = { FancyBox };

    const page = makePage({
      id: 'root',
      type: 'div',
      componentType: 'host',
      canvasNodeType: 'component',
      props: {},
      children: [
        {
          id: 'box-1',
          type: 'FancyBox',
          componentType: 'function',
          canvasNodeType: 'component',
          props: {},
          children: [
            {
              id: 'inside',
              type: 'p',
              componentType: 'host',
              canvasNodeType: 'component',
              props: { children: 'inside fancy box' },
            },
          ],
        },
      ],
    });

    const { container } = render(
      <HeadlessPageRenderer page={page} breakpointId={BP_DESKTOP} />,
    );

    const fancy = container.querySelector('section[data-fancy="true"]');
    expect(fancy).not.toBeNull();
    expect(fancy?.getAttribute('data-component-id')).toBe(`${BP_DESKTOP}-box-1`);
    expect(fancy?.getAttribute('data-inner-component-id')).toBe('box-1');

    const inside = container.querySelector('p[data-inner-component-id="inside"]');
    expect(inside).not.toBeNull();
    expect(inside?.getAttribute('data-component-id')).toBe(`${BP_DESKTOP}-inside`);
  });
});
