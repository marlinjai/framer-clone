// Parity between the build-time hydrator and the live preview render.
//
// The whole point of hydrateBindings is that the static-publish output is the
// SAME tree the preview renders, just resolved eagerly in Node instead of
// lazily via React effects. This suite proves that: it renders a bound tree via
// HeadlessPageRenderer (the live preview path, fed by an in-memory provider) and
// asserts the resulting DOM textContent equals nodeTextContent of the SAME tree
// hydrated by hydrateBindings (fed by the SAME provider as a CmsReadRepository).
//
// Runs under jsdom (the default project) because the live path renders React and
// relies on effects + a real DOM; the hydrator side stays React-free.
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import PageModel from '@/models/PageModel';
import HeadlessPageRenderer from '@/lib/renderer/HeadlessPageRenderer';
import { DataSourceProviderContext } from '@/lib/bindings/dataSource/context';
import { InMemoryDataSourceProvider } from '@/lib/bindings/dataSource/inMemoryProvider';
import {
  hydrateBindings,
  nodeTextContent,
  type ComponentNode,
} from '@/lib/renderer/publish/hydrateBindings';
import type { CmsReadRepository } from '@/server/cms';
import type { Row } from '@/lib/bindings/dataSource/types';

const BP = 'bp-desktop';

const EVENTS: Row[] = [
  { id: 'event_1', values: { title: 'Launch', city: 'Berlin' } },
  { id: 'event_2', values: { title: 'Demo', city: 'Munich' } },
  { id: 'event_3', values: { title: 'Workshop', city: 'Berlin' } },
];

function seed(rows: Row[]) {
  return {
    collections: [
      {
        id: 'col_events',
        slug: 'events',
        name: 'Events',
        columns: [
          { id: 'title', name: 'Title', type: 'text' as const },
          { id: 'city', name: 'City', type: 'text' as const },
        ],
      },
    ],
    rows: { col_events: rows },
  };
}

// A root div containing a Collection bound to col_events whose per-row template
// is a div with two field-bound spans (title + city). Shared verbatim by both
// the live render and the hydrator so the comparison is apples-to-apples.
function makeBoundTree(extraCollectionProps: Record<string, unknown> = {}) {
  return {
    id: 'root',
    type: 'div',
    componentType: 'host',
    canvasNodeType: 'component',
    props: {},
    children: [
      {
        id: 'events-collection',
        type: 'div',
        componentType: 'host',
        canvasNodeType: 'component',
        props: { 'data-component-kind': 'collection', ...extraCollectionProps },
        bindings: { collection: { mode: 'read', expression: 'col_events' } },
        children: [
          {
            id: 'card',
            type: 'div',
            componentType: 'host',
            canvasNodeType: 'component',
            props: {},
            children: [
              {
                id: 'card-title',
                type: 'span',
                componentType: 'host',
                canvasNodeType: 'component',
                props: {},
                bindings: { children: { mode: 'read', expression: '{{row.title}}' } },
              },
              {
                id: 'card-city',
                type: 'span',
                componentType: 'host',
                canvasNodeType: 'component',
                props: {},
                bindings: { children: { mode: 'read', expression: '{{row.city}}' } },
              },
            ],
          },
        ],
      },
    ],
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
        breakpointId: BP,
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

async function previewTextContent(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  appTree: any,
  provider: InMemoryDataSourceProvider,
  expectedSpanCount: number,
): Promise<string> {
  const page = makePage(appTree);
  const { container } = render(
    React.createElement(
      DataSourceProviderContext.Provider,
      { value: provider },
      React.createElement(HeadlessPageRenderer, { page, breakpointId: BP }),
    ),
  );
  await waitFor(() => {
    expect(container.querySelectorAll('span').length).toBe(expectedSpanCount);
  });
  return container.textContent ?? '';
}

afterEach(() => {
  cleanup();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (window as any).__componentRegistry;
});

describe('hydrateBindings parity with HeadlessPageRenderer', () => {
  it('hydrated text content matches the preview render of a populated Collection', async () => {
    const provider = new InMemoryDataSourceProvider(seed(EVENTS));
    const appTree = makeBoundTree();

    // Live preview: 3 rows x 2 field spans = 6 spans.
    const previewText = await previewTextContent(appTree, provider, 6);

    // Build-time hydration of the SAME tree via the SAME provider (which
    // satisfies the CmsReadRepository read surface).
    const hydrated = await hydrateBindings(
      appTree as unknown as ComponentNode,
      {},
      { cmsRepo: provider as unknown as CmsReadRepository },
    );

    expect(nodeTextContent(hydrated)).toBe(previewText);
    expect(previewText).toBe('LaunchBerlinDemoMunichWorkshopBerlin');
  });

  it('hydrated text content matches the preview render of an empty Collection (emptyContent)', async () => {
    const provider = new InMemoryDataSourceProvider(seed([]));
    const appTree = makeBoundTree({ emptyContent: 'No events yet' });

    // Empty render: the configured emptyContent sits in a single note span.
    const previewText = await previewTextContent(appTree, provider, 1);

    const hydrated = await hydrateBindings(
      appTree as unknown as ComponentNode,
      {},
      { cmsRepo: provider as unknown as CmsReadRepository },
    );

    expect(nodeTextContent(hydrated)).toBe(previewText);
    expect(previewText).toBe('No events yet');
  });
});
