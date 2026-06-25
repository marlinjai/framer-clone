// src/server/sites/snapshot.ts
//
// PURE MST <-> persistence mapping for the P1b site-persistence layer. NO
// Prisma, NO `server-only`, NO network: this module is the lossless translator
// between an MST ProjectModel snapshot (the editor working copy) and the
// row-shaped form the `sites` / `site_pages` tables store. Keeping it pure and
// dependency-free makes the round-trip unit-testable without a database and
// lets both the server repository (write/read) and the editor store reuse one
// mapping.
//
// The contract is "snapshot in / snapshot out": Prisma is the source of truth,
// the MST tree is reconstructed from a snapshot on load and serialized to a
// snapshot on save. We deliberately persist the FULL PageModel SnapshotOut per
// page (metadata + appComponentTree + canvasNodes) as opaque JSON, so the page
// tree round-trips byte-for-byte and the persistence layer never needs to know
// the component schema (which evolves independently in ComponentModel).

import { getSnapshot, isStateTreeNode } from 'mobx-state-tree';
import type {
  ProjectModelType,
  ProjectSnapshotIn,
  ProjectSnapshotOut,
} from '@/models/ProjectModel';
import type { PageSnapshotIn, PageSnapshotOut } from '@/models/PageModel';

/**
 * The persistence-shaped form of a single page: the MST page identifier, its
 * slug (mirrored out of the snapshot for URL resolution without a JSON parse),
 * and the full PageModel SnapshotOut as opaque JSON.
 */
export interface PersistedPage {
  /** MST PageModel.id — stable across saves, unique within a site. */
  pageId: string;
  /** Mirrored from the page snapshot so the router can resolve by URL. */
  slug: string;
  /** Full PageModel SnapshotOut. Opaque to this layer. */
  snapshot: PageSnapshotOut;
}

/**
 * The persistence-shaped form of a whole project (== a site). Splits the MST
 * ProjectModel snapshot into the scalar site fields the `sites` row stores plus
 * the per-page array the `site_pages` rows store. Tenant scope
 * (workspace_id / tenant_group_id) is NOT part of this shape: it is supplied by
 * the caller from the verified session and stamped onto the rows by the
 * repository, never derived from the (client-controlled) MST tree.
 */
export interface PersistedSite {
  /** MST ProjectModel.id — the site id. */
  siteId: string;
  /** ProjectModel.metadata.title. */
  name: string;
  /** ProjectModel.metadata.description. */
  description: string;
  /** LumitraBindingModel.projectId (the analytics project id), if bound. */
  analyticsProjectId: string | null;
  /** LumitraBindingModel.ingestionEndpoint, if set. */
  ingestionEndpoint: string | null;
  /** LumitraBindingModel.apiKeyRef — a server-side ref, NEVER the literal key. */
  apiKeyRef: string | null;
  /** LumitraBindingModel.enabled — gates snippet injection on publish. */
  lumitraEnabled: boolean;
  /**
   * ProjectModel.metadata.createdAt as epoch ms (MST `types.Date` serializes to
   * a number). Persisted so it survives a load -> save round-trip.
   */
  projectCreatedAt: number;
  /** ProjectModel.metadata.updatedAt as epoch ms. */
  projectUpdatedAt: number;
  /** One entry per MST page. */
  pages: PersistedPage[];
}

/**
 * Serialize a live ProjectModel instance (or its already-taken SnapshotOut)
 * into the persistence shape. Pages are emitted in stable insertion order so a
 * save produces a deterministic row set.
 *
 * Note on `status`: the MST ProjectModel has no `status` field today (the
 * SiteStatus enum lives only on the persistence row, driven by the
 * publish/archive lifecycle). So status is intentionally NOT part of this
 * mapping — the repository preserves the existing row status on update and
 * defaults to `draft` on create.
 */
