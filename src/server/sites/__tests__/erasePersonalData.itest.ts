// src/server/sites/__tests__/erasePersonalData.itest.ts
//
// Erasing one personal value from a site's history, against a REAL Postgres (the
// throwaway container of the integration globalSetup, never a shared database).
// Plan: docs/plans/2026-11-01-immutable-published-copy.md, "Erasing personal data
// from the history". Every assertion about visitors goes through
// `resolvePublishedSiteByKey`, what a cache miss runs.
//
// The four paths of a stateful flow: forward (search, erase, proof), backtrack
// (something changed between the preview and the erase), resume (a failed erase
// changed nothing and is simply repeated), re-entry (a second erase finds
// nothing). Plus the fence for editor tabs loaded before an erase, races with
// save and publish, a site from before revisions, and the audit row.
//
// Runs only under `pnpm test:integration` (Docker).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { getSnapshot } from 'mobx-state-tree';
import { randomUUID } from 'node:crypto';
import { getPrismaClient } from '@/server/db';
import {
  ErasePreviewStaleError,
  getSiteRepository,
  NothingToEraseError,
  SiteErasedSinceLoadError,
  SiteNotFoundError,
  type TenantScope,
} from '@/server/sites';
import { ERASE_LIMITS, EraseQueryError, REDACTED_SEGMENT } from '@/server/sites/erase';
import { resolvePublishedSiteByKey, type PublishedSite } from '@/server/sites/publicResolver';

const TENANT_GROUP = '018f9c10-0000-7000-8000-0000000052e1';
const VALUE = 'Max Mustermann';
const QUERY = { value: VALUE, caseSensitive: false };
const OWNER = 'user-owner';

let prisma: PrismaClient;
let scope: TenantScope;
let siteId: string;

function page(id: string, slug: string, text: string) {
  return {
    id,
    slug,
    metadata: { title: id, description: `About ${text}` },
    appComponentTree: {
      id: `root-${id}`,
      type: 'div',
      componentType: 'host',
      props: { children: text },
      children: [
        { id: `mail-${id}`, type: 'a', componentType: 'host', props: { href: `mailto:${text.replace(/ /g, '.')}@bakery.example`, title: text, children: 'Write' }, children: [] },
      ],
    },
    canvasNodes: {},
  };
}

/** A project snapshot whose text and managing director are `who`. */
function project(who: string, over: { slug?: string; erasureEpoch?: number } = {}) {
  const { slug = 'about', erasureEpoch } = over;
  return {
    id: siteId,
    metadata: { title: 'Bakery', description: '', createdAt: 1, updatedAt: 2, ...(erasureEpoch === undefined ? {} : { erasureEpoch }) },
    pages: { home: page('home', '', `Run by ${who}`), about: page('about', slug, `Ask ${who}`) },
    siteSettings: { siteName: 'Bakery', business: { legalName: 'Bakery GmbH', managingDirectors: [who] } },
  } as never;
}

async function subdomainOf(): Promise<string> {
  return (await getSiteRepository().ensureSiteDomain(scope, siteId)).subdomain;
}

async function visit(): Promise<PublishedSite | null> {
  return resolvePublishedSiteByKey({ kind: 'subdomain', value: await subdomainOf() }, prisma);
}

async function revisions() {
  return prisma.siteRevision.findMany({
    where: { siteId },
    orderBy: { number: 'asc' },
    select: { id: true, number: true, kind: true, publishedBy: true, createdAt: true, rewrittenAt: true, document: true },
  });
}

/** Everything stored for the site that a value could hide in, as one string. */
async function everything(): Promise<string> {
  const site = await prisma.site.findUniqueOrThrow({
    where: { id: siteId },
    select: { name: true, description: true, siteSettings: true, components: true, redirects: true, pages: { select: { snapshot: true, slug: true } } },
  });
  return JSON.stringify([site, (await revisions()).map((r) => r.document)]);
}

