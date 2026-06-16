/* eslint-disable @typescript-eslint/no-explicit-any */
// TableViewRenderer behaviour, exercised through the headless host renderer
// (HeadlessComponentRenderer -> createComponentElement -> TableViewRenderer)
// so the `table-view` dispatch path is covered end to end (the branch reserved
// in slice2-read-only-data-components now routes to the real renderer).
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, waitFor, act } from '@testing-library/react';
import ComponentModel from '@/models/ComponentModel';
import HeadlessComponentRenderer from '@/lib/renderer/HeadlessComponentRenderer';
import { DataSourceProviderContext } from '@/lib/bindings/dataSource/context';
import { InMemoryDataSourceProvider } from '@/lib/bindings/dataSource/inMemoryProvider';
import { createScope } from '@/lib/bindings/resolver/scope';

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
      { id: 'event_3', values: { title: 'Workshop', city: 'Hamburg' } },
    ],
  },
};

// A table-view node bound to col_events. The table renders columns + rows from
// the resolved collection; it has no per-row child template (unlike Collection).
function makeTableNode(opts: { bound?: boolean } = {}) {
  const { bound = true } = opts;
  return ComponentModel.create({
    id: 'table-1',
    type: 'div',
    componentType: 'host',
    props: { 'data-component-kind': 'table-view' },
    bindings: bound
      ? { collection: { mode: 'read', expression: 'col_events' } }
      : {},
    children: [],
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

describe('TableViewRenderer', () => {
  it('renders columns + rows matching the resolved collection (read-only)', async () => {
    const provider = new InMemoryDataSourceProvider(EVENTS_SEED);
    const { container } = renderHeadless(makeTableNode(), provider);

    await waitFor(() => {
      expect(container.textContent).toContain('Launch');
    });

    const text = container.textContent || '';
    // Column headers from the resolved collection.
    expect(text).toContain('Title');
    expect(text).toContain('City');
    // Every cell value from every row.
    for (const value of [
      'Launch',
      'Berlin',
      'Demo',
      'Munich',
      'Workshop',
      'Hamburg',
    ]) {
      expect(text).toContain(value);
    }

    // Read-only: the published TableView must not render editable controls.
    expect(
      container.querySelectorAll('input, textarea, [contenteditable="true"]')
        .length,
    ).toBe(0);

    // The host wrapper keeps its identity attribute (dispatch parity with the
    // Collection / RecordView branches).
    expect(
      container.querySelector('div[data-inner-component-id="table-1"]'),
    ).not.toBeNull();
  });

  it('re-renders when the data source signals a change (subscribe)', async () => {
    const provider = new InMemoryDataSourceProvider(EVENTS_SEED);
    const { container } = renderHeadless(makeTableNode(), provider);

    await waitFor(() => {
      expect(container.textContent).toContain('Workshop');
    });
    expect(container.textContent).not.toContain('Meetup');

    act(() => {
      provider._mutate((seed) => {
        seed.rows.col_events.push({
          id: 'event_4',
          values: { title: 'Meetup', city: 'Cologne' },
        });
      });
    });

    await waitFor(() => {
      expect(container.textContent).toContain('Meetup');
    });
    expect(container.textContent).toContain('Cologne');
  });

  it('surfaces a configuration note (never a silent success) when bound but no collection resolves', async () => {
    const provider = new InMemoryDataSourceProvider(EVENTS_SEED);
    // Bound (so dispatch fires) but to a slot that does not resolve to an id.
    const node = ComponentModel.create({
      id: 'table-badbind',
      type: 'div',
      componentType: 'host',
      props: { 'data-component-kind': 'table-view' },
      bindings: { filter: { mode: 'read', expression: '{{row.nope}}' } },
      children: [],
    });
    const { container } = renderHeadless(node, provider);
    await waitFor(() => {
      expect(container.textContent).toContain('no source collection bound');
    });
  });

  it('shows the dashed-box placeholder when UNBOUND', () => {
    const provider = new InMemoryDataSourceProvider(EVENTS_SEED);
    const { container } = renderHeadless(makeTableNode({ bound: false }), provider);
    expect(container.textContent).toContain('Table view (no binding)');
  });
});
