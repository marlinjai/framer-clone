import 'server-only';

// src/server/sites/branches/documents.ts
//
// The three documents of a branch review as the merge engine reads them (docs/plans/2026-11-10-site-branches.md,
// slice S3), and the way back to a save.
//
// Every document goes through the editor model first (decision 35): a document written without the model's
// defaults (an import, an old tool) would otherwise count as changed in every node. A load may add (default
// breakpoint frames, a shop control's parts) but must never lose anything: a page, a component definition or a
// node the stored copy has and the model's copy does not would read as a removal, and the merge would write
// it. Such a document is refused with the reason, and nothing is written.
//
// Pages are sorted by id: `site_pages` stores no order, so a stable one keeps two reads of the same rows equal.

import { getSnapshot } from 'mobx-state-tree';
import ProjectModel, { type ProjectSnapshotOut } from '@/models/ProjectModel';
import type { MergeDocument } from '@/lib/siteMerge';
import { documentBodies, treesOf, walkNodes } from '@/lib/siteMerge/references';
import { persistedToProjectSnapshot, projectToPersisted, type PersistedSite } from '../snapshot';
import { BranchMergeInvalidError } from '../errors';

/** A `sites` row with its pages, as the review reads main and the branch. */
export interface SiteDocumentRow {
  id: string;
  name: string;
  description: string;
  analyticsProjectId: string | null;
  ingestionEndpoint: string | null;
  apiKeyRef: string | null;
  lumitraEnabled: boolean;
  siteSettings: unknown;
  components: unknown;
  /** Main's own (a save derives them); kept in a stored copy of main, never merged. */
  redirects: unknown;
  projectCreatedAt: Date;
  projectUpdatedAt: Date;
  erasureEpoch: number;
  pages: Array<{ pageId: string; slug: string; snapshot: unknown }>;
}