/** Every erasable match a preview lists: what an owner ticking everything shown sends. */
function allShown(preview: { matches: Array<{ id: string; blocked: string | null }> }): string[] {
  return preview.matches.filter((m) => m.blocked === null).map((m) => m.id);
}

async function erase(over: { replacement?: string; chosen?: string[]; token?: string } = {}) {
  const repo = getSiteRepository();
  const preview = await repo.searchPersonalData(scope, siteId, QUERY);
  return repo.erasePersonalData(scope, siteId, {
    query: QUERY,
    replacement: over.replacement ?? '[entfernt]',
    token: over.token ?? preview.token,
    chosen: over.chosen ?? allShown(preview),
    erasedBy: OWNER,
  });
}

beforeAll(() => {
  prisma = getPrismaClient();
});

beforeEach(async () => {
  siteId = randomUUID();
  scope = { workspaceId: `ws_erase_${randomUUID().slice(0, 8)}`, tenantGroupId: TENANT_GROUP };
  await getSiteRepository().saveProject(scope, project('Erika Muster'));
});

afterAll(async () => {
  await prisma.site.deleteMany({ where: { tenantGroupId: TENANT_GROUP } });
  await prisma.siteErasure.deleteMany({ where: { tenantGroupId: TENANT_GROUP } });
  await prisma.$disconnect();
});

