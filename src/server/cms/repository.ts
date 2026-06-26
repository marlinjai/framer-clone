import 'server-only';

// src/server/cms/repository.ts
//
// The READ repository: the server-only door between adapter-prisma and the
// binding layer. It maps adapter-prisma `Table`/`Column`/`Row`/`QueryResult`
// onto the EXISTING binding shapes in src/lib/bindings/dataSource/types.ts
// (which this slice does NOT change). Read-only: WRITE methods (content-type
// create, field DDL) belong to slice2-content-type-management-ui.
//
// Errors surface: any unmappable cell value or invalid cursor throws, rather
// than returning a silent null/empty that would read as success.

import type {
  Collection,
  Column as BindingColumn,
  Row as BindingRow,
  RowValue,
  Query,
  RowsPage,
  FilterOp,
} from '@/lib/bindings/dataSource/types';
import { getCmsAdapter, CMS_WORKSPACE_ID } from './adapterClient';
import { mapDataTableColumnType } from './columnTypeMap';
import {
  CollectionExistsError,
  CmsNotFoundError,
  CmsDdlError,
  CmsWriteError,
} from './errors';
import type {
  DataTableTable,
  DataTableColumn,
  DataTableRow,
  DataTableCellValue,
  DataTableQueryOptions,
  DataTableFilterOperator,
} from './types';

export interface CmsReadRepository {
  listCollections(): Promise<Collection[]>;
  getCollection(id: string): Promise<Collection | null>;
  listRows(id: string, query?: Query): Promise<RowsPage>;
  getRow(id: string, rowId: string): Promise<BindingRow | null>;
}

/**
 * The WRITE repository: extends the read door with COLLECTION-level operations
 * (create / rename / delete a content type) through adapter-prisma's
 * single-entity DDL, which is atomic on its own per the adapter's atomicDDL. It
 * does NOT touch MST and does NOT use the no-op `adapter.transaction()`.
 * Name-uniqueness and not-found checks the adapter does not enforce are enforced
 * here and surfaced as typed CmsWriteError (see errors.ts).
 *
 * In-collection editing (columns/rows/options/relations/files) is NOT done here:
 * the editor grid drives it through the data-table server-actions adapter
 * (src/server/cms/actions.ts) against the same PrismaAdapter.
 */
export interface CmsWriteRepository extends CmsReadRepository {
  createCollection(name: string): Promise<Collection>;
  renameCollection(id: string, name: string): Promise<void>;
  updateCollection(id: string, updates: { name?: string; icon?: string }): Promise<void>;
  deleteCollection(id: string): Promise<void>;
}

// Always eager-load junction data so multi-select arrays, file URLs, and
// relation ids actually appear in `Row.cells`. Without this, adapter-prisma
// leaves those cells empty.
const READ_INCLUDE: NonNullable<DataTableQueryOptions['include']> = [
  'files',
  'multiSelect',
  'relations',
];

// =============================================================================
// slug derivation
// =============================================================================

// adapter-prisma `Table` has no slug field; the binding `Collection` requires
// one. Derive a stable, url-safe slug from the table name, falling back to the
// id when the name has no slug-able characters.
function deriveSlug(name: string, id: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : id;
}

// =============================================================================
// shape mapping
// =============================================================================

function mapColumn(column: DataTableColumn): BindingColumn {
  return {
    id: column.id,
    name: column.name,
    type: mapDataTableColumnType(column.type),
  };
}

function mapCollection(
  table: DataTableTable,
  columns: DataTableColumn[],
  itemCount?: number,
): Collection {
  return {
    id: table.id,
    slug: deriveSlug(table.name, table.id),
    name: table.name,
    icon: table.icon ?? undefined,
    columns: columns.map(mapColumn),
    itemCount,
  };
}

// Map one adapter-prisma cell value onto a binding `RowValue`.
//   string/number/boolean -> as-is
//   Date                  -> ISO string (binding has no Date type)
//   string[]              -> as-is (multi_select)
//   FileReference[]       -> string[] of file URLs
//   RelationValue[]       -> string[] of related row ids
//   null/undefined        -> null
function mapCellValue(value: DataTableCellValue): RowValue {
  if (value === null || value === undefined) {
    return null;
  }
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map((element): string => {
      if (typeof element === 'string') {
        // multi_select option value
        return element;
      }
      // FileReference is checked before RelationValue: a FileReference ALSO has
      // a `rowId`, so `fileUrl` is the discriminator that must win.
      if (element && typeof element === 'object' && 'fileUrl' in element) {
        return element.fileUrl;
      }
      if (element && typeof element === 'object' && 'rowId' in element) {
        return element.rowId;
      }
      throw new Error(
        `CMS repository: unmappable array cell element ${JSON.stringify(element)}`,
      );
    });
  }
  throw new Error(
    `CMS repository: unmappable cell value ${JSON.stringify(value)}`,
  );
}

