/* eslint-disable @typescript-eslint/no-explicit-any */
// Editor / headless parity: the editor `ComponentRenderer` and the
// `HeadlessComponentRenderer` must produce IDENTICAL structure + resolved
// content for the same BOUND data tree. The editor adds non-DOM chrome (event
// handlers, pointer-events) so we compare the meaningful output: the ordered
// list of (tag, data-inner-component-id) plus each element's resolved text.
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import ComponentModel from '@/models/ComponentModel';
import EditorComponentRenderer from '@/components/ComponentRenderer';
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
      columns: [{ id: 'title', name: 'Title', type: 'text' as const }],
    },
  ],
  rows: {
    col_events: [
      { id: 'event_1', values: { title: 'Launch' } },
      { id: 'event_2', values: { title: 'Demo' } },
    ],
  },
};

function makeBoundCollection() {
  return ComponentModel.create({
    id: 'collection-1',
    type: 'div',
    componentType: 'host',
    props: { 'data-component-kind': 'collection' },
    bindings: { collection: { mode: 'read', expression: 'col_events' } },
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

// Normalized structure: ordered (tag, innerId, text) for every identified
// element. Editor-only attributes (handlers, pointer-events) are ignored.
function normalize(container: HTMLElement) {
  return Array.from(container.querySelectorAll('[data-inner-component-id]')).map((el) => ({
    tag: el.tagName.toLowerCase(),
    innerId: el.getAttribute('data-inner-component-id'),
    componentId: el.getAttribute('data-component-id'),
    text: el.textContent,
  }));
}

afterEach(() => {
  cleanup();
  delete (window as any).__componentRegistry;
});

describe('editor / headless parity for bound data tree', () => {
  it('produces identical structure + resolved content in both renderers', async () => {
    const editorProvider = new InMemoryDataSourceProvider(EVENTS_SEED);
    const headlessProvider = new InMemoryDataSourceProvider(EVENTS_SEED);

    const editor = render(
      <DataSourceProviderContext.Provider value={editorProvider}>
        <EditorComponentRenderer
          component={makeBoundCollection()}
          breakpointId={BP}
          allBreakpoints={ALL_BP}
          primaryId={BP}
          scope={createScope()}
        />
      </DataSourceProviderContext.Provider>,
    );

    const headless = render(
      <DataSourceProviderContext.Provider value={headlessProvider}>
        <HeadlessComponentRenderer
          component={makeBoundCollection()}
          breakpointId={BP}
          allBreakpoints={ALL_BP}
          primaryId={BP}
          scope={createScope()}
        />
      </DataSourceProviderContext.Provider>,
    );

    await waitFor(() => {
      expect(
        editor.container.querySelectorAll('span[data-inner-component-id="tpl-title"]').length,
      ).toBe(2);
      expect(
        headless.container.querySelectorAll('span[data-inner-component-id="tpl-title"]').length,
      ).toBe(2);
    });

    expect(normalize(editor.container)).toEqual(normalize(headless.container));
    expect(editor.container.textContent).toBe(headless.container.textContent);
  });
});
