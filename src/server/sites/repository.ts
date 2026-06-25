import 'server-only';

// src/server/sites/repository.ts
//
// The site-persistence repository: the server-only door that makes Prisma the
// source of truth for the visual editor and the MST ProjectModel a working copy
// snapshotted in (load) and out (save).
//
// HARD ISOLATION CONTRACT (the whole point of P1b):
//   - EVERY read filters by `workspace_id`. A site that exists in another
//     workspace is invisible: a load/save for the wrong workspace returns
//     SiteNotFoundError, never another workspace's data.
//   - EVERY write stamps BOTH `workspace_id` AND `tenant_group_id` from the
//     caller-supplied tenant scope (resolved from the verified auth-brain
//     session, NEVER from the client-controlled MST tree). tenant_group_id is
//     denormalised onto every child row (site_pages / site_domains /
//     site_experiments) so a tenant_group-wide operation is index-backed and a
//     future B2B2C promotion needs no reshaping.
//
// framer-clone models NO identity here: these ids are opaque strings owned by
// auth-brain. This layer never reads a users/memberships table — authorization
// (can the caller act in this workspace) is the route's `can()` boundary; this
// layer is the data-scoping boundary.

import type { Prisma, PrismaClient } from '@prisma/client';
import { getPrismaClient } from '@/server/db';
import ProjectModel, { type ProjectModelType } from '@/models/ProjectModel';
import {
  projectToPersisted,
  persistedToProjectSnapshot,
  type PersistedSite,
  type SiteRowData,
} from './snapshot';
import { InvalidTenantScopeError, SiteNotFoundError } from './errors';

/**
 * The tenant scope every repository call is bound to. Resolved by the caller
 * from the verified session (the workspace the request acts in, and that
 * workspace's tenant_group). Both are required and non-empty; an empty scope is
 * rejected so a query can never accidentally widen past the isolation boundary.
 */
export interface TenantScope {
  workspaceId: string;
  tenantGroupId: string;
}

