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
import { resolvePublishedFilter } from './publishedVisibility';
import { tableScopedCmsAdapter } from './tableScopedAdapter';
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

/** True for a usable page size: a positive integer. */
export function isValidLimit(limit: unknown): limit is number {
  return typeof limit === 'number' && Number.isInteger(limit) && limit >= 1;
}

/** True for a usable cursor: the decimal string of a non-negative offset. */
export function isValidCursor(cursor: unknown): cursor is string {
  return typeof cursor === 'string' && /^\d+$/.test(cursor) && Number.isSafeInteger(Number(cursor));
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

  if (query.limit !== undefined) {
    // The adapter interpolates LIMIT into its SQL, so only a positive integer
    // may ever reach it (the routes answer 400 bad_query before this).
    if (!isValidLimit(query.limit)) {
      throw new Error(`CMS repository: invalid limit ${String(query.limit)}`);
    }
    options.limit = query.limit;
  }

  if (query.cursor !== undefined) {
    const offset = Number(query.cursor);
    if (!isValidCursor(query.cursor) || !Number.isInteger(offset) || offset < 0) {
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
// over the `workspaceId` it was built for and threads it into EVERY adapter
// read. `listTables` is workspace-scoped at the adapter; the by-id reads
// (getCollection / listRows / getRow) are scoped HERE by resolving the target
// table up to its owning `workspaceId` and refusing any table outside the bound
// workspace. The data-table adapter is keyed purely by entity id and performs
// no workspace check of its own, so without this a workspace-A repo holding a
// known workspace-B table/row id could read it — a cross-tenant read gap.
//
// Fail-closed and existence-preserving: a table that does not exist and a table
// in another workspace BOTH resolve to "not found" (null table) and yield the
// same not-found result, so the boundary never leaks whether a foreign id
// exists. This mirrors the SiteRepository / workspaceGuard convention.
// Resolve a table by id ONLY when it belongs to `workspaceId`; null both when
// the table is missing and when it lives in another workspace
// (indistinguishable, never leak cross-tenant existence).
async function tableInWorkspace(
  id: string,
  workspaceId: string,
): Promise<DataTableTable | null> {
  const table = await getCmsAdapter().getTable(id);
  if (!table || table.workspaceId !== workspaceId) {
    return null;
  }
  return table;
}

function createReadRepository(workspaceId: string): CmsReadRepository {
  const resolveTableInWorkspace = (id: string) => tableInWorkspace(id, workspaceId);

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
      const table = await resolveTableInWorkspace(id);
      if (!table) {
        return null;
      }
      const columns = await getCmsAdapter().getColumns(id);
      return mapCollection(table, columns);
    },

    async listRows(id: string, query?: Query): Promise<RowsPage> {
      // Refuse a table outside the bound workspace: an empty page is the same
      // result the adapter yields for a non-existent table, so a foreign id is
      // indistinguishable from a missing one.
      const table = await resolveTableInWorkspace(id);
      if (!table) {
        return { rows: [], nextCursor: undefined, total: 0 };
      }
      const result = await getCmsAdapter().getRows(id, mapQuery(query));
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
      // Guard 1: the adapter `getRow` searches every table by row id; only return
      // a hit that actually belongs to the requested collection.
      if (row.tableId !== id) {
        return null;
      }
      // Guard 2: and only when that collection belongs to the bound workspace —
      // otherwise a known cross-tenant (table id, row id) pair would read through.
      if (!(await resolveTableInWorkspace(id))) {
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
// published read tier (the published-site plane and the storefront render)
// =============================================================================

/** The most rows one published-plane page may return. */
export const PUBLISHED_MAX_LIMIT = 100;
/** The page size when a published-plane query names none (the adapter default). */
const PUBLISHED_DEFAULT_LIMIT = 50;

const EMPTY_ROWS_PAGE: RowsPage = { rows: [], nextCursor: undefined, total: 0 };

// The read repository of what a PUBLISHED site may show, bound to the site's
// workspace (src/server/cms/publishedVisibility.ts holds the rule):
//   - only published rows (the collection's Status field, when it has one),
//     never archived ones, including by id,
//   - at most PUBLISHED_MAX_LIMIT rows per page,
//   - a row by id is looked up inside the requested collection's own table only
//     (tableScopedAdapter.ts), never by walking every tenant's tables,
//   - collection item counts count published rows only (no draft-count leak).
// Collections themselves are workspace-scoped exactly like the editor read.
function createPublishedReadRepository(workspaceId: string): CmsReadRepository {
  const base = createReadRepository(workspaceId);

  async function publishedRowCount(tableId: string): Promise<number> {
    const adapter = getCmsAdapter();
    const filter = await resolvePublishedFilter(adapter, tableId);
    if (filter.kind === 'none') return 0;
    const result = await adapter.getRows(tableId, {
      limit: 1,
      filters:
        filter.kind === 'status'
          ? [{ columnId: filter.columnId, operator: 'equals', value: filter.optionId }]
          : undefined,
    });
    return result.total ?? 0;
  }

  return {
    async listCollections(): Promise<Collection[]> {
      const adapter = getCmsAdapter();
      const tables = await adapter.listTables(workspaceId);
      return Promise.all(
        tables.map(async (table) => {
          const [columns, itemCount] = await Promise.all([
            adapter.getColumns(table.id),
            publishedRowCount(table.id).catch(() => 0),
          ]);
          return mapCollection(table, columns, itemCount);
        }),
      );
    },

    getCollection: (id) => base.getCollection(id),

    async listRows(id: string, query?: Query): Promise<RowsPage> {
      if (!(await tableInWorkspace(id, workspaceId))) {
        return EMPTY_ROWS_PAGE;
      }
      const adapter = getCmsAdapter();
      const filter = await resolvePublishedFilter(adapter, id);
      if (filter.kind === 'none') {
        return EMPTY_ROWS_PAGE;
      }
      const limit = Math.min(query?.limit ?? PUBLISHED_DEFAULT_LIMIT, PUBLISHED_MAX_LIMIT);
      const options = mapQuery({ ...query, limit });
      if (filter.kind === 'status') {
        // Appended to the visitor's own filters (all ANDed), so `total` and the
        // paging cursor count published rows only.
        options.filters = [
          ...(options.filters ?? []),
          { columnId: filter.columnId, operator: 'equals', value: filter.optionId },
        ];
      }
      const result = await adapter.getRows(id, options);
      return {
        rows: result.items.map(mapRow),
        nextCursor: result.cursor,
        total: result.total,
      };
    },

    async getRow(id: string, rowId: string): Promise<BindingRow | null> {
      if (!(await tableInWorkspace(id, workspaceId))) {
        return null;
      }
      const filter = await resolvePublishedFilter(getCmsAdapter(), id);
      if (filter.kind === 'none') {
        return null;
      }
      const row = await tableScopedCmsAdapter(id).getRow(rowId);
      if (!row || row.tableId !== id || row.archived) {
        return null;
      }
      if (filter.kind === 'status' && row.cells[filter.columnId] !== filter.optionId) {
        return null;
      }
      return mapRow(row);
    },
  };
}

/**
 * Return the server-only CMS read repository of what a PUBLISHED site bound to
 * `workspaceId` may show (published, non-archived rows; capped pages; by-id
 * lookups inside the requested table only). Used by the storefront render and
 * the published-site plane of /api/cms; the editor and its preview keep
 * getCmsRepository, which shows drafts.
 */
export function getPublishedCmsRepository(workspaceId: string): CmsReadRepository {
  return createPublishedReadRepository(workspaceId);
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
