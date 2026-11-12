// The durable purge of a deleted project's form submissions (src/server/forms/purge.ts), against real Postgres. The intent
// is written BEFORE the site row is deleted, so the dangerous interleavings are both ways round:
//
//   - the project still exists, or its delete is refused or never commits (a crash right after the intent): the job must NEVER
//     purge, and ends as a no-op;
//   - the project is gone but the immediate cleanup never ran (a crash, a failure, an email in flight): the job purges, and
//     retries without ever giving up or being lost until it has;
//   - a project recreated after the delete is a new site id: the old job never touches it;
//   - the job is scoped to its tenant group, to the site, and to the workspace the delete was made from.
// All data is synthetic.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';
import { tenantDb, type TenantGroupId } from '@marlinjai/tenant-db';

vi.mock('server-only', () => ({}));

import type { CommerceDB } from '@/server/commerce/db-types';
import {
  createPublishedSite,
  openCommerceAppBase,
  openStorefrontFixtures,
  provisionCommerceTenant,
  type StorefrontFixtures,
} from '@/server/commerce/__tests__/storefrontFixtures';
import { runJobNow } from '@/server/commerce/jobs/run';
import { JobRefused } from '@/server/commerce/jobs/types';
import { PURGE_DELAY_MS, STUCK_PURGE_ATTEMPTS, countStuckPurges, purgeSiteSubmissions, scheduleProjectSubmissionsPurge } from '../purge';
import { insertFormSubmission } from '../repository';

let fx: StorefrontFixtures;
let appBase: Kysely<CommerceDB>;
let tgId: TenantGroupId;
let schema: string;
let appDb: Kysely<CommerceDB>;
let otherTg: TenantGroupId;
let otherSchema: string;
let otherDb: Kysely<CommerceDB>;

type Site = { host: string; siteId: string; workspaceId: string };
let siteA: Site;
let siteB: Site;
let siteOther: Site;
const clock = { now: new Date('2026-11-12T09:00:00Z') };

beforeAll(async () => {
  fx = openStorefrontFixtures();
  appBase = openCommerceAppBase();
  const t1 = await provisionCommerceTenant(fx, 'purge1');
  tgId = t1.tgId;
  schema = t1.schema;
  appDb = tenantDb(appBase, tgId);
  const t2 = await provisionCommerceTenant(fx, 'purge2');
  otherTg = t2.tgId;
  otherSchema = t2.schema;
  otherDb = tenantDb(appBase, otherTg);
}, 120_000);

afterAll(async () => {
  await appBase?.destroy();
  await fx?.close();
});

async function submit(db: Kysely<CommerceDB>, tg: TenantGroupId, site: Site) {
  const id = randomUUID();
  await insertFormSubmission(db, {
    id,
    tenantId: tg,
    workspaceId: site.workspaceId,
    siteId: site.siteId,
    pageId: 'p1',
    pagePath: '/kontakt',
    formId: 'form-1',
    formName: 'Contact',
    fields: [{ key: 'name', label: 'Name', type: 'text', value: 'Ana Beispiel' }],
  });
  return id;
}

const rowsOf = async (schemaName: string, siteId: string) =>
  fx.owner`SELECT id FROM ${fx.owner(schemaName)}.form_submission WHERE site_id = ${siteId}`;

const purgeJobs = async () => fx.owner`SELECT * FROM ${fx.owner(schema)}.commerce_job WHERE kind = 'form_purge' ORDER BY created_at`;

/** The job's way: a brand new handle (a restarted process knows nothing of the one that wrote the job). */
const group = () => ({ id: tgId as string, db: tenantDb(appBase, tgId) });
async function runJobs(at: Date): Promise<string[]> {
  const due = await fx.owner<{ id: string }[]>`
    SELECT id FROM ${fx.owner(schema)}.commerce_job WHERE kind = 'form_purge' AND status = 'pending' AND run_at <= ${at} ORDER BY run_at`;
  const outcomes: string[] = [];
  for (const job of due) outcomes.push((await runJobNow(group(), tgId, job.id, { now: () => at }))?.outcome ?? 'none');
  return outcomes;
}

const intent = (site: Site, now = clock.now) => scheduleProjectSubmissionsPurge(tgId, site.workspaceId, site.siteId, now, async () => appDb);
const later = (ms = PURGE_DELAY_MS + 60_000) => new Date(clock.now.getTime() + ms);
const deleteSiteRow = (site: Site) => fx.prisma.site.delete({ where: { id: site.siteId } });

beforeEach(async () => {
  await fx.owner`DELETE FROM ${fx.owner(schema)}.form_submission`;
  await fx.owner`DELETE FROM ${fx.owner(schema)}.commerce_job WHERE kind = 'form_purge'`;
  await fx.owner`DELETE FROM ${fx.owner(otherSchema)}.form_submission`;
  siteA = await createPublishedSite(fx, tgId, 'purgeA');
  siteB = await createPublishedSite(fx, tgId, 'purgeB');
  siteOther = await createPublishedSite(fx, otherTg, 'purgeO');
});

