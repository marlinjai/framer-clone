// SiteRepository.deleteSite against a real Postgres (the shared integration
// container). Proves what the unit tests can only model: the schema's
// ON DELETE CASCADE removes the site's pages, domains and experiment rows in
// the same transaction, the subdomain stops resolving, a refused delete
// changes nothing, other sites are untouched, Save cannot bring the site back,
// and a Save and a delete racing each other (both orders) never re-create it.
// (A LIVE custom-domain claim's release is proven in the domain service's
// integration tests, which own every live claim in the shared database.)

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

vi.mock('next/cache', () => ({ unstable_cache: vi.fn(), revalidateTag: vi.fn() }));

import { getPrismaClient } from '@/server/db';
import { getSnapshot } from 'mobx-state-tree';
import ProjectModel from '@/models/ProjectModel';
import { createIntrinsicComponent } from '@/models/ComponentModel';
import { SiteRepository, type TenantScope } from '../repository';
import { SiteDeleteConfirmationError, SiteGoneError, SiteNotFoundError } from '../errors';
import { resolvePublishedSite } from '../publicResolver';

const TG = '018f9c10-0000-7000-8000-0000000000e1';
const OTHER_TG = '018f9c10-0000-7000-8000-0000000000e2';
const SCOPE: TenantScope = { workspaceId: 'ws_del', tenantGroupId: TG };
const BASE = 'sites.lumitra.co';

let prisma: PrismaClient;
let repo: SiteRepository;

async function makeSite(id: string, opts: { status?: 'draft' | 'published'; workspaceId?: string; tg?: string } = {}) {
  const now = new Date();
  await prisma.site.create({
    data: {
      id,
      workspaceId: opts.workspaceId ?? SCOPE.workspaceId,
      tenantGroupId: opts.tg ?? TG,
      name: `Name of ${id}`,
      status: opts.status ?? 'published',
      projectCreatedAt: now,
      projectUpdatedAt: now,
    },
  });
  const ws = opts.workspaceId ?? SCOPE.workspaceId;
  const tg = opts.tg ?? TG;
  await prisma.sitePage.create({
    data: { siteId: id, workspaceId: ws, tenantGroupId: tg, pageId: `${id}-home`, slug: '', snapshot: {} },
  });
  await prisma.siteExperiment.create({
    data: { siteId: id, workspaceId: ws, tenantGroupId: tg, experimentKey: `${id}-exp` },
  });
  await prisma.siteDomain.create({
    data: { siteId: id, workspaceId: ws, tenantGroupId: tg, subdomain: `${id}lbl`, verificationStatus: 'active', isPrimary: true },
  });
  await prisma.siteDomain.create({
    data: {
      siteId: id,
      workspaceId: ws,
      tenantGroupId: tg,
      // A requested (pending) custom domain, never a LIVE claim: the domain
      // service's tests share this database, run in parallel and count every
      // live claim. Releasing a live claim on delete is proven there
      // (src/server/domains/__tests__/service.itest.ts, "project deleted").
      hostname: `www.${id}.example.com`,
      verificationStatus: 'pending',
      verificationToken: `tok-${id}`,
    },
  });
}

async function counts(siteId: string) {
  const [pages, domains, experiments, site] = await Promise.all([
    prisma.sitePage.count({ where: { siteId } }),
    prisma.siteDomain.count({ where: { siteId } }),
    prisma.siteExperiment.count({ where: { siteId } }),
    prisma.site.count({ where: { id: siteId } }),
  ]);
  return { site, pages, domains, experiments };
}

async function cleanup() {
  for (const tg of [TG, OTHER_TG]) {
    await prisma.siteDomain.deleteMany({ where: { tenantGroupId: tg } });
    await prisma.site.deleteMany({ where: { tenantGroupId: tg } });
  }
}

beforeAll(() => {
  prisma = getPrismaClient();
  repo = new SiteRepository(prisma);
});
beforeEach(cleanup);
afterAll(cleanup);