describe('forward: search, erase, proof', () => {
  it('finds the value in every kept version and the working copy, then erases exactly it', async () => {
    const repo = getSiteRepository();
    await repo.publishProject(scope, project(VALUE), { publishedBy: 'user-a' });
    await repo.publishProject(scope, project('Erika Muster'), { publishedBy: 'user-b' });
    await repo.publishProject(scope, project(VALUE), { publishedBy: 'user-a' });
    await repo.saveProject(scope, project(VALUE), { mustExist: true });
    await repo.rollbackToRevision(scope, siteId, 1);

    const preview = await repo.searchPersonalData(scope, siteId, QUERY);
    // Per document: 2 page texts, 2 page descriptions, 2 link titles, 1 managing director = 7.
    expect(preview.locations.map((l) => [l.location, l.matches, l.live])).toEqual([
      [{ kind: 'working' }, 7, false],
      [{ kind: 'revision', number: 3 }, 7, false],
      [{ kind: 'revision', number: 2 }, 0, false],
      [{ kind: 'revision', number: 1 }, 7, true],
    ]);
    expect(preview).toMatchObject({ total: 21, erasable: 21, blocked: 0, truncated: false });
    expect(preview.matches[0].excerpt).toContain(VALUE);

    const before = await revisions();
    const working = JSON.stringify(await prisma.site.findUniqueOrThrow({ where: { id: siteId }, select: { siteSettings: true } }));

    const result = await repo.erasePersonalData(scope, siteId, {
      query: QUERY,
      replacement: '[entfernt]',
      token: preview.token,
      chosen: allShown(preview),
      erasedBy: OWNER,
    });
    expect(result).toMatchObject({ erased: 21, remaining: 0 });

    // The proof: a fresh search finds nothing, and the value is nowhere in storage.
    expect((await repo.searchPersonalData(scope, siteId, QUERY)).total).toBe(0);
    expect(await everything()).not.toContain(VALUE);

    // Only the value changed: every document is the old one with the value replaced.
    const after = await revisions();
    for (const [i, revision] of after.entries()) {
      expect(JSON.stringify(revision.document)).toBe(JSON.stringify(before[i].document).replaceAll(VALUE, '[entfernt]'));
      expect(revision).toMatchObject({
        id: before[i].id,
        number: before[i].number,
        kind: before[i].kind,
        publishedBy: before[i].publishedBy,
        createdAt: before[i].createdAt,
      });
    }
    // A version without the value was not touched at all.
    expect(after.map((r) => r.rewrittenAt !== null)).toEqual([true, false, true]);
    expect(JSON.stringify(await prisma.site.findUniqueOrThrow({ where: { id: siteId }, select: { siteSettings: true } }))).toBe(
      working.replaceAll(VALUE, '[entfernt]'),
    );

    // The live site: still version 1, still published, rewritten.
    const site = await visit();
    expect(site?.revisionNumber).toBe(1);
    expect(JSON.stringify(site)).not.toContain(VALUE);
    expect(site?.siteSettings.business.managingDirectors).toEqual(['[entfernt]']);
    expect(site?.revision).toBe(`revision:${before[0].id}:${after[0].rewrittenAt!.toISOString()}`);

    // No rollback can bring it back.
    for (const number of [1, 2, 3]) {
      await repo.rollbackToRevision(scope, siteId, number);
      expect(JSON.stringify(await visit())).not.toContain(VALUE);
    }

    // The editor's working copy is clean too, and carries the new epoch.
    const loaded = getSnapshot(await repo.loadProject(scope, siteId));
    expect(JSON.stringify(loaded)).not.toContain(VALUE);
    expect(loaded.metadata.erasureEpoch).toBe(1);
  });

  it('writes one audit row with the places and never the value', async () => {
    const repo = getSiteRepository();
    await repo.publishProject(scope, project(VALUE));
    const result = await erase();

    const audit = await repo.listErasures(scope, siteId);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ id: result.erasureId, erasedBy: OWNER, erasedCount: result.erased, remainingCount: 0 });
    expect(audit[0].places).toContainEqual({
      location: 'revision',
      revision: 1,
      pageId: null,
      area: 'settings',
      path: '/siteSettings/business/managingDirectors/0',
    });
    expect(audit[0].places).toContainEqual(expect.objectContaining({ location: 'working', pageId: 'home', area: 'text' }));
    const raw = await prisma.siteErasure.findUniqueOrThrow({ where: { id: result.erasureId } });
    expect(JSON.stringify(raw)).not.toMatch(/mustermann/i);

    // The record outlives the site.
    await repo.deleteSite(scope, siteId, { confirmName: 'Bakery' });
    expect(await prisma.siteErasure.count({ where: { id: result.erasureId } })).toBe(1);
  });

  it('keeps the matches left out and the blocked ones, and reports them as remaining', async () => {
    const repo = getSiteRepository();
    // `mustermann` in a page address is blocked; everything else may go.
    await repo.publishProject(scope, project(VALUE, { slug: 'team-mustermann' }));
    const query = { value: 'Mustermann', caseSensitive: false };
    const preview = await repo.searchPersonalData(scope, siteId, query);
    const slugs = preview.matches.filter((m) => m.blocked === 'address');
    expect(slugs.map((m) => m.location.kind).sort()).toEqual(['revision', 'working']);
    expect(slugs.every((m) => /^\/pages\/\d+\/slug$/.test(m.path))).toBe(true);
    // Leave the managing director in the working copy (listed first) alone.
    const keep = preview.matches.find((m) => m.blocked === null && m.area === 'settings')!;
    expect(keep.location).toEqual({ kind: 'working' });

    const result = await repo.erasePersonalData(scope, siteId, {
      query,
      replacement: '',
      token: preview.token,
      chosen: allShown(preview).filter((id) => id !== keep.id),
      erasedBy: OWNER,
    });
    expect(result.remaining).toBe(3); // the slug in both documents, and the director left out
    const site = await visit();
    expect(site?.pages.find((p) => p.pageId === 'about')?.slug).toBe('team-mustermann');
    expect(site?.siteSettings.business.managingDirectors).toHaveLength(1);
    expect(JSON.stringify(site?.siteSettings.business.managingDirectors)).not.toMatch(/mustermann/i);
    const loaded = getSnapshot(await repo.loadProject(scope, siteId)) as { siteSettings: { business: { managingDirectors: string[] } } };
    expect(loaded.siteSettings.business.managingDirectors).toEqual([VALUE]);
    expect(JSON.stringify(site?.pages.find((p) => p.pageId === 'home')?.snapshot)).not.toMatch(/mustermann/i);
  });

  it('erases from a site published before revisions existed, which serves its working copy', async () => {
    await prisma.sitePage.updateMany({ where: { siteId }, data: { snapshot: page('home', '', `Run by ${VALUE}`) } });
    await prisma.sitePage.deleteMany({ where: { siteId, pageId: 'about' } });
    await prisma.site.update({ where: { id: siteId }, data: { status: 'published' } });
    const memoBefore = (await visit())?.revision;
    expect(JSON.stringify(await visit())).toContain(VALUE);

    await erase();
    const site = await visit();
    expect(site?.revisionNumber).toBeNull();
    expect(JSON.stringify(site)).not.toContain(VALUE);
    expect(site?.revision).not.toBe(memoBefore);
    expect(await prisma.siteRevision.count({ where: { siteId } })).toBe(0);
  });
});

