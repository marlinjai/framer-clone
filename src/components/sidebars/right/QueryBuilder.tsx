'use client';
// QueryBuilder: a visual filter / sort / limit editor for a data component
// (Collection / TableView). It reads the structured Query off `node.props.query`
// and writes it back through the NEW `node.setQuery(query)` MST action (tagged
// MST-WRITE on the model). Column choices are resolved LIVE from the node's
// bound source collection via useDataSource().getCollection.
import React from 'react';
import { observer } from 'mobx-react-lite';
import { Plus, Trash2 } from 'lucide-react';
import type { ComponentInstance } from '@/models/ComponentModel';
import type { ReadBinding } from '@/lib/bindings/types';
import type {
  Column,
  FilterClause,
  FilterOp,
  Query,
  SortClause,
} from '@/lib/bindings/dataSource/types';
import { useDataSource } from '@/lib/bindings/dataSource/context';

export interface QueryBuilderProps {
  node: ComponentInstance;
}

const FILTER_OPS: { value: FilterOp; label: string }[] = [
  { value: 'eq', label: 'equals' },
  { value: 'ne', label: 'not equals' },
  { value: 'gt', label: 'greater than' },
  { value: 'lt', label: 'less than' },
  { value: 'contains', label: 'contains' },
];

const SELECT_CLASS = 'h-7 rounded border border-gray-200 px-1 text-xs outline-none focus:border-brand';
const INPUT_CLASS = 'h-7 rounded border border-gray-200 px-2 text-xs outline-none focus:border-brand';

/** Read the literal source collection id off the node's `collection` binding. */
function sourceCollectionId(node: ComponentInstance): string | null {
  const binding = node.bindings?.collection as ReadBinding | undefined;
  if (!binding || binding.mode !== 'read') return null;
  const raw = typeof binding.expression === 'string' ? binding.expression.trim() : '';
  if (!raw || raw.startsWith('{{')) return null;
  return raw;
}

