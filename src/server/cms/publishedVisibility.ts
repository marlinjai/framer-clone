import 'server-only';

// src/server/cms/publishedVisibility.ts
//
// THE rule for which CMS rows a published site shows, shared by the storefront
// render and the published-site plane of /api/cms (one rule, so the page HTML
// and the API can never disagree).
//
// Each collection carries the reserved "Status" select field (ensureStatusField
// in actions.ts) with Draft / Published / Scheduled options:
//   - no Status field on the collection: no publishing workflow exists, so every
//     non-archived row is published (the state before the workflow, unchanged);
//   - a Status field: ONLY rows whose status is the "Published" option are
//     published. Draft, Scheduled (no schedule date exists to evaluate yet) and
//     an unset status are not. A Status field without a "Published" option
//     publishes nothing.
//   - archived rows are never published (the adapter's getRows already excludes
//     them; a by-id read checks `archived` itself).
// The field and option are matched by name exactly as ensureStatusField and the
// content agent's bulk_update_status match them (select type, trimmed,
// case-insensitive).

import type { DataTableColumn } from './types';

export const STATUS_FIELD_NAME = 'Status';
export const PUBLISHED_OPTION_NAME = 'Published';

export type PublishedFilter =
  | { kind: 'all' }
  | { kind: 'status'; columnId: string; optionId: string }
  | { kind: 'none' };

interface VisibilityReads {
  getColumns(tableId: string): Promise<DataTableColumn[]>;
  getSelectOptions(columnId: string): Promise<Array<{ id: string; name: string }>>;
}

/** True for the reserved Status select column. */
export function isStatusColumn(column: Pick<DataTableColumn, 'type' | 'name'>): boolean {
  return (
    column.type === 'select' &&
    column.name.trim().toLowerCase() === STATUS_FIELD_NAME.toLowerCase()
  );
}

/** Decide which rows of `tableId` are published (see the file header). */
export async function resolvePublishedFilter(
  adapter: VisibilityReads,
  tableId: string,
): Promise<PublishedFilter> {
  const status = (await adapter.getColumns(tableId)).find(isStatusColumn);
  if (!status) return { kind: 'all' };
  const published = (await adapter.getSelectOptions(status.id)).find(
    (o) => o.name.trim().toLowerCase() === PUBLISHED_OPTION_NAME.toLowerCase(),
  );
  if (!published) return { kind: 'none' };
  return { kind: 'status', columnId: status.id, optionId: published.id };
}
