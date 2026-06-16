/* eslint-disable @typescript-eslint/no-explicit-any */
// RecordViewRenderer behaviour, exercised through the headless host renderer.
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import ComponentModel from '@/models/ComponentModel';
import HeadlessComponentRenderer from '@/lib/renderer/HeadlessComponentRenderer';
import { DataSourceProviderContext } from '@/lib/bindings/dataSource/context';
import { InMemoryDataSourceProvider } from '@/lib/bindings/dataSource/inMemoryProvider';
import { createScope, pushPageFrame } from '@/lib/bindings/resolver/scope';

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
    ],
  },
};

// A RecordView bound to col_events; its children resolve {{row.*}} against
// the single resolved record.
function makeRecordViewNode() {
  return ComponentModel.create({
    id: 'record-1',
    type: 'div',
    componentType: 'host',
    props: { 'data-component-kind': 'record-view' },
    bindings: { record: { mode: 'read', expression: 'col_events' } },
    children: [
      {
        id: 'rv-title',
        type: 'h1',
        componentType: 'host',
        props: {},
        bindings: { children: { mode: 'read', expression: '{{row.title}}' } },
      },
      {
        id: 'rv-city',
        type: 'span',
        componentType: 'host',
        props: {},
        bindings: { children: { mode: 'read', expression: '{{row.city}}' } },
      },
    ],
  });
}

function renderWithId(id: string | undefined, provider: InMemoryDataSourceProvider) {
  const scope = pushPageFrame(createScope(), id ? { id } : {});
  return render(
    <DataSourceProviderContext.Provider value={provider}>
      <HeadlessComponentRenderer
        component={makeRecordViewNode()}
        breakpointId={BP}
        allBreakpoints={ALL_BP}
        primaryId={BP}
        scope={scope}
      />
    </DataSourceProviderContext.Provider>,
  );
}

afterEach(() => {
  cleanup();
  delete (window as any).__componentRegistry;
});

describe('RecordViewRenderer', () => {
  it('resolves the row named by {{page.params.id}} and exposes {{row.*}} to descendants', async () => {
    const provider = new InMemoryDataSourceProvider(EVENTS_SEED);
    const { container } = renderWithId('event_2', provider);

    await waitFor(() => {
      const title = container.querySelector('h1[data-inner-component-id="rv-title"]');
      expect(title?.textContent).toBe('Demo');
    });
    const city = container.querySelector('span[data-inner-component-id="rv-city"]');
    expect(city?.textContent).toBe('Munich');
  });

  it('hits the empty path (never a silent success) for a non-existent id', async () => {
    const provider = new InMemoryDataSourceProvider(EVENTS_SEED);
    const { container } = renderWithId('does_not_exist', provider);

    await waitFor(() => {
      expect(container.textContent).toContain('Record not found');
    });
    expect(container.querySelector('h1[data-inner-component-id="rv-title"]')).toBeNull();
  });

  it('shows the empty/no-record path when no id is present in scope', async () => {
    const provider = new InMemoryDataSourceProvider(EVENTS_SEED);
    const { container } = renderWithId(undefined, provider);

    await waitFor(() => {
      expect(container.textContent).toContain('no record selected');
    });
    expect(container.querySelector('h1[data-inner-component-id="rv-title"]')).toBeNull();
  });
});