describe('the intent, written before the delete', () => {
  it('is a durable job in the tenant group, due after the delete and its own retries, carrying ids and no visitor data', async () => {
    await submit(appDb, tgId, siteA);
    // The confirmation the route relies on to tell the owner that removal is pending.
    expect(await intent(siteA)).toBe(true);
    const jobs = await purgeJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ tenant_id: tgId, kind: 'form_purge', status: 'pending' });
    expect(jobs[0].payload).toEqual({ siteId: siteA.siteId, workspaceId: siteA.workspaceId });
    expect(new Date(jobs[0].run_at).getTime()).toBe(clock.now.getTime() + PURGE_DELAY_MS);
    expect(JSON.stringify(jobs[0])).not.toContain('Ana Beispiel');
    // Another attempt is another job: an earlier refused attempt cannot swallow it.
    await intent(siteA);
    expect(await purgeJobs()).toHaveLength(2);
  });

  it('is skipped for a tenant group with no schema (a legacy site) and is not a tenant id at all', async () => {
    // No confirmation either: nothing durable exists, so nothing may be promised.
    expect(await scheduleProjectSubmissionsPurge('not-a-tenant-group', siteA.workspaceId, siteA.siteId, clock.now, async () => appDb)).toBe(false);
    expect(await purgeJobs()).toHaveLength(0);
  });

  it('a failure to write it is thrown, so the caller deletes nothing', async () => {
    await expect(
      scheduleProjectSubmissionsPurge(tgId, siteA.workspaceId, siteA.siteId, clock.now, async () => {
        throw new Error('tenant schema unreachable');
      }),
    ).rejects.toThrow(/unreachable/);
  });
});

describe('never purging while the project exists', () => {
  it('a job that fires while the site row is there purges nothing and ends (the delete is slow, refused, or never committed)', async () => {
    const mine = await submit(appDb, tgId, siteA);
    await intent(siteA);
    expect(await runJobs(later())).toEqual(['done']);
    expect((await rowsOf(schema, siteA.siteId)).map((r) => r.id)).toEqual([mine]);
  });

  it('a crash right after the intent (the delete never happens) loses nothing; a later real delete writes its own job and purges', async () => {
    const mine = await submit(appDb, tgId, siteA);
    await intent(siteA); // ... and the process dies here
    expect(await runJobs(later())).toEqual(['done']);
    expect(await rowsOf(schema, siteA.siteId)).toHaveLength(1);
    // The owner deletes the project properly this time.
    await intent(siteA, later());
    await deleteSiteRow(siteA);
    expect(await runJobs(later(2 * PURGE_DELAY_MS + 120_000))).toEqual(['done']);
    expect(await rowsOf(schema, siteA.siteId)).toHaveLength(0);
    expect(mine).toBeTruthy();
  });

  it('a delete that fails after the intent leaves the project and its submissions untouched', async () => {
    await submit(appDb, tgId, siteA);
    await intent(siteA);
    // deleteSite refused: no row deleted. Any number of job runs later, nothing has happened to the data.
    expect(await runJobs(later())).toEqual(['done']);
    expect(await runJobs(later(5 * PURGE_DELAY_MS))).toEqual([]);
    expect(await rowsOf(schema, siteA.siteId)).toHaveLength(1);
  });
});

describe('purging once the project is gone', () => {
  it('a crash after the delete, before any cleanup, is finished by the job: the project\'s submissions go, nothing else', async () => {
    await submit(appDb, tgId, siteA);
    await submit(appDb, tgId, siteA);
    const keepB = await submit(appDb, tgId, siteB);
    const keepOther = await submit(otherDb, otherTg, siteOther);
    await intent(siteA);
    await deleteSiteRow(siteA); // ... and the process dies before deleteProjectSubmissions
    expect(await runJobs(later())).toEqual(['done']);
    expect(await rowsOf(schema, siteA.siteId)).toHaveLength(0);
    expect((await rowsOf(schema, siteB.siteId)).map((r) => r.id)).toEqual([keepB]);
    expect((await rowsOf(otherSchema, siteOther.siteId)).map((r) => r.id)).toEqual([keepOther]);
  });

  it('a project recreated after the delete is a new site: the old job never touches its submissions', async () => {
    await submit(appDb, tgId, siteA);
    await intent(siteA);
    await deleteSiteRow(siteA);
    const recreated = await createPublishedSite(fx, tgId, 'purgeA');
    // Even the same workspace: a different project, a different id.
    const recreatedSameWorkspace: Site = { ...recreated, workspaceId: siteA.workspaceId };
    const mine = await submit(appDb, tgId, recreatedSameWorkspace);
    expect(await runJobs(later())).toEqual(['done']);
    expect(await rowsOf(schema, siteA.siteId)).toHaveLength(0);
    expect((await rowsOf(schema, recreated.siteId)).map((r) => r.id)).toEqual([mine]);
  });

  it('is idempotent: a second run, or a second job for the same delete, finds nothing and ends', async () => {
    await submit(appDb, tgId, siteA);
    await intent(siteA);
    await intent(siteA);
    await deleteSiteRow(siteA);
    expect(await runJobs(later())).toEqual(['done', 'done']);
    expect(await runJobs(later(10 * PURGE_DELAY_MS))).toEqual([]);
    expect(await rowsOf(schema, siteA.siteId)).toHaveLength(0);
  });

  it('survives a restart: the job is only database state, and a fresh handle runs it', async () => {
    await submit(appDb, tgId, siteA);
    await intent(siteA);
    await deleteSiteRow(siteA);
    // `runJobs` builds a brand new group handle for every run, as a restarted worker would.
    expect(await runJobs(later())).toEqual(['done']);
    expect(await rowsOf(schema, siteA.siteId)).toHaveLength(0);
  });
});

