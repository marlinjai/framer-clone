/* eslint-disable @typescript-eslint/no-explicit-any */
// CollectionRenderer behaviour, exercised through the headless host renderer
// (HeadlessComponentRenderer -> createComponentElement -> CollectionRenderer)
// so the dispatch path is covered end to end.
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, waitFor, act } from '@testing-library/react';
import ComponentModel from '@/models/ComponentModel';
import HeadlessComponentRenderer from '@/lib/renderer/HeadlessComponentRenderer';
import { DataSourceProviderContext } from '@/lib/bindings/dataSource/context';
import { InMemoryDataSourceProvider } from '@/lib/bindings/dataSource/inMemoryProvider';
import { createScope } from '@/lib/bindings/resolver/scope';
import type { Query } from '@/lib/bindings/dataSource/types';

const BP = 'bp';
const ALL_BP = [{ id: BP, minWidth: 0, label: 'BP' }];

const EVENTS_SEED = {
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
  rows: {
    col_events: [
      { id: 'event_1', values: { title: 'Launch', city: 'Berlin' } },
      { id: 'event_2', values: { title: 'Demo', city: 'Munich' } },
      { id: 'event_3', values: { title: 'Workshop', city: 'Berlin' } },
    ],
  },
};

// A Collection node bound to col_events whose first child is the per-row
// template: a span bound to {{row.title}}.
function makeCollectionNode(opts: { bound?: boolean; query?: Query } = {}) {
  const { bound = true, query } = opts;
  return ComponentModel.create({
    id: 'collection-1',
    type: 'div',
    componentType: 'host',
    props: {
      'data-component-kind': 'collection',
      ...(query ? { query } : {}),
    },
    bindings: bound ? { collection: { mode: 'read', expression: 'col_events' } } : {},
    children: [
      {
        id: 'tpl-title',
        type: 'span',
        componentType: 'host',
        props: {},
        bindings: { children: { mode: 'read', expression: '{{row.title}}' } },
      },
    ],
  });
}

function renderHeadless(node: any, provider: InMemoryDataSourceProvider) {
  return render(
    <DataSourceProviderContext.Provider value={provider}>
      <HeadlessComponentRenderer
        component={node}
        breakpointId={BP}
        allBreakpoints={ALL_BP}
        primaryId={BP}
        scope={createScope()}
      />
    </DataSourceProviderContext.Provider>,
  );
}

afterEach(() => {
  cleanup();
  delete (window as any).__componentRegistry;
});

describe('CollectionRenderer', () => {
  it('renders one template instance per row with {{row.field}} resolved', async () => {
    const provider = new InMemoryDataSourceProvider(EVENTS_SEED);
    const { container } = renderHeadless(makeCollectionNode(), provider);

    await waitFor(() => {
      const spans = container.querySelectorAll('span[data-inner-component-id="tpl-title"]');
      expect(spans.length).toBe(3);
    });

    const texts = Array.from(
      container.querySelectorAll('span[data-inner-component-id="tpl-title"]'),
    ).map((el) => el.textContent);
    expect(texts).toEqual(['Launch', 'Demo', 'Workshop']);
  });

  it('narrows rendered rows when a filter is set on props.query', async () => {
    const provider = new InMemoryDataSourceProvider(EVENTS_SEED);
    const query: Query = { filter: [{ column: 'city', op: 'eq', value: 'Berlin' }] };
    const { container } = renderHeadless(makeCollectionNode({ query }), provider);

    await waitFor(() => {
      const spans = container.querySelectorAll('span[data-inner-component-id="tpl-title"]');
      expect(spans.length).toBe(2);
    });
    const texts = Array.from(
      container.querySelectorAll('span[data-inner-component-id="tpl-title"]'),
    ).map((el) => el.textContent);
    expect(texts).toEqual(['Launch', 'Workshop']);
  });

  it('re-renders when the data source signals a change (subscribe)', async () => {
    const provider = new InMemoryDataSourceProvider(EVENTS_SEED);
    const { container } = renderHeadless(makeCollectionNode(), provider);

    await waitFor(() => {
      expect(
        container.querySelectorAll('span[data-inner-component-id="tpl-title"]').length,
      ).toBe(3);
    });

    act(() => {
      provider._mutate((seed) => {
        seed.rows.col_events.push({
          id: 'event_4',
          values: { title: 'Meetup', city: 'Hamburg' },
        });
      });
    });

    await waitFor(() => {
      expect(
        container.querySelectorAll('span[data-inner-component-id="tpl-title"]').length,
      ).toBe(4);
    });
  });

  it('shows the dashed-box placeholder only when UNBOUND', () => {
    const provider = new InMemoryDataSourceProvider(EVENTS_SEED);
    // Unbound: no bindings and no children so the wave-1 placeholder branch fires.
    const node = ComponentModel.create({
      id: 'collection-unbound',
      type: 'div',
      componentType: 'host',
      props: { 'data-component-kind': 'collection' },
      bindings: {},
      children: [],
    });
    const { container } = renderHeadless(node, provider);
    expect(container.textContent).toContain('Collection (no binding)');
  });

  it('surfaces a configuration note (never a silent success) when bound but no collection resolves', async () => {
    const provider = new InMemoryDataSourceProvider(EVENTS_SEED);
    // Bound (so dispatch fires) but to a slot that does not resolve to an id.
    const node = ComponentModel.create({
      id: 'collection-badbind',
      type: 'div',
      componentType: 'host',
      props: { 'data-component-kind': 'collection' },
      bindings: { filter: { mode: 'read', expression: '{{row.nope}}' } },
      children: [
        {
          id: 'tpl-x',
          type: 'span',
          componentType: 'host',
          props: {},
          bindings: { children: { mode: 'read', expression: '{{row.title}}' } },
        },
      ],
    });
    const { container } = renderHeadless(node, provider);
    await waitFor(() => {
      expect(container.textContent).toContain('no source collection bound');
    });
    expect(
      container.querySelectorAll('span[data-inner-component-id="tpl-x"]').length,
    ).toBe(0);
  });
});