export function projectToPersisted(
  project: ProjectModelType | ProjectSnapshotOut,
): PersistedSite {
  // Accept either a live MST instance or an already-taken SnapshotOut.
  // `isStateTreeNode` is MST's canonical instance check; `getSnapshot` would
  // throw on a plain object, so we only call it for true nodes.
  const snap: ProjectSnapshotOut = isStateTreeNode(project)
    ? (getSnapshot(project) as ProjectSnapshotOut)
    : (project as ProjectSnapshotOut);

  const pagesRecord = (snap.pages ?? {}) as Record<string, PageSnapshotOut>;
  const pages: PersistedPage[] = Object.entries(pagesRecord).map(
    ([pageId, pageSnap]) => ({
      pageId,
      slug: pageSnap.slug ?? '',
      snapshot: pageSnap,
    }),
  );

  return {
    siteId: snap.id,
    name: snap.metadata.title,
    description: snap.metadata.description ?? '',
    analyticsProjectId: snap.lumitra?.projectId ?? null,
    ingestionEndpoint: snap.lumitra?.ingestionEndpoint ?? null,
    apiKeyRef: snap.lumitra?.apiKeyRef ?? null,
    lumitraEnabled: snap.lumitra?.enabled ?? false,
    // MST `types.Date` serializes to epoch ms in the SnapshotOut.
    projectCreatedAt: snap.metadata.createdAt as number,
    projectUpdatedAt: snap.metadata.updatedAt as number,
    pages,
  };
}

/**
 * The row data the repository read returns, before reassembly into MST. Mirrors
 * the columns the `sites` + `site_pages` query selects. Decoupled from the
 * Prisma row type so this pure module never imports `@prisma/client`.
 */
export interface SiteRowData {
  id: string;
  name: string;
  description: string;
  analyticsProjectId: string | null;
  ingestionEndpoint: string | null;
  apiKeyRef: string | null;
  lumitraEnabled: boolean;
  /** Persistence-layer Date columns (Prisma returns `Date`). */
  projectCreatedAt: Date;
  projectUpdatedAt: Date;
  pages: Array<{ pageId: string; snapshot: unknown }>;
}

/**
 * Rebuild a ProjectModel SnapshotIn from persisted row data. The caller feeds
 * the result to `ProjectModel.create(...)` to materialize the editor working
 * copy. The `lumitra` block is reconstructed only when at least one binding
 * field is present, so a site with no analytics binding loads with the MST
 * default empty block (enabled=false) rather than an all-null object.
 */
export function persistedToProjectSnapshot(row: SiteRowData): ProjectSnapshotIn {
  const pages: Record<string, PageSnapshotIn> = {};
  for (const page of row.pages) {
    // The stored snapshot IS a PageModel SnapshotOut, which is structurally a
    // valid SnapshotIn. Cast at this single boundary; the round-trip test
    // proves the shape.
    pages[page.pageId] = page.snapshot as PageSnapshotIn;
  }

  const hasBinding =
    row.analyticsProjectId !== null ||
    row.ingestionEndpoint !== null ||
    row.apiKeyRef !== null ||
    row.lumitraEnabled;

  const snapshot: ProjectSnapshotIn = {
    id: row.id,
    metadata: {
      title: row.name,
      description: row.description,
      // MST `types.Date` accepts a number (epoch ms) or Date in SnapshotIn.
      // Restore the application-meaningful timestamps so they survive the
      // round-trip instead of resetting to "now".
      createdAt: row.projectCreatedAt.getTime(),
      updatedAt: row.projectUpdatedAt.getTime(),
    },
    pages,
  };

  if (hasBinding) {
    snapshot.lumitra = {
      projectId: row.analyticsProjectId ?? undefined,
      ingestionEndpoint: row.ingestionEndpoint ?? undefined,
      apiKeyRef: row.apiKeyRef ?? undefined,
      enabled: row.lumitraEnabled,
    };
  }

  return snapshot;
}