describe('scope: tenant group, site and workspace', () => {
  it('a delete made from another workspace of the group removes nothing of this one (a site id named by a caller who does not own it)', async () => {
    const mine = await submit(appDb, tgId, siteA);
    // A caller of workspace B names site A: the intent carries B's workspace, so it can only ever match B's own rows.
    await intent({ ...siteA, workspaceId: siteB.workspaceId });
    await deleteSiteRow(siteA); // A's owner deletes it for real
    expect(await runJobs(later())).toEqual(['done']);
    expect((await rowsOf(schema, siteA.siteId)).map((r) => r.id)).toEqual([mine]);
  });

  it('refuses a job of another tenant than the group it runs in', async () => {
    await expect(purgeSiteSubmissions({ id: otherTg, db: otherDb }, tgId, siteA.siteId, siteA.workspaceId)).rejects.toBeInstanceOf(JobRefused);
  });

  it('a group never reaches another group: the same site id in another schema is not its rows', async () => {
    // A row of ANOTHER group that happens to carry the same site id (inserted directly: the repository would refuse a site
    // that is not in that group, which is the point).
    const theirs = randomUUID();
    await fx.owner`
      INSERT INTO ${fx.owner(otherSchema)}.form_submission (id, tenant_id, workspace_id, site_id, page_id, page_path, form_id, form_name, fields)
      VALUES (${theirs}, ${otherTg}, ${siteA.workspaceId}, ${siteA.siteId}, 'p1', '/kontakt', 'form-1', 'Contact', ${fx.owner.json([])})`;
    await submit(appDb, tgId, siteA);
    await intent(siteA);
    await deleteSiteRow(siteA);
    expect(await runJobs(later())).toEqual(['done']);
    expect((await rowsOf(otherSchema, siteA.siteId)).map((r) => r.id)).toEqual([theirs]);
  });
});

describe('failure and retry exhaustion', () => {
  it('keeps retrying through any number of failures without dying or being lost, and finishes the moment the failure ends', async () => {
    const mine = await submit(appDb, tgId, siteA);
    await intent(siteA);
    await deleteSiteRow(siteA);
    await fx.owner`CREATE FUNCTION ${fx.owner(schema)}.block_purge() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test: refuse delete'; END $$`;
    await fx.owner`CREATE TRIGGER block_purge BEFORE DELETE ON ${fx.owner(schema)}.form_submission FOR EACH ROW EXECUTE FUNCTION ${fx.owner(schema)}.block_purge()`;
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      let at = later();
      for (let attempt = 1; attempt <= 8; attempt += 1) {
        expect(await runJobs(at)).toEqual(['retry']);
        const [job] = await purgeJobs();
        // Never dead, never done, never dropped: the longest backoff is six hours and it goes on forever.
        expect(job).toMatchObject({ status: 'pending' });
        expect(Number(job.attempts)).toBe(attempt);
        // The watchdog count: quiet while it may still be a busy email, loud once it has failed too often to be one.
        expect(await countStuckPurges(appDb)).toBe(attempt >= STUCK_PURGE_ATTEMPTS ? 1 : 0);
        at = new Date(at.getTime() + 7 * 60 * 60 * 1000);
      }
      expect((await rowsOf(schema, siteA.siteId)).map((r) => r.id)).toEqual([mine]);
      // The failure ends: the very next run removes it.
      await fx.owner`DROP TRIGGER block_purge ON ${fx.owner(schema)}.form_submission`;
      expect(await runJobs(at)).toEqual(['done']);
      expect(await countStuckPurges(appDb)).toBe(0);
    } finally {
      logged.mockRestore();
      await fx.owner`DROP TRIGGER IF EXISTS block_purge ON ${fx.owner(schema)}.form_submission`;
      await fx.owner`DROP FUNCTION IF EXISTS ${fx.owner(schema)}.block_purge()`;
    }
    expect(await rowsOf(schema, siteA.siteId)).toHaveLength(0);
  });
});
