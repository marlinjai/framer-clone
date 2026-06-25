// BindingControl token tests.
// Asserts:
//   - Broken-binding state renders with the warning token classes (not amber).
//   - Bound state renders text-brand (not warning).
//   - Unlink button calls clearBinding (the existing MST action).
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor, screen } from '@testing-library/react';
import ComponentModel from '@/models/ComponentModel';
import { getBindableSlotsFor } from '@/lib/componentRegistry';
import { DataSourceProviderContext } from '@/lib/bindings/dataSource/context';
import { InMemoryDataSourceProvider } from '@/lib/bindings/dataSource/inMemoryProvider';
import BindingControl from '../BindingControl';
import type { BindableSlotMeta } from '@/lib/bindings/types';

const SEED = {
  collections: [
    {
      id: 'col_test',
      slug: 'test',
      name: 'Test',
      columns: [
        { id: 'title', name: 'Title', type: 'text' as const },
      ],
    },
  ],
  rows: {
    col_test: [{ id: 'row_1', values: { title: 'Hello' } }],
  },
};

/** A Collection with one child Text node, wired to col_test. */
function makeTree() {
  return ComponentModel.create({
    id: 'collection-root',
    type: 'div',
    componentType: 'host',
    props: { 'data-component-kind': 'collection' },
    bindings: { collection: { mode: 'read', expression: 'col_test' } },
    children: [
      {
        id: 'text-child',
        type: 'p',
        componentType: 'host',
        props: { children: 'Hello' },
      },
    ],
  });
}

function withProvider(ui: React.ReactElement, provider: InMemoryDataSourceProvider) {
  return render(
    <DataSourceProviderContext.Provider value={provider}>
      {ui}
    </DataSourceProviderContext.Provider>,
  );
}

const TEXT_META = getBindableSlotsFor('text').children as BindableSlotMeta;

afterEach(() => cleanup());

describe('BindingControl (token safety + bind/unbind contract)', () => {
  it('bound state renders text-brand (not text-amber-*)', () => {
    const provider = new InMemoryDataSourceProvider(SEED);
    const node = makeTree().children[0];
    node.setBinding('children', { mode: 'read', expression: '{{row.title}}' });

    const { container } = withProvider(
      <BindingControl node={node} slot="children" meta={TEXT_META}>
        <input aria-label="static" />
      </BindingControl>,
      provider,
    );

    // The binding chip should use brand classes, not amber
    const chip = container.querySelector('.text-brand');
    expect(chip).toBeTruthy();

    // No amber classes anywhere in the component
    const html = container.innerHTML;
    expect(html).not.toContain('amber');
  });

  it('broken-binding state renders warning token classes (not amber)', async () => {
    const provider = new InMemoryDataSourceProvider(SEED);
    const node = makeTree().children[0];
    // Bind to a column that does not exist on col_test
    node.setBinding('children', { mode: 'read', expression: '{{row.deleted_col}}' });

    const { container } = withProvider(
      <BindingControl node={node} slot="children" meta={TEXT_META}>
        <input aria-label="static" />
      </BindingControl>,
      provider,
    );

    // Wait for column resolution
    await waitFor(() => expect(screen.getByText('column not found')).toBeTruthy());

    // Must use warning token classes, not hardcoded amber
    const html = container.innerHTML;
    expect(html).toContain('border-warning');
    expect(html).toContain('bg-warning');
    expect(html).toContain('text-warning');
    expect(html).not.toContain('amber');
  });

  it('unlink calls clearBinding and removes the binding', () => {
    const provider = new InMemoryDataSourceProvider(SEED);
    const node = makeTree().children[0];
    node.setBinding('children', { mode: 'read', expression: '{{row.title}}' });

    withProvider(
      <BindingControl node={node} slot="children" meta={TEXT_META}>
        <input aria-label="static" />
      </BindingControl>,
      provider,
    );

    fireEvent.click(screen.getByLabelText('Unbind Text'));
    // clearBinding removes the binding from the MST node
    expect(node.getBinding('children')).toBeUndefined();
  });
});
