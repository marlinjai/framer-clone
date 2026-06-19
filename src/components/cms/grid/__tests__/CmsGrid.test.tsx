import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import type { DatabaseAdapter } from '@marlinjai/data-table-core';

// Stop the real server-actions chain (server-only + Prisma) from loading when
// CmsGrid builds its module-level default adapter. The default is never exercised
// (the test injects its own adapter), but the named exports must exist so the
// adapter constructor can read them.
vi.mock('@/server/cms/actions', () => {
  const mod: Record<string, unknown> = {};
  for (const name of [
    'createTable', 'getTable', 'updateTable', 'deleteTable', 'listTables',
    'createColumn', 'getColumns', 'getColumn', 'updateColumn', 'deleteColumn', 'reorderColumns',
    'createSelectOption', 'getSelectOptions', 'updateSelectOption', 'deleteSelectOption', 'reorderSelectOptions',
    'createRow', 'getRow', 'getRows', 'updateRow', 'deleteRow', 'archiveRow', 'unarchiveRow',
    'bulkCreateRows', 'bulkDeleteRows', 'bulkArchiveRows',
    'createRelation', 'deleteRelation', 'getRelatedRows', 'getRelationsForRow',
    'addFileReference', 'removeFileReference', 'getFileReferences', 'reorderFileReferences',
    'createView', 'getViews', 'getView', 'updateView', 'deleteView', 'reorderViews',
  ]) {
    mod[name] = vi.fn();
  }
  return mod;
});

// Replace ONLY TableView with a controllable stub: it renders the columns/rows
// it receives (so we can assert real data flowed through the adapter -> useTable
// -> TableView), and exposes buttons that invoke the wiring we care about. The
// provider, useTable, useDbAdapter, SearchBar and FilterBar stay REAL, so this
// exercises the full integration path without depending on the engine's grid DOM.
vi.mock('@marlinjai/data-table-react', async (orig) => {
  const actual = await orig<typeof import('@marlinjai/data-table-react')>();
  const React = await import('react');
  function MockTableView(props: {
    columns: Array<{ id: string; name: string }>;
    rows: Array<{ id: string; cells: Record<string, unknown> }>;
    onAddProperty?: (name: string, type: string) => void;
    onCellChange?: (rowId: string, columnId: string, value: unknown) => void;
  }) {
    return React.createElement(
      'div',
      { 'data-testid': 'mock-tableview' },
      React.createElement(
        'div',
        { 'data-testid': 'tv-columns' },
        props.columns.map((c) => c.name).join(','),
      ),
      React.createElement(
        'div',
        { 'data-testid': 'tv-rows' },
        props.rows.map((r) => Object.values(r.cells).join('|')).join(';'),
      ),
      React.createElement('button', {
        'data-testid': 'add-url',
        onClick: () => props.onAddProperty?.('Link', 'url'),
      }),
      React.createElement('button', {
        'data-testid': 'add-formula',
        onClick: () => props.onAddProperty?.('Calc', 'formula'),
      }),
      React.createElement('button', {
        'data-testid': 'edit-cell',
        onClick: () => props.onCellChange?.(props.rows[0].id, props.columns[0].id, 'edited'),
      }),
    );
  }
  return { ...actual, TableView: MockTableView };
});

import CmsGrid from '../CmsGrid';

const TABLE = { id: 't1', workspaceId: 'framer-clone', name: 'Events' };
const COLUMNS = [
  { id: 'c_title', tableId: 't1', name: 'Title', type: 'text', position: 0, isPrimary: true },
  { id: 'c_date', tableId: 't1', name: 'Date', type: 'date', position: 1, isPrimary: false },
];
const ROWS = [{ id: 'r1', tableId: 't1', cells: { c_title: 'Launch', c_date: '2026-06-19' } }];

function makeFakeAdapter() {
  return {
    getTable: vi.fn().mockResolvedValue(TABLE),
    getColumns: vi.fn().mockResolvedValue(COLUMNS),
    getRows: vi.fn().mockResolvedValue({ items: ROWS, total: ROWS.length, cursor: undefined }),
    getSelectOptions: vi.fn().mockResolvedValue([]),
    createColumn: vi
      .fn()
      .mockImplementation((input: { name: string; type: string }) =>
        Promise.resolve({ id: 'c_new', tableId: 't1', name: input.name, type: input.type, position: 2, isPrimary: false }),
      ),
    updateRow: vi
      .fn()
      .mockImplementation((rowId: string, cells: Record<string, unknown>) =>
        Promise.resolve({ id: rowId, tableId: 't1', cells: { ...ROWS[0].cells, ...cells } }),
      ),
    createRow: vi.fn().mockResolvedValue({ id: 'r2', tableId: 't1', cells: {} }),
    deleteRow: vi.fn().mockResolvedValue(undefined),
    updateColumn: vi.fn().mockResolvedValue(COLUMNS[0]),
    getRow: vi.fn().mockResolvedValue(ROWS[0]),
  };
}

let fake: ReturnType<typeof makeFakeAdapter>;

beforeEach(() => {
  fake = makeFakeAdapter();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('CmsGrid', () => {
  it('renders the collection columns and rows fetched through the injected adapter', async () => {
    render(<CmsGrid tableId="t1" dbAdapter={fake as unknown as DatabaseAdapter} />);

    await waitFor(() =>
      expect(screen.getByTestId('tv-columns').textContent ?? '').toContain('Title'),
    );
    expect(screen.getByTestId('tv-columns').textContent ?? '').toContain('Date');
    expect(screen.getByTestId('tv-rows').textContent ?? '').toContain('Launch');
    expect(fake.getTable).toHaveBeenCalledWith('t1');
  });

  it('exposes the FULL data-table column-type set: add-property forwards a non-binding type (url) to the adapter', async () => {
    render(<CmsGrid tableId="t1" dbAdapter={fake as unknown as DatabaseAdapter} />);
    await screen.findByTestId('mock-tableview');

    fireEvent.click(screen.getByTestId('add-url'));
    await waitFor(() =>
      expect(fake.createColumn).toHaveBeenCalledWith(
        expect.objectContaining({ tableId: 't1', name: 'Link', type: 'url' }),
      ),
    );
  });

  it('forwards another adapter-only type (formula) too, proving the binding 8-type narrowing is not applied here', async () => {
    render(<CmsGrid tableId="t1" dbAdapter={fake as unknown as DatabaseAdapter} />);
    await screen.findByTestId('mock-tableview');

    fireEvent.click(screen.getByTestId('add-formula'));
    await waitFor(() =>
      expect(fake.createColumn).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Calc', type: 'formula' }),
      ),
    );
  });

  it('persists an inline cell edit through the adapter (updateRow)', async () => {
    render(<CmsGrid tableId="t1" dbAdapter={fake as unknown as DatabaseAdapter} />);
    await screen.findByTestId('mock-tableview');

    fireEvent.click(screen.getByTestId('edit-cell'));
    await waitFor(() =>
      expect(fake.updateRow).toHaveBeenCalledWith('r1', expect.objectContaining({ c_title: 'edited' })),
    );
  });
});
