// DataSourceProvider — the read-only seam between the renderer and whatever
// is delivering data (in-memory mock today, cms HTTP client tomorrow). The
// renderer never imports a concrete provider; it always goes through
// useDataSource() so the implementation is swappable at the root.
//
// Phase 1 surface is read-only. WriteDataSourceProvider is reserved for
// Phase 2 (Form / write bindings) so adding writes later doesn't break the
// Phase 1 contract.

import type { Collection, Query, Row, RowValue, RowsPage } from './types';

export interface DataSourceProvider {
  listCollections(): Promise<Collection[]>;
  getCollection(collectionId: string): Promise<Collection | null>;
  listRows(collectionId: string, query?: Query): Promise<RowsPage>;
  getRow(collectionId: string, rowId: string): Promise<Row | null>;

  /**
   * Polling-style subscription. The provider invokes `onChange` whenever
   * data the query depends on may have changed. Returns an unsubscribe
   * function.
   *
   * Phase 1 in-memory provider fires on internal mutate. The future HTTP
   * provider will pick its own polling cadence (5s default per cms plan).
   * Real-time push channels (WebSocket / SSE) are deferred to Phase 2.
   */
  subscribe(
    collectionId: string,
    query: Query | undefined,
    onChange: () => void,
  ): () => void;
}

/**
 * Phase 2 write surface. NOT implemented in Phase 1 — reserved here so the
 * Form / write-bindings track has somewhere to live without forcing a
 * Phase 1 contract change.
 */
export interface WriteDataSourceProvider extends DataSourceProvider {
  // Phase 2
  createRow(
    collectionId: string,
    values: Record<string, RowValue>,
  ): Promise<Row>;
  // Phase 2
  updateRow(
    collectionId: string,
    rowId: string,
    values: Record<string, RowValue>,
  ): Promise<Row>;
  // Phase 2
  deleteRow(collectionId: string, rowId: string): Promise<void>;
}
