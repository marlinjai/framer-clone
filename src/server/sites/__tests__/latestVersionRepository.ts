// A SiteRepository for integration tests of behaviour OTHER than the version
// lock (revisions, erasure, components, slugs, deletes): a save or publish that
// names no `expectedVersion` writes over whatever version is stored right
// before it, as an editor tab that has just loaded the site would. An explicit
// `expectedVersion` passes through untouched. The lock itself is proven
// against the plain repository in versionLock.itest.ts.

import type { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '@/server/db';
import { SiteRepository, type WorkingCopyWriteOptions } from '../repository';
import { projectToPersisted } from '../snapshot';

type ProjectArg = Parameters<SiteRepository['saveProject']>[1];

export class LatestVersionRepository extends SiteRepository {
  constructor(private readonly db: PrismaClient) {
    super(db);
  }

  private async storedVersion(project: ProjectArg): Promise<number | undefined> {
    const row = await this.db.site.findUnique({
      where: { id: projectToPersisted(project).siteId },
      select: { version: true },
    });
    return row?.version;
  }

  override async saveProject(scope: Parameters<SiteRepository['saveProject']>[0], project: ProjectArg, options: WorkingCopyWriteOptions = {}) {
    const expectedVersion = options.expectedVersion ?? (await this.storedVersion(project));
    return super.saveProject(scope, project, { ...options, expectedVersion });
  }

  override async publishProject(
    scope: Parameters<SiteRepository['publishProject']>[0],
    project: ProjectArg,
    options: Parameters<SiteRepository['publishProject']>[2] = {},
  ) {
    const expectedVersion = options.expectedVersion ?? (await this.storedVersion(project));
    return super.publishProject(scope, project, { ...options, expectedVersion });
  }
}

export function latestVersionRepository(): LatestVersionRepository {
  return new LatestVersionRepository(getPrismaClient());
}
