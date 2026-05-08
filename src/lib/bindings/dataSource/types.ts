// Shared data-source type definitions.
//
// These types form the contract between the data-bindings track (component
// side: renderer, editor binding picker, resolver) and the cms track (HTTP
// service that delivers collections + rows). The Phase 1 in-memory provider
// implements the same interface so wave-2 components can be built and tested
// before the HTTP client lands.

export type ColumnType =
  | 'text'
  | 'number'
  | 'boolean'
  | 'date'
  | 'select'
  | 'multi-select'
  | 'relation'
  | 'file';

export interface Column {
  /** Stable slug, owned by the cms track. Used as the key inside Row.values. */
  id: string;
  /** Display label shown in the editor + binding picker. */
  name: string;
  type: ColumnType;
}

export interface Collection {
  /** Stable identifier, owned by the cms track. */
  id: string;
  slug: string;
  name: string;
  columns: Column[];
}

/**
 * Permitted row cell values. Multi-select / relation fields are represented
 * as `string[]`. Files are stored as a URL string in Phase 1; richer file
 * descriptors are deferred to the cms track.
 */
export type RowValue = string | number | boolean | null | string[];

export interface Row {
  id: string;
  /** Keyed by Column.id. */
  values: Record<string, RowValue>;
}

export type FilterOp = 'eq' | 'ne' | 'gt' | 'lt' | 'contains';

export interface FilterClause {
  column: string;
  op: FilterOp;
  value: RowValue;
}

export interface SortClause {
  column: string;
  direction: 'asc' | 'desc';
}

export interface Query {
  filter?: FilterClause[];
  sort?: SortClause[];
  limit?: number;
  /**
   * Opaque cursor, encoded by the underlying provider. The cms track owns
   * the encoding when the HTTP client lands.
   */
  cursor?: string;
}

export interface RowsPage {
  rows: Row[];
  nextCursor?: string;
  total?: number;
}
