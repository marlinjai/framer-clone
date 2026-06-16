// src/server/cms/types.ts
//
// Type bridge for the CMS server tier.
//
// adapter-prisma re-exports its entity types (Table/Column/Row/CellValue/...)
// only from `@marlinjai/data-table-core`. Under pnpm's strict, non-hoisted
// node_modules layout that package is a TRANSITIVE dependency: it is reachable
// when TypeScript follows adapter-prisma's own `.d.ts` imports (core is
// symlinked beside adapter-prisma inside the pnpm store), but it is NOT
// resolvable from a direct `import ... from '@marlinjai/data-table-core'` in
// framer-clone source (our nearest node_modules has no such entry). Adding
// data-table-core as a direct dependency is out of scope for this slice (the
// only declared dependency add is adapter-prisma; see the spec).
//
// So instead of importing the core type NAMES we DERIVE them structurally from
// the PrismaAdapter's public method signatures. This keeps the repository fully
// type-checked against the real adapter shapes without a second dependency line
// and without a brittle hand-copied union that could drift from the package.

import type { PrismaAdapter } from '@marlinjai/data-table-adapter-prisma';

/** adapter-prisma `Table`, as returned by `getTable`. */
export type DataTableTable = NonNullable<
  Awaited<ReturnType<PrismaAdapter['getTable']>>
>;

/** adapter-prisma `Column`, as returned by `getColumn`. */
export type DataTableColumn = NonNullable<
  Awaited<ReturnType<PrismaAdapter['getColumn']>>
>;

/** adapter-prisma `Row`, as returned by `getRow`. */
export type DataTableRow = NonNullable<
  Awaited<ReturnType<PrismaAdapter['getRow']>>
>;

/**
 * The THIRTEEN adapter-prisma column types
 * (text/number/date/boolean/select/multi_select/url/file/formula/relation/
 * rollup/created_time/last_edited_time). Derived from `Column.type` so it
 * tracks the package exactly.
 */
export type DataTableColumnType = DataTableColumn['type'];

/** A single adapter-prisma cell value (the value side of `Row.cells`). */
export type DataTableCellValue = DataTableRow['cells'][string];

/** adapter-prisma `QueryResult<Row>`, as returned by `getRows`. */
export type DataTableQueryResult = Awaited<ReturnType<PrismaAdapter['getRows']>>;

/** adapter-prisma `QueryOptions` (the second `getRows` argument). */
export type DataTableQueryOptions = NonNullable<
  Parameters<PrismaAdapter['getRows']>[1]
>;

/** adapter-prisma `QueryFilter`. */
export type DataTableQueryFilter = NonNullable<
  DataTableQueryOptions['filters']
>[number];

/** adapter-prisma `FilterOperator`. */
export type DataTableFilterOperator = DataTableQueryFilter['operator'];

/** adapter-prisma `QuerySort`. */
export type DataTableQuerySort = NonNullable<
  DataTableQueryOptions['sorts']
>[number];

/** adapter-prisma eager-load `IncludeOption`. */
export type DataTableIncludeOption = NonNullable<
  DataTableQueryOptions['include']
>[number];
