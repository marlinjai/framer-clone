/* eslint-disable @typescript-eslint/no-explicit-any */
// TableViewRenderer: the runtime for a BOUND `table-view` data component.
//
// Reads the node's `collection` read-binding to learn which collection to
// show, fetches that collection's COLUMNS (via useDataSource().getCollection)
// and ROWS (via useDataSource().listRows), maps both into the shapes the
// published `@marlinjai/data-table-react` TableView expects, and renders that
// TableView in READ-ONLY mode. Write / edit-in-table is out of scope for this
// slice (explicitly deferred): no on* mutation handlers are wired, and
// readOnly is hard-pinned true, so the published table renders cells as static
// content (verified: no input / textarea / contenteditable in read-only mode).
//
// Dependency note (flagged to Marlin, see slice2-tableview-renderer spec open
// question): `@marlinjai/data-table-react@0.3.1` ships a single runtime
// dependency (`@marlinjai/data-table-core`) plus React peers. Read-only mode
// pulls NO editor-only package into the tree, so the hand-rolled fallback was
// NOT triggered and we ship the real wrap. The published bundle is large
// (~338 KB minified) because it is one module re-exporting Board / Calendar /
// editing surfaces; that is in-bundle weight, not an editor-only dependency,
// so it does not meet the spec's fallback trigger. Recorded here so the size
// is a known, deliberate trade rather than a silent acceptance.
//
// State handling is a MINIMAL inline placeholder (loading / empty / error
// notes), mirroring CollectionRenderer until the shared loading/empty/error
// directive helper (`resolveDataState`, slice2-data-loading-empty-error-states)
// lands. Errors (a failed fetch, a missing / unresolved collection binding, a
// collection that does not exist) ALWAYS surface to the error / empty path;
// they are never rendered as a silent success.
'use client';
import React from 'react';
import { observer } from 'mobx-react-lite';
import {
  TableView,
  type Column as TableColumn,
  type ColumnType as TableColumnType,
  type Row as TableRow,
} from '@marlinjai/data-table-react';
import type { ComponentInstance } from '@/models/ComponentModel';
import type { ReadBinding } from '@/lib/bindings/types';
import type { BindingScope } from '@/lib/bindings/resolver/scope';
import { useDataSource } from '@/lib/bindings/dataSource/context';
import type {
  Collection,
  Column as CmsColumn,
  ColumnType as CmsColumnType,
  Query,
  Row as CmsRow,
} from '@/lib/bindings/dataSource/types';
import { resolveCollectionId } from './CollectionRenderer';

const NOTE_STYLE: React.CSSProperties = {
  color: '#9ca3af',
  fontSize: '12px',
  fontFamily: 'Inter, sans-serif',
  pointerEvents: 'none',
  userSelect: 'none',
};

// Fixed epoch timestamp for the mapped (createdAt / updatedAt) fields the
// published TableView types require. The CMS read model carries no such
// timestamps and the read-only table never displays them, so a constant keeps
// the mapping pure (no wall-clock read) and deterministic for tests.
const EPOCH = new Date(0);

// Default rendered column width when the CMS column carries none (the CMS read
// model does not yet model per-column width). The published TableView uses
// this only for initial layout; read-only mode never persists a resize.
const DEFAULT_COLUMN_WIDTH = 200;

/**
 * Map a CMS column type onto the published table's column type. The two share
 * most names; only `multi-select` (CMS) vs `multi_select` (table) differ.
 * Unknown / future types fall back to `text` so an unexpected column still
 * renders as readable text rather than throwing.
 */
function mapColumnType(type: CmsColumnType): TableColumnType {
  switch (type) {
    case 'text':
      return 'text';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'date':
      return 'date';
    case 'select':
      return 'select';
    case 'multi-select':
      return 'multi_select';
    case 'relation':
      return 'relation';
    case 'file':
      return 'file';
    default:
      return 'text';
  }
}

/** Map the resolved CMS columns onto the published TableView `Column[]`. The
 *  first column is marked primary (the published table expects exactly one
 *  primary column to anchor row identity / the open affordance). */
function mapColumns(collectionId: string, columns: CmsColumn[]): TableColumn[] {
  return columns.map((col, index) => ({
    id: col.id,
    tableId: collectionId,
    name: col.name,
    type: mapColumnType(col.type),
    position: index,
    width: DEFAULT_COLUMN_WIDTH,
    isPrimary: index === 0,
    createdAt: EPOCH,
  }));
}

/** Map the resolved CMS rows onto the published TableView `Row[]`. CMS
 *  `RowValue` (string | number | boolean | null | string[]) is a subset of the
 *  table's `CellValue`, so the cell map passes through unchanged. */
function mapRows(collectionId: string, rows: CmsRow[]): TableRow[] {
  return rows.map((row) => ({
    id: row.id,
    tableId: collectionId,
    cells: row.values,
    archived: false,
    createdAt: EPOCH,
    updatedAt: EPOCH,
  }));
}

type FetchState =
  | { status: 'loading' }
  | { status: 'ready'; collection: Collection; rows: CmsRow[] }
  | { status: 'error'; message: string };

export interface TableViewRendererProps {
  node: ComponentInstance;
  scope: BindingScope;
}

const TableViewRenderer = observer(({ node, scope }: TableViewRendererProps) => {
  const dataSource = useDataSource();

  const collectionId = resolveCollectionId(
    node.bindings?.collection as ReadBinding | undefined,
    scope,
  );
  // Structured filter / sort / limit live as a Query object on props.query
  // (NOT a template expression), matching CollectionRenderer's contract.
  const query = (node.props as any)?.query as Query | undefined;
  // Stable dependency key so the effect refetches when the query changes by
  // value (the object identity churns on every MST snapshot).
  const queryKey = query ? JSON.stringify(query) : '';

  const [state, setState] = React.useState<FetchState>({ status: 'loading' });

  React.useEffect(() => {
    if (!collectionId) return;
    let active = true;
    const load = () => {
      Promise.all([
        dataSource.getCollection(collectionId),
        dataSource.listRows(collectionId, query),
      ])
        .then(([collection, page]) => {
          if (!active) return;
          if (!collection) {
            setState({
              status: 'error',
              message: `collection "${collectionId}" not found`,
            });
            return;
          }
          setState({ status: 'ready', collection, rows: page.rows });
        })
        .catch((err: unknown) => {
          if (active) {
            setState({
              status: 'error',
              message: err instanceof Error ? err.message : String(err),
            });
          }
        });
    };
    load();
    // Polling reactivity: re-fetch whenever the provider signals a change.
    const unsubscribe = dataSource.subscribe(collectionId, query, load);
    return () => {
      active = false;
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataSource, collectionId, queryKey]);

  // Unresolved / missing collection binding: surface the error path, never a
  // silent empty success.
  if (!collectionId) {
    return (
      <span style={NOTE_STYLE}>Table view: no source collection bound</span>
    );
  }
  if (state.status === 'loading') {
    return <span style={NOTE_STYLE}>Loading...</span>;
  }
  if (state.status === 'error') {
    return (
      <span style={NOTE_STYLE}>Failed to load table: {state.message}</span>
    );
  }

  const columns = mapColumns(collectionId, state.collection.columns);
  const rows = mapRows(collectionId, state.rows);

  return <TableView columns={columns} rows={rows} readOnly />;
});

TableViewRenderer.displayName = 'TableViewRenderer';
export default TableViewRenderer;