function mapRow(row: DataTableRow): BindingRow {
  const values: Record<string, RowValue> = {};
  for (const [columnId, cell] of Object.entries(row.cells)) {
    values[columnId] = mapCellValue(cell);
  }
  // Computed (formula/rollup) values are keyed by column id too; surface any
  // that are not already present as a plain cell.
  if (row.computed) {
    for (const [columnId, cell] of Object.entries(row.computed)) {
      if (!(columnId in values)) {
        values[columnId] = mapCellValue(cell);
      }
    }
  }
  return { id: row.id, values };
}

// =============================================================================
// query translation
// =============================================================================

function mapFilterOp(op: FilterOp): DataTableFilterOperator {
  switch (op) {
    case 'eq':
      return 'equals';
    case 'ne':
      return 'notEquals';
    case 'gt':
      return 'greaterThan';
    case 'lt':
      return 'lessThan';
    case 'contains':
      return 'contains';
    default: {
      const exhaustive: never = op;
      throw new Error(
        `CMS repository: unsupported filter op ${String(exhaustive)}`,
      );
    }
  }
}

// Translate a binding `Query` into adapter-prisma `QueryOptions`. The binding
// cursor is the opaque pagination token this repository owns: it encodes the
// absolute row offset as a decimal string (the adapter's `getRows` returns
// `String(offset + limit)` as its cursor), so we decode it straight back into
// `offset`.
function mapQuery(query?: Query): DataTableQueryOptions {
  const options: DataTableQueryOptions = { include: READ_INCLUDE };

  if (!query) {
    return options;
  }

  if (query.filter && query.filter.length > 0) {
    options.filters = query.filter.map((clause) => ({
      columnId: clause.column,
      operator: mapFilterOp(clause.op),
      value: clause.value,
    }));
  }

  if (query.sort && query.sort.length > 0) {
    options.sorts = query.sort.map((clause) => ({
      columnId: clause.column,
      direction: clause.direction,
    }));
  }

  if (typeof query.limit === 'number') {
    options.limit = query.limit;
  }

  if (query.cursor !== undefined) {
    const offset = Number(query.cursor);
    if (!Number.isInteger(offset) || offset < 0) {
      throw new Error(`CMS repository: invalid cursor ${query.cursor}`);
    }
    options.offset = offset;
    options.cursor = query.cursor;
  }

  return options;
}

// =============================================================================
// repository
// =============================================================================

// The read repository is constructed PER workspace: each returned object closes
// over the `workspaceId` it was built for and threads it into the
// workspace-scoped adapter calls (currently `listTables`). The by-id reads
// (getCollection / listRows / getRow) are not workspace-scoped here (MT-14
// handles read-isolation), but they live on the same bound object so a single
// `getCmsRepository(workspaceId)` call yields one cohesive repo.
function createReadRepository(workspaceId: string): CmsReadRepository {
  return {
    async listCollections(): Promise<Collection[]> {
      const adapter = getCmsAdapter();
      const tables = await adapter.listTables(workspaceId);
      // N+1 over collections: fetch columns + count per table. Acceptable for
      // phase 1 (single-tenant, few collections). A batched count is a later
      // optimization once the adapter exposes a bulk method.
      return Promise.all(
        tables.map(async (table) => {
          const [columns, itemCount] = await Promise.all([
            adapter.getColumns(table.id),
            adapter.getRows(table.id, { limit: 1 }).then((r) => r.total ?? 0).catch(() => 0),
          ]);
          return mapCollection(table, columns, itemCount);
        }),
      );
    },

    async getCollection(id: string): Promise<Collection | null> {
      const adapter = getCmsAdapter();
      const table = await adapter.getTable(id);
      if (!table) {
        return null;
      }
      const columns = await adapter.getColumns(id);
      return mapCollection(table, columns);
    },

    async listRows(id: string, query?: Query): Promise<RowsPage> {
      const adapter = getCmsAdapter();
      const result = await adapter.getRows(id, mapQuery(query));
      return {
        rows: result.items.map(mapRow),
        nextCursor: result.cursor,
        total: result.total,
      };
    },

    async getRow(id: string, rowId: string): Promise<BindingRow | null> {
      const adapter = getCmsAdapter();
      const row = await adapter.getRow(rowId);
      if (!row) {
        return null;
      }
      // Guard: the adapter `getRow` searches every table by row id; only return a
      // hit that actually belongs to the requested collection.
      if (row.tableId !== id) {
        return null;
      }
      return mapRow(row);
    },
  };
}

