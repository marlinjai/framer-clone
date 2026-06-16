// QueryBuilder coverage: add / remove filter and sort, and limit, all written
// to node.props.query through the new setQuery MST action.
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor, screen } from '@testing-library/react';
import ComponentModel from '@/models/ComponentModel';
import { DataSourceProviderContext } from '@/lib/bindings/dataSource/context';
import { InMemoryDataSourceProvider } from '@/lib/bindings/dataSource/inMemoryProvider';
import QueryBuilder from '../QueryBuilder';
import type { Query } from '@/lib/bindings/dataSource/types';

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
  rows: { col_events: [{ id: 'event_1', values: { title: 'Launch', city: 'Berlin' } }] },
};

function collectionNode() {
  return ComponentModel.create({
    id: 'collection-root',
    type: 'div',
    componentType: 'host',
    props: { 'data-component-kind': 'collection' },
    bindings: { collection: { mode: 'read', expression: 'col_events' } },
    children: [],
  });
}

function queryOf(node: ReturnType<typeof collectionNode>): Query | undefined {
  return (node.props as Record<string, unknown>).query as Query | undefined;
}

function renderQB(node: ReturnType<typeof collectionNode>, provider: InMemoryDataSourceProvider) {
  return render(
    <DataSourceProviderContext.Provider value={provider}>
      <QueryBuilder node={node} />
    </DataSourceProviderContext.Provider>,
  );
}

afterEach(() => cleanup());

describe('QueryBuilder', () => {
  it('adds and removes a filter, writing props.query via setQuery', async () => {
    const provider = new InMemoryDataSourceProvider(EVENTS_SEED);
    const node = collectionNode();
    renderQB(node, provider);

    fireEvent.click(screen.getByLabelText('Add filter'));
    expect(queryOf(node)?.filter?.length).toBe(1);

    // Columns resolve LIVE into the new row's column select.
    await waitFor(() => expect(screen.getByRole('option', { name: 'City' })).toBeTruthy());

    fireEvent.change(screen.getByLabelText('Filter column'), { target: { value: 'city' } });
    fireEvent.change(screen.getByLabelText('Filter operator'), { target: { value: 'eq' } });
    fireEvent.change(screen.getByLabelText('Filter value'), { target: { value: 'Berlin' } });

    expect(queryOf(node)?.filter?.[0]).toEqual({ column: 'city', op: 'eq', value: 'Berlin' });

    fireEvent.click(screen.getByLabelText('Remove filter'));
    expect(queryOf(node)?.filter).toBeUndefined();
  });

  it('adds and removes a sort, writing props.query via setQuery', async () => {
    const provider = new InMemoryDataSourceProvider(EVENTS_SEED);
    const node = collectionNode();
    renderQB(node, provider);

    fireEvent.click(screen.getByLabelText('Add sort'));
    expect(queryOf(node)?.sort?.length).toBe(1);

    await waitFor(() => expect(screen.getByRole('option', { name: 'Title' })).toBeTruthy());

    fireEvent.change(screen.getByLabelText('Sort column'), { target: { value: 'title' } });
    fireEvent.change(screen.getByLabelText('Sort direction'), { target: { value: 'desc' } });
    expect(queryOf(node)?.sort?.[0]).toEqual({ column: 'title', direction: 'desc' });

    fireEvent.click(screen.getByLabelText('Remove sort'));
    expect(queryOf(node)?.sort).toBeUndefined();
  });

  it('writes a numeric limit via setQuery and clears it when emptied', async () => {
    const provider = new InMemoryDataSourceProvider(EVENTS_SEED);
    const node = collectionNode();
    renderQB(node, provider);

    const limit = screen.getByLabelText('Limit');
    fireEvent.change(limit, { target: { value: '5' } });
    expect(queryOf(node)?.limit).toBe(5);

    fireEvent.change(limit, { target: { value: '' } });
    expect(queryOf(node)?.limit).toBeUndefined();
  });

  it('prompts to bind a source collection when none is bound', () => {
    const provider = new InMemoryDataSourceProvider(EVENTS_SEED);
    const node = ComponentModel.create({
      id: 'collection-unbound',
      type: 'div',
      componentType: 'host',
      props: { 'data-component-kind': 'collection' },
      bindings: {},
      children: [],
    });
    renderQB(node, provider);
    expect(screen.getByText(/Bind a source collection/i)).toBeTruthy();
  });
});