/** A lightweight site summary for listings (no page snapshots loaded). */
export interface SiteSummary {
  siteId: string;
  name: string;
  description: string;
  status: string;
  lumitraEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

function assertScope(scope: TenantScope): void {
  if (
    !scope ||
    typeof scope.workspaceId !== 'string' ||
    scope.workspaceId.length === 0 ||
    typeof scope.tenantGroupId !== 'string' ||
    scope.tenantGroupId.length === 0
  ) {
    throw new InvalidTenantScopeError();
  }
}

export class SiteRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * List the sites in the caller's workspace, newest first. No page snapshots
   * loaded — a cheap index-backed scan for a dashboard listing.
   */
  async listSites(scope: TenantScope): Promise<SiteSummary[]> {
    assertScope(scope);
    const rows = await this.prisma.site.findMany({
      where: { workspaceId: scope.workspaceId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        description: true,
        status: true,
        lumitraEnabled: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return rows.map((r) => ({
      siteId: r.id,
      name: r.name,
      description: r.description,
      status: r.status,
      lumitraEnabled: r.lumitraEnabled,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  }

  /**
   * Load a site + all its pages, scoped to the caller's workspace, and rebuild
   * a live ProjectModel (the editor working copy). Throws SiteNotFoundError
   * when the site is absent OR belongs to another workspace — the two are
   * indistinguishable so existence never leaks across the boundary.
   */
  async loadProject(scope: TenantScope, siteId: string): Promise<ProjectModelType> {
    assertScope(scope);
    // workspace_id IS in the where-clause, so a cross-workspace site simply
    // returns null here — never another tenant's data.
    const row = await this.prisma.site.findFirst({
      where: { id: siteId, workspaceId: scope.workspaceId },
      select: {
        id: true,
        name: true,
        description: true,
        analyticsProjectId: true,
        ingestionEndpoint: true,
        apiKeyRef: true,
        lumitraEnabled: true,
        projectCreatedAt: true,
        projectUpdatedAt: true,
        pages: {
          select: { pageId: true, snapshot: true },
        },
      },
    });
    if (!row) throw new SiteNotFoundError(siteId);

    const rowData: SiteRowData = {
      id: row.id,
      name: row.name,
      description: row.description,
      analyticsProjectId: row.analyticsProjectId,
      ingestionEndpoint: row.ingestionEndpoint,
      apiKeyRef: row.apiKeyRef,
      lumitraEnabled: row.lumitraEnabled,
      projectCreatedAt: row.projectCreatedAt,
      projectUpdatedAt: row.projectUpdatedAt,
      pages: row.pages.map((p) => ({ pageId: p.pageId, snapshot: p.snapshot })),
    };

    return ProjectModel.create(persistedToProjectSnapshot(rowData));
  }

  /**
   * Persist a ProjectModel (live instance or its SnapshotOut) into the
   * `sites` + `site_pages` tables, scoped to the caller's workspace. Upsert
   * semantics: the site row is created or updated by id, and pages are
   * reconciled (upsert present, delete removed) so a save reflects the editor
   * state exactly. The whole save runs in one transaction so a site is never
   * left with a half-written page set.
   *
   * A save of a site id that already exists in ANOTHER workspace is rejected
   * (SiteNotFoundError): the id is "taken" by a foreign tenant and must not be
   * silently overwritten or duplicated across the boundary.
   */
  async saveProject(
    scope: TenantScope,
    project: ProjectModelType | Parameters<typeof projectToPersisted>[0],
  ): Promise<void> {
    assertScope(scope);
    const persisted: PersistedSite = projectToPersisted(project);

    await this.prisma.$transaction(async (tx) => {
      // Guard: if this site id already exists, it MUST be in the caller's
      // workspace. A row in another workspace means a cross-tenant collision —
      // refuse rather than overwrite or leak.
      const existing = await tx.site.findUnique({
        where: { id: persisted.siteId },
        select: { id: true, workspaceId: true },
      });
      if (existing && existing.workspaceId !== scope.workspaceId) {
        throw new SiteNotFoundError(persisted.siteId);
      }

      // Upsert the site row. On create, status defaults to `draft` (the DB
      // default); on update, status is left untouched (publish/archive own it).
      await tx.site.upsert({
        where: { id: persisted.siteId },
        create: {
          id: persisted.siteId,
          workspaceId: scope.workspaceId,
          tenantGroupId: scope.tenantGroupId,
          name: persisted.name,
          description: persisted.description,
          analyticsProjectId: persisted.analyticsProjectId,
          ingestionEndpoint: persisted.ingestionEndpoint,
          apiKeyRef: persisted.apiKeyRef,
          lumitraEnabled: persisted.lumitraEnabled,
          projectCreatedAt: new Date(persisted.projectCreatedAt),
          projectUpdatedAt: new Date(persisted.projectUpdatedAt),
        },
        update: {
          name: persisted.name,
          description: persisted.description,
          analyticsProjectId: persisted.analyticsProjectId,
          ingestionEndpoint: persisted.ingestionEndpoint,
          apiKeyRef: persisted.apiKeyRef,
          lumitraEnabled: persisted.lumitraEnabled,
          // projectCreatedAt is immutable (set on create); only the
          // application "last edited" time advances on update.
          projectUpdatedAt: new Date(persisted.projectUpdatedAt),
        },
      });

      // Reconcile pages: upsert every current page, then delete any page row
      // whose pageId is no longer present in the snapshot. tenant_group_id and
      // workspace_id are stamped on every child row.
      const keepPageIds = persisted.pages.map((p) => p.pageId);

      for (const page of persisted.pages) {
        await tx.sitePage.upsert({
          where: {
            siteId_pageId: { siteId: persisted.siteId, pageId: page.pageId },
          },
          create: {
            siteId: persisted.siteId,
            workspaceId: scope.workspaceId,
            tenantGroupId: scope.tenantGroupId,
            pageId: page.pageId,
            slug: page.slug,
            snapshot: page.snapshot as Prisma.InputJsonValue,
          },
          update: {
            slug: page.slug,
            snapshot: page.snapshot as Prisma.InputJsonValue,
          },
        });
      }

      // Delete page rows no longer in the snapshot. When the snapshot has zero
      // pages, `notIn: []` in Prisma matches NOTHING, so the empty case is
      // handled explicitly: delete every page for the site.
      await tx.sitePage.deleteMany({
        where:
          keepPageIds.length > 0
            ? { siteId: persisted.siteId, pageId: { notIn: keepPageIds } }
            : { siteId: persisted.siteId },
      });
    });
  }

  /**
   * Transition a site to the `published` status, scoped to the caller's
   * workspace. saveProject deliberately PRESERVES `Site.status` on update
   * ("publish/archive own it"), so the publish path flips the status here as a
   * separate, scoped step after the snapshot has been persisted.
   *
   * The update is scoped by BOTH id AND workspace_id (via updateMany, since a
   * by-unique-id update cannot carry an extra where clause), so a publish of a
   * site id owned by another workspace matches zero rows and throws
   * SiteNotFoundError rather than silently flipping a foreign tenant's row.
   */
  async publishProject(scope: TenantScope, siteId: string): Promise<void> {
    assertScope(scope);
    const result = await this.prisma.site.updateMany({
      where: { id: siteId, workspaceId: scope.workspaceId },
      data: { status: 'published' },
    });
    if (result.count === 0) throw new SiteNotFoundError(siteId);
  }

  /**
   * Delete a site (and, by FK cascade, its pages/domains/experiments), scoped
   * to the caller's workspace. A delete for a site in another workspace affects
   * zero rows and throws SiteNotFoundError rather than silently succeeding.
   */
  async deleteSite(scope: TenantScope, siteId: string): Promise<void> {
    assertScope(scope);
    const result = await this.prisma.site.deleteMany({
      where: { id: siteId, workspaceId: scope.workspaceId },
    });
    if (result.count === 0) throw new SiteNotFoundError(siteId);
  }
}

let cached: SiteRepository | null = null;

/**
 * The process-wide site repository over the shared PrismaClient. Constructed
 * lazily so importing this module costs nothing and `next build` needs no live
 * database.
 */
export function getSiteRepository(): SiteRepository {
  if (!cached) cached = new SiteRepository(getPrismaClient());
  return cached;
}
