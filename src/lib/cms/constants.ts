// src/lib/cms/constants.ts
//
// Client-safe CMS constants. CMS_WORKSPACE_ID is the single-tenant workspace the
// Phase-1 CMS is pinned to. It lives here (NOT in the server-only adapterClient)
// so both the server adapter and the client editing grid (the DataTableProvider
// `workspaceId` prop) share ONE source of truth without a client component
// importing a `server-only` module.

/** The single-tenant CMS workspace id (Phase 1; E7 makes this per-tenant). */
export const CMS_WORKSPACE_ID = 'framer-clone';

/**
 * The reserved per-collection publish-state field. Each collection gets a
 * "Status" select column with Draft / Published / Scheduled options (the binding
 * / storefront can later filter to Published). Returned by the `ensureStatusField`
 * server action so the grid can default new items to Draft.
 */
export interface CmsStatusField {
  columnId: string;
  options: { draft: string; published: string; scheduled: string };
}