describe('deleteSite (real database)', () => {
  it('cascades pages, domains and experiments, and the subdomain stops resolving', async () => {
    await makeSite('delpub');
    await makeSite('keepme');
    expect((await resolvePublishedSite(`delpublbl.${BASE}`, prisma, BASE))?.siteId).toBe('delpub');

    const out = await repo.deleteSite(SCOPE, 'delpub', { confirmName: 'Name of delpub' });

    expect(out).toEqual({
      siteId: 'delpub',
      name: 'Name of delpub',
      wasPublished: true,
      subdomain: 'delpublbl',
      hostnames: ['www.delpub.example.com'],
    });
    expect(await counts('delpub')).toEqual({ site: 0, pages: 0, domains: 0, experiments: 0 });
    expect(await resolvePublishedSite(`delpublbl.${BASE}`, prisma, BASE)).toBeNull();
    expect((await resolvePublishedSite(`keepmelbl.${BASE}`, prisma, BASE))?.siteId).toBe('keepme');
    expect(await counts('keepme')).toEqual({ site: 1, pages: 1, domains: 2, experiments: 1 });
  });

  it('a refused delete (published, wrong name) changes nothing', async () => {
    await makeSite('refused');
    await expect(repo.deleteSite(SCOPE, 'refused', { confirmName: 'nope' })).rejects.toBeInstanceOf(
      SiteDeleteConfirmationError,
    );
    expect(await counts('refused')).toEqual({ site: 1, pages: 1, domains: 2, experiments: 1 });
  });

  it("another company's site is a 404 and stays whole", async () => {
    await makeSite('foreign', { workspaceId: 'ws_other', tg: OTHER_TG });
    await expect(repo.deleteSite(SCOPE, 'foreign', { confirmName: 'Name of foreign' })).rejects.toBeInstanceOf(
      SiteNotFoundError,
    );
    expect(await counts('foreign')).toEqual({ site: 1, pages: 1, domains: 2, experiments: 1 });
  });

  it('an unpublished site needs no name, and Save cannot recreate it afterwards', async () => {
    await makeSite('draftone', { status: 'draft' });
    await repo.deleteSite(SCOPE, 'draftone');
    const stale = ProjectModel.create({ id: 'draftone', metadata: { title: 'Name of draftone', description: '' }, pages: {} });
    await expect(repo.saveProject(SCOPE, stale, { mustExist: true })).rejects.toBeInstanceOf(SiteGoneError);
    expect(await counts('draftone')).toEqual({ site: 0, pages: 0, domains: 0, experiments: 0 });
  });

  it('race: a delete that starts while a Save holds the row waits, then removes everything', async () => {
    await makeSite('race1', { status: 'draft' });
    let release!: () => void;
    const hold = new Promise<void>((r) => { release = r; });
    // A Save in flight: its UPDATE holds the row lock until it commits.
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => { locked = r; });
    const save = prisma.$transaction(async (tx) => {
      await tx.site.updateMany({ where: { id: 'race1' }, data: { description: 'saving' } });
      locked();
      await hold;
    }, { timeout: 20_000 });
    await isLocked;
    let deleteDone = false;
    const del = repo.deleteSite(SCOPE, 'race1').then((r) => { deleteDone = true; return r; });
    await new Promise((r) => setTimeout(r, 300));
    expect(deleteDone).toBe(false); // blocked behind the save's lock
    release();
    await save;
    await del;
    expect(await counts('race1')).toEqual({ site: 0, pages: 0, domains: 0, experiments: 0 });
  });

  it('race: a Save that started while the delete holds the row is refused and re-creates nothing', async () => {
    await makeSite('race2', { status: 'draft' });
    let release!: () => void;
    const hold = new Promise<void>((r) => { release = r; });
    // A delete in flight: row locked and deleted, not yet committed.
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => { locked = r; });
    const del = prisma.$transaction(async (tx) => {
      await tx.site.deleteMany({ where: { id: 'race2' } });
      locked();
      await hold;
    }, { timeout: 20_000 });
    await isLocked;
    // The editor's copy: the same home page the database holds (so the slug
    // rules pass and the only thing in the way is the delete).
    const stale = ProjectModel.create({
      id: 'race2',
      metadata: { title: 'Name of race2', description: '' },
      pages: {
        'race2-home': {
          id: 'race2-home',
          slug: '',
          metadata: { title: 'Home', description: '' },
          appComponentTree: getSnapshot(createIntrinsicComponent('root-race2', 'div', {})),
          canvasNodes: {},
        },
      },
    });
    const save = repo.saveProject(SCOPE, stale, { mustExist: true }).then(
      () => 'saved',
      (e) => e,
    );
    await new Promise((r) => setTimeout(r, 300));
    release();
    await del;
    const outcome = await save;
    expect(outcome).toBeInstanceOf(SiteGoneError);
    expect(await counts('race2')).toEqual({ site: 0, pages: 0, domains: 0, experiments: 0 });
  });
});