/** The columns of {@link SiteDocumentRow}, for a Prisma `select`. */
export const SITE_DOCUMENT_SELECT = {
  id: true,
  name: true,
  description: true,
  analyticsProjectId: true,
  ingestionEndpoint: true,
  apiKeyRef: true,
  lumitraEnabled: true,
  siteSettings: true,
  components: true,
  redirects: true,
  projectCreatedAt: true,
  projectUpdatedAt: true,
  erasureEpoch: true,
  pages: { select: { pageId: true, slug: true, snapshot: true } },
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The editor model's copy of a document, stored the way a save stores it. */
function throughModel(row: SiteDocumentRow): PersistedSite {
  const project = ProjectModel.create(
    persistedToProjectSnapshot({
      id: row.id,
      name: row.name,
      description: row.description,
      analyticsProjectId: row.analyticsProjectId,
      ingestionEndpoint: row.ingestionEndpoint,
      apiKeyRef: row.apiKeyRef,
      lumitraEnabled: row.lumitraEnabled,
      siteSettings: row.siteSettings,
      components: row.components,
      projectCreatedAt: row.projectCreatedAt,
      projectUpdatedAt: row.projectUpdatedAt,
      erasureEpoch: row.erasureEpoch,
      pages: row.pages,
    }),
  );
  return projectToPersisted(getSnapshot(project) as ProjectSnapshotOut);
}

function asDocument(persisted: PersistedSite): MergeDocument {
  return JSON.parse(
    JSON.stringify({
      name: persisted.name,
      description: persisted.description,
      analyticsProjectId: persisted.analyticsProjectId,
      ingestionEndpoint: persisted.ingestionEndpoint,
      apiKeyRef: persisted.apiKeyRef,
      lumitraEnabled: persisted.lumitraEnabled,
      // Main's own: a save derives them (section 4). The merge carries main's, and nothing writes these.
      redirects: [],
      siteSettings: persisted.siteSettings,
      pages: [...persisted.pages]
        .sort((a, b) => (a.pageId < b.pageId ? -1 : a.pageId > b.pageId ? 1 : 0))
        .map((p) => ({ pageId: p.pageId, slug: p.slug, snapshot: p.snapshot })),
      components: persisted.components ?? {},
    }),
  ) as MergeDocument;
}

/** The ids a document holds: its pages, its component definitions, and every node of each. */
function idsOf(doc: Pick<MergeDocument, 'pages' | 'components'>): Set<string> {
  const ids = new Set<string>();
  for (const page of doc.pages) ids.add(`page:${page.pageId}`);
  for (const id of Object.keys(isRecord(doc.components) ? doc.components : {})) ids.add(`component:${id}`);
  for (const [container, body] of documentBodies(doc as MergeDocument)) {
    for (const node of walkNodes(treesOf(body))) if (typeof node.id === 'string') ids.add(`${container}/${node.id}`);
  }
  return ids;
}

/**
 * A site's stored working copy as the merge reads it, through the editor model. `side` names it in the refusal
 * when the model's copy lost something the stored one holds.
 */
export function reviewDocument(row: SiteDocumentRow, side: 'main' | 'branch' | 'base'): MergeDocument {
  const doc = asDocument(throughModel(row));
  if (side === 'base') return doc;
  const kept = idsOf(doc);
  const lost = [...idsOf({ pages: row.pages as MergeDocument['pages'], components: row.components as MergeDocument['components'] })].filter(
    (id) => !kept.has(id),
  );
  if (lost.length > 0) {
    throw new BranchMergeInvalidError([
      {
        code: 'does_not_load',
        message: `${side === 'main' ? 'Main' : 'The branch'} holds ${lost.length} part(s) the editor cannot load (the first: ${lost[0]}). Open it in the editor and save it once, then try again.`,
      },
    ]);
  }
  return doc;
}

/** A stored revision document (a branch's fork point) as a row the model can load. */
export function revisionRow(id: string, doc: {
  name: string;
  description: string;
  analyticsProjectId: string | null;
  ingestionEndpoint: string | null;
  apiKeyRef: string | null;
  lumitraEnabled: boolean;
  siteSettings: unknown;
  components: unknown;
  pages: Array<{ pageId: string; slug: string; snapshot: unknown }>;
}, epoch: number): SiteDocumentRow {
  return {
    id,
    name: doc.name,
    description: doc.description,
    analyticsProjectId: doc.analyticsProjectId,
    ingestionEndpoint: doc.ingestionEndpoint,
    apiKeyRef: doc.apiKeyRef,
    lumitraEnabled: doc.lumitraEnabled,
    siteSettings: doc.siteSettings,
    components: doc.components,
    redirects: [],
    projectCreatedAt: new Date(0),
    projectUpdatedAt: new Date(0),
    erasureEpoch: epoch,
    pages: doc.pages,
  };
}

/**
 * A merged document as a save of the site `target`: loaded on the editor model once more (the result must load,
 * section 5), with the target's id, creation time and erasure epoch, so the save's own checks run on it as on
 * any other save. The name is not written by a save; the caller writes it.
 */
export function persistedFor(doc: MergeDocument, target: Pick<SiteDocumentRow, 'id' | 'projectCreatedAt' | 'erasureEpoch'>, now: Date): PersistedSite {
  return throughModel({
    id: target.id,
    name: doc.name,
    description: doc.description,
    analyticsProjectId: doc.analyticsProjectId,
    ingestionEndpoint: doc.ingestionEndpoint,
    apiKeyRef: doc.apiKeyRef,
    lumitraEnabled: doc.lumitraEnabled,
    siteSettings: doc.siteSettings,
    components: doc.components,
    redirects: [],
    projectCreatedAt: target.projectCreatedAt,
    projectUpdatedAt: now,
    erasureEpoch: target.erasureEpoch,
    pages: doc.pages,
  });
}

/** A document as the editor model loads it, for the merge's validity check (`mergedDocumentProblems`). */
export function toProjectSnapshot(doc: MergeDocument) {
  return persistedToProjectSnapshot({
    id: 'merge-check',
    name: doc.name,
    description: doc.description,
    analyticsProjectId: doc.analyticsProjectId,
    ingestionEndpoint: doc.ingestionEndpoint,
    apiKeyRef: doc.apiKeyRef,
    lumitraEnabled: doc.lumitraEnabled,
    siteSettings: doc.siteSettings,
    components: doc.components,
    projectCreatedAt: new Date(0),
    projectUpdatedAt: new Date(0),
    pages: doc.pages.map((p) => ({ pageId: p.pageId, snapshot: p.snapshot })),
  });
}
