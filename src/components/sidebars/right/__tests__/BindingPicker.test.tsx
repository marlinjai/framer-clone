// BindingPicker + BindingControl coverage: scope tree (Page params + LIVE row
// columns), commit via the existing setBinding, free-form parse-failure
// red-border, unlink, broken-binding warning chip, and unknown-scopeHint
// tolerance.
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor, screen } from '@testing-library/react';
import ComponentModel from '@/models/ComponentModel';
import { getBindableSlotsFor } from '@/lib/componentRegistry';
import { DataSourceProviderContext } from '@/lib/bindings/dataSource/context';
import { InMemoryDataSourceProvider } from '@/lib/bindings/dataSource/inMemoryProvider';
import BindingPicker, { visibleSectionsForHint } from '../BindingPicker';
import BindingControl from '../BindingControl';
import type { BindableSlotMeta } from '@/lib/bindings/types';

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
    col_events: [{ id: 'event_1', values: { title: 'Launch', city: 'Berlin' } }],
  },
};

// A Collection bound to col_events with a single child Text node.
function collectionWithText() {
  return ComponentModel.create({
    id: 'collection-root',
    type: 'div',
    componentType: 'host',
    props: { 'data-component-kind': 'collection' },
    bindings: { collection: { mode: 'read', expression: 'col_events' } },
    children: [
      {
        id: 'text-1',
        type: 'p',
        componentType: 'host',
        props: { children: 'Text' },
      },
    ],
  });
}

function renderWithProvider(ui: React.ReactElement, provider: InMemoryDataSourceProvider) {
  return render(
    <DataSourceProviderContext.Provider value={provider}>
      {ui}
    </DataSourceProviderContext.Provider>,
  );
}

const TEXT_META = getBindableSlotsFor('text').children as BindableSlotMeta;

afterEach(() => cleanup());

describe('visibleSectionsForHint', () => {
  it('shows the full tree for any', () => {
    expect(visibleSectionsForHint('any')).toEqual({ row: true, page: true, collections: true });
  });

  it('does NOT break on an unknown (commerce) scopeHint: default branch', () => {
    // Track C additive hints must land in the default branch, not crash.
    expect(visibleSectionsForHint('product')).toEqual({ row: true, page: true, collections: true });
    expect(visibleSectionsForHint('variant')).toEqual({ row: true, page: true, collections: true });
    expect(visibleSectionsForHint('availability')).toEqual({
      row: true,
      page: true,
      collections: true,
    });
  });

  it('narrows to a single section for the known hints', () => {
    expect(visibleSectionsForHint('row')).toEqual({ row: true, page: false, collections: false });
    expect(visibleSectionsForHint('collection')).toEqual({
      row: false,
      page: false,
      collections: true,
    });
    expect(visibleSectionsForHint('page')).toEqual({ row: false, page: true, collections: false });
  });
});

describe('BindingPicker', () => {
  it('shows Page>params and the bound collection LIVE columns as {{row.<col>}}', async () => {
    const provider = new InMemoryDataSourceProvider(EVENTS_SEED);
    const node = collectionWithText().children[0];
    renderWithProvider(
      <BindingPicker
        node={node}
        slot="children"
        meta={TEXT_META}
        onCommit={() => {}}
        onClose={() => {}}
      />,
      provider,
    );

    expect(screen.getByText('Page')).toBeTruthy();
    expect(screen.getByText('params')).toBeTruthy();

    await waitFor(() => {
      expect(screen.getByText('Title')).toBeTruthy();
      expect(screen.getByText('City')).toBeTruthy();
    });
    expect(screen.getByText('{{row.title}}')).toBeTruthy();
  });

  it('tolerates an UNKNOWN scopeHint and still renders the row columns', async () => {
    const provider = new InMemoryDataSourceProvider(EVENTS_SEED);
    const node = collectionWithText().children[0];
    const commerceMeta: BindableSlotMeta = {
      label: 'Price',
      allowedModes: ['read'],
      // Unknown to this picker; comes from Track C. Must not break the switch.
      scopeHint: 'product' as unknown as BindableSlotMeta['scopeHint'],
    };
    renderWithProvider(
      <BindingPicker
        node={node}
        slot="children"
        meta={commerceMeta}
        onCommit={() => {}}
        onClose={() => {}}
      />,
      provider,
    );
    await waitFor(() => {
      expect(screen.getByText('Title')).toBeTruthy();
    });
  });

  it('red-borders the free-form input on parse failure', () => {
    const provider = new InMemoryDataSourceProvider(EVENTS_SEED);
    const node = collectionWithText().children[0];
    renderWithProvider(
      <BindingPicker
        node={node}
        slot="children"
        meta={TEXT_META}
        onCommit={() => {}}
        onClose={() => {}}
      />,
      provider,
    );
    const input = screen.getByLabelText('Binding expression') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '{{bad expr}}' } });
    expect(input.className).toContain('border-destructive');
  });
});

describe('BindingControl', () => {
  it('clicking a column commits {mode:read, {{row.title}}} via setBinding', async () => {
    const provider = new InMemoryDataSourceProvider(EVENTS_SEED);
    const node = collectionWithText().children[0];
    renderWithProvider(
      <BindingControl node={node} slot="children" meta={TEXT_META}>
        <input aria-label="static" />
      </BindingControl>,
      provider,
    );

    fireEvent.click(screen.getByLabelText('Bind Text'));
    await waitFor(() => expect(screen.getByText('Title')).toBeTruthy());
    fireEvent.click(screen.getByText('Title'));

    expect(node.getBinding('children')).toEqual({ mode: 'read', expression: '{{row.title}}' });
  });

  it('unlink calls clearBinding', () => {
    const provider = new InMemoryDataSourceProvider(EVENTS_SEED);
    const node = collectionWithText().children[0];
    node.setBinding('children', { mode: 'read', expression: '{{row.title}}' });

    renderWithProvider(
      <BindingControl node={node} slot="children" meta={TEXT_META}>
        <input aria-label="static" />
      </BindingControl>,
      provider,
    );

    fireEvent.click(screen.getByLabelText('Unbind Text'));
    expect(node.getBinding('children')).toBeUndefined();
  });

  it('shows a `column not found` warning chip for a broken binding (no auto-migrate)', async () => {
    const provider = new InMemoryDataSourceProvider(EVENTS_SEED);
    const node = collectionWithText().children[0];
    // Bound to a column that does not exist on col_events (title / city only).
    node.setBinding('children', { mode: 'read', expression: '{{row.deleted_col}}' });

    renderWithProvider(
      <BindingControl node={node} slot="children" meta={TEXT_META}>
        <input aria-label="static" />
      </BindingControl>,
      provider,
    );

    await waitFor(() => expect(screen.getByText('column not found')).toBeTruthy());
    // No auto-migrate: the (broken) expression is left exactly as-is.
    expect(node.getBinding('children')).toEqual({
      mode: 'read',
      expression: '{{row.deleted_col}}',
    });
  });
});