const QueryBuilder = observer(({ node }: QueryBuilderProps) => {
  const dataSource = useDataSource();
  const collectionId = sourceCollectionId(node);

  const [columns, setColumns] = React.useState<Column[] | null>(null);

  React.useEffect(() => {
    if (!collectionId) {
      setColumns(null);
      return;
    }
    let active = true;
    dataSource
      .getCollection(collectionId)
      .then((collection) => {
        if (active) setColumns(collection ? collection.columns : []);
      })
      .catch(() => {
        if (active) setColumns([]);
      });
    return () => {
      active = false;
    };
  }, [dataSource, collectionId]);

  const query: Query = ((node.props as Record<string, unknown>)?.query as Query) ?? {};
  const filters: FilterClause[] = query.filter ?? [];
  const sorts: SortClause[] = query.sort ?? [];

  // Single write seam: every mutation builds the next Query and routes through
  // the new setQuery action. We prune empty arrays / undefined so the stored
  // shape stays minimal.
  const writeQuery = (next: Query) => {
    const cleaned: Query = {};
    if (next.filter && next.filter.length > 0) cleaned.filter = next.filter;
    if (next.sort && next.sort.length > 0) cleaned.sort = next.sort;
    if (typeof next.limit === 'number') cleaned.limit = next.limit;
    if (next.cursor) cleaned.cursor = next.cursor;
    // MST-WRITE: new setQuery action, writes into the existing frozen props.
    node.setQuery(cleaned);
  };

  const defaultColumn = columns && columns.length > 0 ? columns[0].id : '';

  const addFilter = () => {
    writeQuery({
      ...query,
      filter: [...filters, { column: defaultColumn, op: 'eq', value: '' }],
    });
  };

  const updateFilter = (idx: number, patch: Partial<FilterClause>) => {
    const nextFilters = filters.map((f, i) => (i === idx ? { ...f, ...patch } : f));
    writeQuery({ ...query, filter: nextFilters });
  };

  const removeFilter = (idx: number) => {
    writeQuery({ ...query, filter: filters.filter((_, i) => i !== idx) });
  };

  const addSort = () => {
    writeQuery({
      ...query,
      sort: [...sorts, { column: defaultColumn, direction: 'asc' }],
    });
  };

  const updateSort = (idx: number, patch: Partial<SortClause>) => {
    const nextSorts = sorts.map((s, i) => (i === idx ? { ...s, ...patch } : s));
    writeQuery({ ...query, sort: nextSorts });
  };

  const removeSort = (idx: number) => {
    writeQuery({ ...query, sort: sorts.filter((_, i) => i !== idx) });
  };

  const setLimit = (raw: string) => {
    const trimmed = raw.trim();
    if (trimmed === '') {
      const { limit: _omit, ...rest } = query;
      void _omit;
      writeQuery(rest);
      return;
    }
    const n = Number(trimmed);
    if (Number.isFinite(n) && n >= 0) {
      writeQuery({ ...query, limit: Math.floor(n) });
    }
  };

  if (!collectionId) {
    return (
      <div className="px-1 py-1 text-[11px] text-gray-400">
        Bind a source collection to configure the query.
      </div>
    );
  }

  const columnOptions = columns ?? [];

  return (
    <div className="space-y-3">
      {/* Filters */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium text-gray-500">Filters</span>
          <button
            type="button"
            aria-label="Add filter"
            onClick={addFilter}
            className="flex h-6 w-6 items-center justify-center rounded border border-gray-200 text-gray-500 hover:bg-gray-50"
          >
            <Plus size={12} />
          </button>
        </div>
        {filters.length === 0 && (
          <div className="px-1 text-[11px] text-gray-400">No filters</div>
        )}
        {filters.map((clause, idx) => (
          <div key={idx} className="flex items-center gap-1" data-testid="filter-row">
            <select
              aria-label="Filter column"
              className={`${SELECT_CLASS} flex-1`}
              value={clause.column}
              onChange={(e) => updateFilter(idx, { column: e.target.value })}
            >
              {columnOptions.map((col) => (
                <option key={col.id} value={col.id}>
                  {col.name}
                </option>
              ))}
            </select>
            <select
              aria-label="Filter operator"
              className={SELECT_CLASS}
              value={clause.op}
              onChange={(e) => updateFilter(idx, { op: e.target.value as FilterOp })}
            >
              {FILTER_OPS.map((op) => (
                <option key={op.value} value={op.value}>
                  {op.label}
                </option>
              ))}
            </select>
            <input
              aria-label="Filter value"
              className={`${INPUT_CLASS} w-16`}
              value={clause.value === null ? '' : String(clause.value)}
              onChange={(e) => updateFilter(idx, { value: e.target.value })}
            />
            <button
              type="button"
              aria-label="Remove filter"
              onClick={() => removeFilter(idx)}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-gray-400 hover:text-red-500"
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </div>

      {/* Sorts */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium text-gray-500">Sort</span>
          <button
            type="button"
            aria-label="Add sort"
            onClick={addSort}
            className="flex h-6 w-6 items-center justify-center rounded border border-gray-200 text-gray-500 hover:bg-gray-50"
          >
            <Plus size={12} />
          </button>
        </div>
        {sorts.length === 0 && (
          <div className="px-1 text-[11px] text-gray-400">No sort</div>
        )}
        {sorts.map((clause, idx) => (
          <div key={idx} className="flex items-center gap-1" data-testid="sort-row">
            <select
              aria-label="Sort column"
              className={`${SELECT_CLASS} flex-1`}
              value={clause.column}
              onChange={(e) => updateSort(idx, { column: e.target.value })}
            >
              {columnOptions.map((col) => (
                <option key={col.id} value={col.id}>
                  {col.name}
                </option>
              ))}
            </select>
            <select
              aria-label="Sort direction"
              className={SELECT_CLASS}
              value={clause.direction}
              onChange={(e) =>
                updateSort(idx, { direction: e.target.value as SortClause['direction'] })
              }
            >
              <option value="asc">Ascending</option>
              <option value="desc">Descending</option>
            </select>
            <button
              type="button"
              aria-label="Remove sort"
              onClick={() => removeSort(idx)}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-gray-400 hover:text-red-500"
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </div>

      {/* Limit */}
      <div className="space-y-1">
        <label className="block px-1 text-[11px] font-medium text-gray-500">Limit</label>
        <input
          type="number"
          min={0}
          aria-label="Limit"
          className={`${INPUT_CLASS} w-full`}
          value={typeof query.limit === 'number' ? String(query.limit) : ''}
          onChange={(e) => setLimit(e.target.value)}
          placeholder="No limit"
        />
      </div>
    </div>
  );
});

QueryBuilder.displayName = 'QueryBuilder';

export default QueryBuilder;