describe('backtrack: something changed since the preview', () => {
  it('a publish in between: refused, nothing changed; a new search then erases', async () => {
    const repo = getSiteRepository();
    await repo.publishProject(scope, project(VALUE));
    const stale = await repo.searchPersonalData(scope, siteId, QUERY);
    await repo.publishProject(scope, project(VALUE), {});
    const before = await everything();

    await expect(erase({ token: stale.token })).rejects.toBeInstanceOf(ErasePreviewStaleError);
    expect(await everything()).toBe(before);
    expect(await prisma.siteErasure.count({ where: { siteId } })).toBe(0);
    expect((await prisma.site.findUniqueOrThrow({ where: { id: siteId } })).erasureEpoch).toBe(0);

    await expect(erase()).resolves.toMatchObject({ remaining: 0 });
  });

  it('a save in between that changed the working copy: refused', async () => {
    const repo = getSiteRepository();
    await repo.publishProject(scope, project(VALUE));
    const stale = await repo.searchPersonalData(scope, siteId, QUERY);
    await repo.saveProject(scope, project(`${VALUE} and ${VALUE}`), { mustExist: true });
    await expect(erase({ token: stale.token })).rejects.toBeInstanceOf(ErasePreviewStaleError);
  });
});

describe('resume: a failed erase changes nothing and is repeated', () => {
  it('a failure at the last write rolls every rewritten revision back', async () => {
    const repo = getSiteRepository();
    await repo.publishProject(scope, project(VALUE));
    await repo.publishProject(scope, project(VALUE));
    const preview = await repo.searchPersonalData(scope, siteId, QUERY);
    const before = await everything();

    // Fail the audit insert, the erase's last write, for this site only.
    const fn = `fail_erasure_${siteId.replace(/-/g, '')}`;
    await prisma.$executeRawUnsafe(
      `CREATE FUNCTION ${fn}() RETURNS trigger AS $$ BEGIN IF NEW.site_id = '${siteId}' THEN RAISE EXCEPTION 'injected'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`,
    );
    await prisma.$executeRawUnsafe(`CREATE TRIGGER ${fn} BEFORE INSERT ON public.site_erasures FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
    try {
      await expect(
        repo.erasePersonalData(scope, siteId, { query: QUERY, replacement: '', token: preview.token, chosen: allShown(preview), erasedBy: OWNER }),
      ).rejects.toThrow();
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER ${fn} ON public.site_erasures`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION ${fn}()`);
    }

    expect(await everything()).toBe(before);
    expect((await revisions()).every((r) => r.rewrittenAt === null)).toBe(true);
    expect((await prisma.site.findUniqueOrThrow({ where: { id: siteId } })).erasureEpoch).toBe(0);

    // The same preview still holds, since nothing changed: the repeat goes through.
    await expect(
      repo.erasePersonalData(scope, siteId, { query: QUERY, replacement: '', token: preview.token, chosen: allShown(preview), erasedBy: OWNER }),
    ).resolves.toMatchObject({ remaining: 0 });
  });
});

describe('re-entry: a second erase of the same value', () => {
  it('finds nothing to erase and changes nothing', async () => {
    const repo = getSiteRepository();
    await repo.publishProject(scope, project(VALUE));
    await erase();
    const before = await everything();
    const epoch = (await prisma.site.findUniqueOrThrow({ where: { id: siteId } })).erasureEpoch;

    await expect(erase()).rejects.toBeInstanceOf(NothingToEraseError);
    expect(await everything()).toBe(before);
    expect((await prisma.site.findUniqueOrThrow({ where: { id: siteId } })).erasureEpoch).toBe(epoch);
    expect(await repo.listErasures(scope, siteId)).toHaveLength(1);
  });

  it('a later erase of another value works on the rewritten history', async () => {
    const repo = getSiteRepository();
    await repo.publishProject(scope, project(VALUE));
    await erase();
    const other = { value: 'Erika', caseSensitive: false };
    await repo.saveProject(scope, project('Erika Muster', { erasureEpoch: 1 }), { mustExist: true });
    const preview = await repo.searchPersonalData(scope, siteId, other);
    expect(preview.total).toBeGreaterThan(0);
    await repo.erasePersonalData(scope, siteId, { query: other, replacement: '', token: preview.token, chosen: allShown(preview), erasedBy: OWNER });
    expect((await prisma.site.findUniqueOrThrow({ where: { id: siteId } })).erasureEpoch).toBe(2);
    expect(await repo.listErasures(scope, siteId)).toHaveLength(2);
  });
});

describe('editor tabs loaded before an erase', () => {
  it('their Save and Publish are refused and write nothing; a reloaded tab saves', async () => {
    const repo = getSiteRepository();
    await repo.publishProject(scope, project(VALUE));
    await erase();
    const before = await everything();

    // A tab without the field, and one loaded at epoch 0.
    await expect(repo.saveProject(scope, project(VALUE), { mustExist: true })).rejects.toBeInstanceOf(SiteErasedSinceLoadError);
    await expect(repo.saveProject(scope, project(VALUE, { erasureEpoch: 0 }), { mustExist: true })).rejects.toBeInstanceOf(
      SiteErasedSinceLoadError,
    );
    await expect(repo.publishProject(scope, project(VALUE, { erasureEpoch: 0 }))).rejects.toBeInstanceOf(SiteErasedSinceLoadError);
    expect(await everything()).toBe(before);

    const reloaded = getSnapshot(await repo.loadProject(scope, siteId));
    await expect(repo.publishProject(scope, reloaded as never)).resolves.toEqual({ revision: 2 });
    expect(JSON.stringify(await visit())).not.toContain(VALUE);
  });

  it('a save racing an erase never leaves the value behind an erase that succeeded', async () => {
    const repo = getSiteRepository();
    await repo.publishProject(scope, project(VALUE));
    for (let round = 0; round < 3; round++) {
      const preview = await repo.searchPersonalData(scope, siteId, QUERY);
      if (preview.erasable === 0) break;
      const epoch = (await prisma.site.findUniqueOrThrow({ where: { id: siteId } })).erasureEpoch;
      const [erased, saved] = await Promise.allSettled([
        repo.erasePersonalData(scope, siteId, { query: QUERY, replacement: '', token: preview.token, chosen: allShown(preview), erasedBy: OWNER }),
        repo.saveProject(scope, project(VALUE, { erasureEpoch: epoch }), { mustExist: true }),
      ]);
      if (saved.status === 'rejected') expect(saved.reason).toBeInstanceOf(SiteErasedSinceLoadError);
      if (erased.status === 'fulfilled') {
        // The save ran first with the same content (the token held), or was refused.
        expect((await repo.searchPersonalData(scope, siteId, QUERY)).total).toBe(0);
      } else {
        // The save changed what the preview saw.
        expect(erased.reason).toBeInstanceOf(ErasePreviewStaleError);
        expect(saved.status).toBe('fulfilled');
      }
    }
  });

  it('a publish racing an erase never freezes the value behind an erase that succeeded', async () => {
    const repo = getSiteRepository();
    await repo.publishProject(scope, project(VALUE));
    const preview = await repo.searchPersonalData(scope, siteId, QUERY);
    const [erased, published] = await Promise.allSettled([
      repo.erasePersonalData(scope, siteId, { query: QUERY, replacement: '', token: preview.token, chosen: allShown(preview), erasedBy: OWNER }),
      repo.publishProject(scope, project(VALUE, { erasureEpoch: 0 })),
    ]);
    if (erased.status === 'fulfilled') {
      // A publish adds a version, so one that ran first would have made the preview stale.
      expect(published.status === 'rejected' ? published.reason : null).toBeInstanceOf(SiteErasedSinceLoadError);
      expect(JSON.stringify(await visit())).not.toContain(VALUE);
      expect(await everything()).not.toContain(VALUE);
    } else {
      expect(erased.reason).toBeInstanceOf(ErasePreviewStaleError);
      expect(published.status).toBe('fulfilled');
    }
  });
});

describe('bounds and isolation', () => {
  it('refuses a replacement that holds the value, and a value too short', async () => {
    const repo = getSiteRepository();
    await repo.publishProject(scope, project(VALUE));
    await expect(erase({ replacement: `former ${VALUE}` })).rejects.toBeInstanceOf(EraseQueryError);
    await expect(repo.searchPersonalData(scope, siteId, { value: 'Ma', caseSensitive: false })).rejects.toBeInstanceOf(EraseQueryError);
  });

  it('another workspace reads the site as missing and changes nothing', async () => {
    const repo = getSiteRepository();
    await repo.publishProject(scope, project(VALUE));
    const foreign = { workspaceId: 'ws_someone_else', tenantGroupId: TENANT_GROUP };
    const preview = await repo.searchPersonalData(scope, siteId, QUERY);
    await expect(repo.searchPersonalData(foreign, siteId, QUERY)).rejects.toBeInstanceOf(SiteNotFoundError);
    await expect(
      repo.erasePersonalData(foreign, siteId, { query: QUERY, replacement: '', token: preview.token, chosen: allShown(preview), erasedBy: OWNER }),
    ).rejects.toBeInstanceOf(SiteNotFoundError);
    expect(await everything()).toContain(VALUE);
  });
});

describe('the review of #283: only what was shown and ticked, protected places, the audit path', () => {
  it('never erases more than one preview lists, however many matches there are', async () => {
    const repo = getSiteRepository();
    const many = Array.from({ length: 350 }, () => VALUE).join(', ');
    await repo.publishProject(scope, project(many));
    const preview = await repo.searchPersonalData(scope, siteId, QUERY);
    expect(preview.truncated).toBe(true);
    expect(preview.matches).toHaveLength(ERASE_LIMITS.listed);

    const result = await erase({ chosen: allShown(preview), token: preview.token });
    expect(result.erased).toBe(ERASE_LIMITS.listed);
    expect((await repo.searchPersonalData(scope, siteId, QUERY)).total).toBe(preview.total - ERASE_LIMITS.listed);
  });

  it('refuses an id the preview did not offer for erasing, and changes nothing', async () => {
    const repo = getSiteRepository();
    await repo.publishProject(scope, project(VALUE, { slug: 'team-mustermann' }));
    const query = { value: 'Mustermann', caseSensitive: false };
    const preview = await repo.searchPersonalData(scope, siteId, query);
    const blocked = preview.matches.find((m) => m.blocked === 'address')!;
    const before = await everything();
    for (const chosen of [[blocked.id], ['f'.repeat(32)], [...allShown(preview), blocked.id]]) {
      await expect(
        repo.erasePersonalData(scope, siteId, { query, replacement: '', token: preview.token, chosen, erasedBy: OWNER }),
      ).rejects.toBeInstanceOf(ErasePreviewStaleError);
    }
    expect(await everything()).toBe(before);
  });

  it('keeps a key holding the value out of the audit row', async () => {
    const repo = getSiteRepository();
    const withMap = project(VALUE) as unknown as { pages: { home: { appComponentTree: { props: Record<string, unknown> } } } };
    withMap.pages.home.appComponentTree.props.people = { [VALUE]: { label: VALUE } };
    await repo.publishProject(scope, withMap as never);

    const preview = await repo.searchPersonalData(scope, siteId, QUERY);
    expect(preview.matches.some((m) => m.blocked === 'key')).toBe(true);
    const result = await erase({ chosen: allShown(preview), token: preview.token });

    expect(result.places.map((p) => p.path)).toContainEqual(`/pages/1/snapshot/appComponentTree/props/people/${REDACTED_SEGMENT}/label`);
    const raw = await prisma.siteErasure.findUniqueOrThrow({ where: { id: result.erasureId } });
    expect(JSON.stringify(raw)).not.toMatch(/mustermann/i);
    // The key itself is not rewritten: it is reported, and stays in the remaining count.
    expect(result.remaining).toBe(2);
  });

  it('reports a value in a domain or an A/B test, and never rewrites it there', async () => {
    const repo = getSiteRepository();
    await repo.publishProject(scope, project('Erika Muster'));
    await prisma.siteDomain.create({
      data: { siteId, workspaceId: scope.workspaceId, tenantGroupId: scope.tenantGroupId, hostname: 'max-mustermann.example' },
    });
    await prisma.siteExperiment.create({
      data: { siteId, workspaceId: scope.workspaceId, tenantGroupId: scope.tenantGroupId, experimentKey: 'hero', config: { variant: 'Max Mustermann says hi' } },
    });
    const preview = await repo.searchPersonalData(scope, siteId, { value: 'max mustermann', caseSensitive: false, insideWords: true });
    expect(preview.matches.map((m) => [m.area, m.blocked])).toEqual(
      expect.arrayContaining([['experiment', 'separate']]),
    );
    const domains = await repo.searchPersonalData(scope, siteId, { value: 'max-mustermann', caseSensitive: false });
    expect(domains.matches.map((m) => [m.area, m.blocked])).toEqual([['domain', 'separate']]);
    expect(domains.erasable).toBe(0);
  });

  it('refuses a tab whose counter is ahead of the server', async () => {
    const repo = getSiteRepository();
    await repo.publishProject(scope, project(VALUE));
    await erase();
    await expect(repo.saveProject(scope, project(VALUE, { erasureEpoch: 99 }), { mustExist: true })).rejects.toBeInstanceOf(
      SiteErasedSinceLoadError,
    );
    expect(await everything()).not.toContain(VALUE);
  });

  it('leaves no residue around an empty replacement', async () => {
    const repo = getSiteRepository();
    await repo.saveProject(scope, project('Erika Muster'), { mustExist: true });
    await prisma.site.update({
      where: { id: siteId },
      data: { siteSettings: { siteName: 'Bakery', business: { legalName: `Geschäftsführer: ${VALUE}, Erika Musterfrau` } } },
    });
    const preview = await repo.searchPersonalData(scope, siteId, QUERY);
    await repo.erasePersonalData(scope, siteId, { query: QUERY, replacement: '', token: preview.token, chosen: allShown(preview), erasedBy: OWNER });
    const stored = await prisma.site.findUniqueOrThrow({ where: { id: siteId }, select: { siteSettings: true } });
    expect((stored.siteSettings as { business: { legalName: string } }).business.legalName).toBe('Geschäftsführer: Erika Musterfrau');
  });
});
