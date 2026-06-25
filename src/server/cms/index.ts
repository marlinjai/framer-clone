import 'server-only';

// src/server/cms/index.ts
//
// Server barrel for the CMS document tier. This is the import surface for the
// live read provider (slice2-prisma-datasource-provider) and the build-time
// hydrator (slice2-publish-read-binding-hydration). Everything here is
// server-only and React-free.

export {
  getCmsRepository,
  getCmsWriteRepository,
  type CmsReadRepository,
  type CmsWriteRepository,
} from './repository';
export {
  CmsWriteError,
  CollectionExistsError,
  CmsNotFoundError,
  CmsDdlError,
  cmsWriteErrorResponse,
} from './errors';
export { mapDataTableColumnType } from './columnTypeMap';
export { withTenant } from './withTenant';
export { getCmsAdapter, CMS_SCHEMA, CMS_WORKSPACE_ID } from './adapterClient';

// Re-export the binding shapes consumers map against (the canonical
// definitions live in src/lib/bindings/dataSource/types.ts and are unchanged
// by this slice).
export type {
  Collection,
  Column,
  Row,
  RowValue,
  Query,
  RowsPage,
  FilterClause,
  FilterOp,
  SortClause,
  ColumnType,
} from '@/lib/bindings/dataSource/types';