/**
 * Return the server-only CMS read repository bound to `workspaceId`. Defaults to
 * the single-tenant `CMS_WORKSPACE_ID` so existing single-tenant callers behave
 * identically; MT-13 passes the per-request session workspace instead. A fresh
 * bound object is constructed per call (no shared mutable state across tenants).
 */
export function getCmsRepository(
  workspaceId: string = CMS_WORKSPACE_ID,
): CmsReadRepository {
  return createReadRepository(workspaceId);
}

// =============================================================================
// write tier
// =============================================================================

// Run an adapter DDL/persistence call, re-throwing typed CmsWriteError as-is but
// wrapping any opaque adapter/Prisma throw as a typed CmsDdlError so the failure
// surfaces loudly with a code instead of a bare 500.
async function ddl<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof CmsWriteError) {
      throw err;
    }
    throw new CmsDdlError(
      err instanceof Error ? err.message : 'CMS DDL operation failed',
    );
  }
}

// Assert a collection exists, throwing the typed 404 the adapter does not.
async function requireTable(id: string): Promise<DataTableTable> {
  const adapter = getCmsAdapter();
  const table = await adapter.getTable(id);
  if (!table) {
    throw new CmsNotFoundError('collection', id);
  }
  return table;
}

// The write repository is likewise constructed PER workspace: the name-
// uniqueness checks (`listTables`) and the create (`createTable`) thread the
// bound `workspaceId` instead of the module constant, so MT-14 can pass the
// per-request session workspace. It extends the read repo bound to the SAME
// workspace.
function createWriteRepository(workspaceId: string): CmsWriteRepository {
  return {
    ...createReadRepository(workspaceId),

    async createCollection(name: string): Promise<Collection> {
      const adapter = getCmsAdapter();
      // Enforce name-uniqueness the adapter does NOT: a duplicate name is the
      // specific collision contract surfaced as CollectionExistsError (409).
      const existing = await adapter.listTables(workspaceId);
      const collision = existing.find(
        (t) => t.name.trim().toLowerCase() === name.trim().toLowerCase(),
      );
      if (collision) {
        throw new CollectionExistsError(name);
      }
      const table = await ddl(() =>
        adapter.createTable({ workspaceId, name }),
      );
      // A fresh collection has no user columns yet.
      return mapCollection(table, []);
    },

    async renameCollection(id: string, name: string): Promise<void> {
      await this.updateCollection(id, { name });
    },

    async updateCollection(
      id: string,
      updates: { name?: string; icon?: string },
    ): Promise<void> {
      const adapter = getCmsAdapter();
      await requireTable(id);
      const patch: { name?: string; icon?: string } = {};
      if (updates.name !== undefined) {
        const name = updates.name;
        const others = (await adapter.listTables(workspaceId)).filter(
          (t) => t.id !== id,
        );
        const collision = others.find(
          (t) => t.name.trim().toLowerCase() === name.trim().toLowerCase(),
        );
        if (collision) {
          throw new CollectionExistsError(name);
        }
        patch.name = name;
      }
      if (updates.icon !== undefined) {
        patch.icon = updates.icon;
      }
      await ddl(() => adapter.updateTable(id, patch));
    },

    async deleteCollection(id: string): Promise<void> {
      const adapter = getCmsAdapter();
      await requireTable(id);
      await ddl(() => adapter.deleteTable(id));
    },
  };
}

/**
 * Return the server-only CMS write repository (read methods + write tier) bound
 * to `workspaceId`. Defaults to the single-tenant `CMS_WORKSPACE_ID` so existing
 * callers behave identically; MT-14 passes the per-request session workspace
 * instead. A fresh bound object is constructed per call (no shared state).
 */
export function getCmsWriteRepository(
  workspaceId: string = CMS_WORKSPACE_ID,
): CmsWriteRepository {
  return createWriteRepository(workspaceId);
}
