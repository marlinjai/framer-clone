import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compare, decide, decideRun, DEPLOYMENT_PAGE, DEPLOYMENT_PAGES, type GetJson, guard, lastDeployed, noticeLine, VERDICT } from '../ci/publishDecision';

const commit = () => randomBytes(20).toString('hex');
const REPO = 'owner/repo';
const MAIN = 'refs/heads/main';
const files = (...list: string[]) => ({ kind: 'compared' as const, status: 'ahead', files: list, complete: true });
const unknown = { kind: 'unknown' as const, reason: 'test' };

describe('decide', () => {
  const deployed = { kind: 'commit' as const, sha: commit() };
  const base = { event: 'push', ref: MAIN, enabled: true, pinned: false, publishWhilePinned: false, rollbackDigest: '', deployed, sinceDeployed: files(), thisPush: files() };

  it('never publishes a pull request or another branch, and says nothing about it', () => {
    expect(decide({ ...base, event: 'pull_request', sinceDeployed: files('services/box/src/main.ts') })).toEqual({ publish: false });
    expect(decide({ ...base, ref: 'refs/heads/feature', sinceDeployed: files('services/box/src/main.ts') })).toEqual({ publish: false });
  });

  it('publishes nothing until BOX_DEPLOY_ENABLED is true, and says so', () => {
    const decision = decide({ ...base, enabled: false, sinceDeployed: files('services/box/src/main.ts') });
    expect(decision.publish).toBe(false);
    expect(decision.notice?.message).toContain('BOX_DEPLOY_ENABLED');
  });

  it('publishes on a manual run on main, whatever changed', () => {
    expect(decide({ ...base, event: 'workflow_dispatch', sinceDeployed: files('prisma/migrations/1/migration.sql') }).publish).toBe(true);
  });

  it.each([
    ['services/box/src/main.ts'],
    ['src/lib/customCode/contract.ts'],
    ['Dockerfile.box'],
    ['Dockerfile.box.dockerignore'],
    ['.github/workflows/box.yml'],
  ])('publishes when %s changed since the deployed commit', (file) => {
    expect(decide({ ...base, sinceDeployed: files('README.md', file) })).toEqual({ publish: true });
  });

  it('does not publish when nothing of the box changed since the deployed commit, and names that commit', () => {
    const decision = decide({ ...base, sinceDeployed: files('tsconfig.json', 'src/app/page.tsx', 'Dockerfile.boxer', 'services/boxes/x.ts') });
    expect(decision.publish).toBe(false);
    expect(decision.notice?.message).toContain(deployed.sha.slice(0, 12));
  });

  it('judges what changed since the deployed commit, not this push: a box change of a cancelled run is published', () => {
    // This push touched only the root configuration; an earlier, cancelled push changed the box.
    expect(decide({ ...base, thisPush: files('tsconfig.json'), sinceDeployed: files('tsconfig.json', 'services/box/src/main.ts') }).publish).toBe(true);
  });

  it.each([
    ['a migration alone', ['prisma/migrations/20261117_x/migration.sql']],
    ['a role file alone', ['prisma/sql/box-reader.sql']],
    ['a migration with a box change', ['services/box/src/main.ts', 'prisma/migrations/20261117_x/migration.sql']],
  ])('does not publish %s, and tells the operator to deploy the application and then run box by hand', (_name, list) => {
    const decision = decide({ ...base, sinceDeployed: files(...list) });
    expect(decision.publish).toBe(false);
    expect(decision.notice?.title).toContain('deploy the application first');
    expect(decision.notice?.message).toContain('deploy the application, then run the box workflow by hand');
  });

  it('publishes when nothing was ever deployed, and says why', () => {
    const none = decide({ ...base, deployed: { kind: 'none' }, sinceDeployed: unknown, thisPush: files('README.md') });
    expect(none.publish).toBe(true);
    expect(none.notice?.message).toContain('no deployment to box-production has succeeded yet');
    expect(none.error).toBeUndefined();
    // Not even the push's own changes known: still the first deploy.
    expect(decide({ ...base, deployed: { kind: 'none' }, sinceDeployed: unknown, thisPush: unknown }).publish).toBe(true);
  });

  it('holds a database change back on the first deploy when this push shows it', () => {
    const decision = decide({ ...base, deployed: { kind: 'none' }, sinceDeployed: unknown, thisPush: files('prisma/sql/box-reader.sql') });
    expect(decision.publish).toBe(false);
    expect(decision.notice?.title).toContain('deploy the application first');
  });

  it('fails loudly, publishing nothing, when what runs or what changed since is not known', () => {
    const notKnown = decide({ ...base, deployed: { kind: 'unknown', reason: 'HTTP 500' }, sinceDeployed: unknown, thisPush: files('services/box/src/main.ts') });
    expect(notKnown.publish).toBe(false);
    expect(notKnown.error).toContain('HTTP 500');
    expect(notKnown.error).toContain('Run the box workflow by hand on main with override_guard');
    const notCompared = decide({ ...base, sinceDeployed: { kind: 'unknown', reason: 'HTTP 404' }, thisPush: files('services/box/src/main.ts') });
    expect(notCompared.publish).toBe(false);
    expect(notCompared.error).toContain('HTTP 404');
    for (const status of ['behind', 'diverged']) {
      const notAncestor = decide({ ...base, sinceDeployed: { ...files('services/box/src/main.ts'), status } });
      expect(notAncestor.publish).toBe(false);
      expect(notAncestor.error).toContain(`is ${status} of this one, not an ancestor`);
      // Every refusal names its way out.
      expect(notAncestor.error).toContain('Run the box workflow by hand on main with override_guard');
    }
  });

  it('holds, with a notice saying how to go on, when the list of changed files is cut at 300', () => {
    const cut = decide({ ...base, sinceDeployed: { ...files('services/box/src/main.ts'), complete: false } });
    expect(cut.publish).toBe(false);
    expect(cut.error).toBeUndefined();
    expect(cut.notice?.message).toContain('deploy the application first; then run the box workflow by hand on main');
    expect(decide({ ...base, deployed: { kind: 'none' }, sinceDeployed: unknown, thisPush: { ...files(), complete: false } }).publish).toBe(false);
    // Pinned, a cut list counts as a possible database change.
    expect(decide({ ...base, pinned: true, sinceDeployed: { ...files(), complete: false } }).notice?.title).toContain('deploy the application first');
  });

  it('publishes nothing while pinned after a rollback, whatever changed, and says how to lift it', () => {
    const pinned = { ...base, pinned: true };
    for (const decision of [
      decide({ ...pinned, sinceDeployed: files('services/box/src/main.ts') }),
      decide({ ...pinned, sinceDeployed: files('.nvmrc', 'services/box/src/main.ts') }),
      decide({ ...pinned, deployed: { kind: 'none' }, sinceDeployed: unknown, thisPush: unknown }),
      decide({ ...pinned, deployed: { kind: 'unknown', reason: 'x' }, sinceDeployed: unknown }),
      decide({ ...pinned, event: 'workflow_dispatch' }),
      // The input means nothing on a push.
      decide({ ...pinned, publishWhilePinned: true, sinceDeployed: files('services/box/src/main.ts') }),
    ]) {
      expect(decision.publish).toBe(false);
      expect(decision.error).toBeUndefined();
      expect(decision.notice?.message).toContain('BOX_DEPLOY_PINNED');
      expect(decision.notice?.message).toContain('set BOX_DEPLOY_PINNED to false');
    }
  });

  it('publishes while pinned only on a manual run that says so', () => {
    expect(decide({ ...base, pinned: true, event: 'workflow_dispatch', publishWhilePinned: true })).toEqual({ publish: true });
  });

  it('publishes nothing on a manual rollback run: the rollback job redeploys the named image', () => {
    const image = `sha256:${'a'.repeat(64)}`;
    for (const pinned of [false, true]) {
      const decision = decide({ ...base, pinned, event: 'workflow_dispatch', publishWhilePinned: true, rollbackDigest: image, sinceDeployed: files('services/box/src/main.ts') });
      expect(decision.publish).toBe(false);
      expect(decision.notice?.message).toContain(image);
    }
  });
});

/** A stand-in for the GitHub API: answers by path, records every path asked. */
function api(routes: Record<string, { status: number; body: unknown }>) {
  const asked: string[] = [];
  const get: GetJson = async (route) => {
    asked.push(route);
    return routes[route] ?? { status: 404, body: { message: 'Not Found' } };
  };
  return { get, asked };
}

// Answers recorded read-only from this repository's GitHub API on 2026-11-17 (test/fixtures/github): the
// plugin-mirror environment's deployment 7824580602, made by its job with `environment:` (run 43871048435,
// job 133312005128), with all five of its statuses; a production deployment made through the API, whose
// statuses point at the commit's checks page; and three comparisons (ahead, behind, cut at 300 files).
const fixture = (name: string): unknown => JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'github', `${name}.json`), 'utf8'));
type Row = { id: number; sha: string; creator: { login: string } };
type Status = { state: string; log_url: string };
const recordedDeployments = fixture('deployments') as Row[];
const recordedStatuses = fixture('statuses-of-a-job-deployment') as Status[];
const recordedApiStatuses = fixture('statuses-of-an-api-deployment') as Status[];
const recordedJob = fixture('job') as { id: number; run_id: number; name: string; head_sha: string };
const recordedRun = fixture('run') as { id: number; path: string };
const RECORDED_REPO = 'marlinjai/framer-clone';
const deployment = recordedDeployments[0] as Row;

const deploymentsPage = (page: number) => `/repos/${RECORDED_REPO}/deployments?environment=box-production&per_page=100&page=${page}`;
const deploymentsPath = deploymentsPage(1);
const statusesPath = (id: number) => `/repos/${RECORDED_REPO}/deployments/${id}/statuses?per_page=1`;
const jobPath = `/repos/${RECORDED_REPO}/actions/jobs/${recordedJob.id}`;
const runPath = `/repos/${RECORDED_REPO}/actions/runs/${recordedRun.id}`;
const comparePath = (base: string, head: string) => `/repos/${RECORDED_REPO}/compare/${base}...${head}?per_page=1`;
/** GitHub answers per_page=1 with the newest status alone. */
const latest = (statuses: Status[]) => ({ status: 200, body: statuses.slice(0, 1) });

/**
 * The recorded deployment as box.yml's publish job would leave it: the same records, with the job's name
 * and the run's workflow path those of the box's deploying job. `job` and `run` change one field more.
 */
function recordedPublish(job: Record<string, unknown> = {}, run: Record<string, unknown> = {}) {
  return {
    [deploymentsPath]: { status: 200, body: [deployment] },
    [statusesPath(deployment.id)]: latest(recordedStatuses),
    [jobPath]: { status: 200, body: { ...recordedJob, name: 'publish and deploy', ...job } },
    [runPath]: { status: 200, body: { ...recordedRun, path: '.github/workflows/box.yml', ...run } },
  };
}

/** The publish job's own deployment while its steps run: created by the job, its latest status in_progress. */
const ownRunningRow: Row = { ...deployment, id: deployment.id + 1, sha: commit() };
const ownRunning = { [statusesPath(ownRunningRow.id)]: latest(recordedStatuses.slice(recordedStatuses.findIndex((status) => status.state === 'in_progress'))) };

describe('the recorded answers', () => {
  it('are what the code relies on: a job deployment created by the actor, its log address naming run and job', () => {
    expect(deployment.creator.login).not.toBe('github-actions[bot]');
    expect(recordedStatuses.map((status) => status.state)).toEqual(['success', 'in_progress', 'queued', 'queued', 'waiting']);
    for (const status of recordedStatuses) expect(status.log_url).toBe(`https://github.com/${RECORDED_REPO}/actions/runs/${recordedRun.id}/job/${recordedJob.id}`);
    expect(recordedJob.run_id).toBe(recordedRun.id);
    expect(recordedJob.head_sha).toBe(deployment.sha);
    expect(recordedApiStatuses[0]?.log_url).toMatch(/\/commit\/[0-9a-f]{40}\/checks$/);
  });
});

describe('lastDeployed', () => {
  it('takes a success made by the publish job, passing over the running job\'s own in-progress deployment', async () => {
    const { get, asked } = api({ ...recordedPublish(), [deploymentsPath]: { status: 200, body: [ownRunningRow, deployment] }, ...ownRunning });
    expect(await lastDeployed(get, RECORDED_REPO)).toEqual({ kind: 'commit', sha: deployment.sha });
    expect(asked).toEqual([deploymentsPath, statusesPath(ownRunningRow.id), statusesPath(deployment.id), jobPath, runPath]);
  });

  it('counts the rollback job too', async () => {
    expect(await lastDeployed(api(recordedPublish({ name: 'roll back' })).get, RECORDED_REPO)).toEqual({ kind: 'commit', sha: deployment.sha });
  });

  it('says none when no deployment ever reached success: the first publish, with only its own deployment listed', async () => {
    expect(await lastDeployed(api({ [deploymentsPath]: { status: 200, body: [ownRunningRow] }, ...ownRunning }).get, RECORDED_REPO)).toEqual({ kind: 'none' });
    expect(await lastDeployed(api({ [deploymentsPath]: { status: 200, body: [] } }).get, RECORDED_REPO)).toEqual({ kind: 'none' });
    const failedThenRunning = api({
      [deploymentsPath]: { status: 200, body: [ownRunningRow, deployment] },
      ...ownRunning,
      [statusesPath(deployment.id)]: latest([{ ...(recordedStatuses[0] as Status), state: 'failure' }]),
    });
    expect(await lastDeployed(failedThenRunning.get, RECORDED_REPO)).toEqual({ kind: 'none' });
  });

  describe('reads page after page while no deployment succeeded', () => {
    const failed = latest([{ ...(recordedStatuses[0] as Status), state: 'failure' }]);
    /** `count` failed deployments, newest first, from id `from` down, with their statuses. */
    const failedRows = (from: number, count: number) => {
      const rows = Array.from({ length: count }, (_unused, index): Row => ({ ...deployment, id: from - index, sha: commit() }));
      return { rows, statuses: Object.fromEntries(rows.map((row) => [statusesPath(row.id), failed])) };
    };

    it('finds the success behind a full page of failures', async () => {
      const first = failedRows(deployment.id + 500, DEPLOYMENT_PAGE);
      const second = failedRows(deployment.id + 100, 35);
      const { get, asked } = api({
        ...recordedPublish(),
        ...first.statuses,
        ...second.statuses,
        [deploymentsPage(1)]: { status: 200, body: first.rows },
        [deploymentsPage(2)]: { status: 200, body: [...second.rows, deployment] },
      });
      expect(await lastDeployed(get, RECORDED_REPO)).toEqual({ kind: 'commit', sha: deployment.sha });
      expect(asked).toContain(deploymentsPage(2));
    });

    it('says none only at the end of the list: a full last page is followed by an empty one', async () => {
      const first = failedRows(deployment.id + 500, DEPLOYMENT_PAGE);
      const { get, asked } = api({ ...first.statuses, [deploymentsPage(1)]: { status: 200, body: first.rows }, [deploymentsPage(2)]: { status: 200, body: [] } });
      expect(await lastDeployed(get, RECORDED_REPO)).toEqual({ kind: 'none' });
      expect(asked.filter((route) => route.includes('/deployments?'))).toEqual([deploymentsPage(1), deploymentsPage(2)]);
    });

    it('says not known, never none, when every page it may read is full of failures', async () => {
      const routes: Record<string, { status: number; body: unknown }> = {};
      for (let page = 1; page <= DEPLOYMENT_PAGES + 1; page += 1) {
        const rows = failedRows(deployment.id + 10_000 - page * 1000, DEPLOYMENT_PAGE);
        Object.assign(routes, rows.statuses, { [deploymentsPage(page)]: { status: 200, body: rows.rows } });
      }
      const { get, asked } = api(routes);
      expect(await lastDeployed(get, RECORDED_REPO)).toEqual({ kind: 'unknown', reason: `none of the newest ${DEPLOYMENT_PAGE * DEPLOYMENT_PAGES} deployments succeeded` });
      expect(asked).not.toContain(deploymentsPage(DEPLOYMENT_PAGES + 1));
    });

    it('says not known when a later page does not answer', async () => {
      const first = failedRows(deployment.id + 500, DEPLOYMENT_PAGE);
      const { get } = api({ ...first.statuses, [deploymentsPage(1)]: { status: 200, body: first.rows }, [deploymentsPage(2)]: { status: 502, body: null } });
      expect(await lastDeployed(get, RECORDED_REPO)).toMatchObject({ kind: 'unknown' });
    });
  });

  it('trusts no success another job, workflow or branch made, nor one made through the API', async () => {
    const notTrusted = { kind: 'unknown', reason: expect.stringContaining('was not made by a publish or rollback job of box.yml on main') };
    // The recorded records as they are: another workflow's job.
    expect(await lastDeployed(api({ ...recordedPublish(), [jobPath]: { status: 200, body: recordedJob }, [runPath]: { status: 200, body: recordedRun } }).get, RECORDED_REPO)).toMatchObject(notTrusted);
    for (const [job, run] of [
      [{ name: 'box' }, {}],
      [{ head_branch: 'feature' }, {}],
      [{ conclusion: 'failure' }, {}],
      [{ head_sha: commit() }, {}],
      [{ run_id: 1 }, {}],
      [{}, { path: '.github/workflows/other.yml' }],
      [{}, { head_branch: 'feature' }],
    ] as const) {
      expect(await lastDeployed(api(recordedPublish(job, run)).get, RECORDED_REPO)).toMatchObject(notTrusted);
    }
    const throughTheApi = api({ ...recordedPublish(), [statusesPath(deployment.id)]: latest(recordedApiStatuses) });
    expect(await lastDeployed(throughTheApi.get, RECORDED_REPO)).toMatchObject(notTrusted);
    const elsewhere = api({ ...recordedPublish(), [statusesPath(deployment.id)]: latest([{ ...(recordedStatuses[0] as Status), log_url: `https://example.test/${RECORDED_REPO}/actions/runs/${recordedRun.id}/job/${recordedJob.id}` }]) });
    expect(await lastDeployed(elsewhere.get, RECORDED_REPO)).toMatchObject(notTrusted);
  });

  it('says not known when GitHub does not answer', async () => {
    expect(await lastDeployed(api({ [deploymentsPath]: { status: 502, body: null } }).get, RECORDED_REPO)).toMatchObject({ kind: 'unknown' });
    expect(await lastDeployed(api({ ...recordedPublish(), [statusesPath(deployment.id)]: { status: 500, body: null } }).get, RECORDED_REPO)).toMatchObject({ kind: 'unknown' });
    expect(await lastDeployed(api({ ...recordedPublish(), [jobPath]: { status: 500, body: null } }).get, RECORDED_REPO)).toMatchObject({ kind: 'unknown', reason: expect.stringContaining('could not be read') });
    expect(await lastDeployed(api({ ...recordedPublish(), [runPath]: { status: 500, body: null } }).get, RECORDED_REPO)).toMatchObject({ kind: 'unknown', reason: expect.stringContaining('could not be read') });
  });
});

describe('compare', () => {
  const [base, head] = [commit(), commit()];

  it('reads the recorded comparisons: ancestry from the status, the files whole only below 300', async () => {
    expect(await compare(api({ [comparePath(base, head)]: { status: 200, body: fixture('compare-ahead') } }).get, RECORDED_REPO, base, head)).toMatchObject({
      kind: 'compared',
      status: 'ahead',
      complete: true,
      files: expect.arrayContaining(['.github/workflows/box.yml', 'Dockerfile.box']),
    });
    expect(await compare(api({ [comparePath(base, head)]: { status: 200, body: fixture('compare-behind') } }).get, RECORDED_REPO, base, head)).toEqual({ kind: 'compared', status: 'behind', files: [], complete: true });
    const cut = await compare(api({ [comparePath(base, head)]: { status: 200, body: fixture('compare-cut-at-300') } }).get, RECORDED_REPO, base, head);
    expect(cut).toMatchObject({ kind: 'compared', status: 'ahead', complete: false });
  });

  it('keeps the old name of a renamed file, and says not known for a failed call', async () => {
    const renamed = { status: 'ahead', files: [{ filename: 'services/box/b.ts', status: 'renamed', previous_filename: 'old/b.ts' }] };
    expect(await compare(api({ [comparePath(base, head)]: { status: 200, body: renamed } }).get, RECORDED_REPO, base, head)).toMatchObject({ files: ['services/box/b.ts', 'old/b.ts'] });
    expect(await compare(api({ [comparePath(base, head)]: { status: 404, body: null } }).get, RECORDED_REPO, base, head)).toMatchObject({ kind: 'unknown' });
  });
});

describe('decideRun', () => {
  const push = (extra: Record<string, string> = {}) => ({ EVENT: 'push', REF: MAIN, ENABLED: 'true', GITHUB_REPOSITORY: RECORDED_REPO, BEFORE: commit(), ...extra });

  it('asks GitHub nothing for a pull request, another branch, a manual run, or with publishing off', async () => {
    for (const env of [
      { EVENT: 'pull_request', REF: 'refs/pull/1/merge', ENABLED: 'true' },
      { EVENT: 'push', REF: 'refs/heads/x', ENABLED: 'true' },
      { EVENT: 'push', REF: MAIN, ENABLED: 'false' },
      { EVENT: 'workflow_dispatch', REF: MAIN, ENABLED: 'true' },
    ]) {
      const { get, asked } = api({});
      await decideRun({ ...env, GITHUB_REPOSITORY: REPO, SHA: commit(), BEFORE: commit() }, get);
      expect(asked).toEqual([]);
    }
  });

  it('publishes a box change since the recorded deployment', async () => {
    const sha = commit();
    const { get } = api({ ...recordedPublish(), [comparePath(deployment.sha, sha)]: { status: 200, body: fixture('compare-ahead') } });
    expect(await decideRun(push({ SHA: sha }), get)).toEqual({ publish: true });
  });

  it('holds with a notice, not an error, when the recorded comparison is cut at 300 files', async () => {
    const sha = commit();
    const decision = await decideRun(push({ SHA: sha }), api({ ...recordedPublish(), [comparePath(deployment.sha, sha)]: { status: 200, body: fixture('compare-cut-at-300') } }).get);
    expect(decision.publish).toBe(false);
    expect(decision.error).toBeUndefined();
    expect(decision.notice?.title).toContain('too many changes');
  });

  it('publishes the first deploy while only the running job\'s own deployment is listed', async () => {
    const decision = await decideRun(push({ SHA: commit(), BEFORE: '0'.repeat(40) }), api({ [deploymentsPath]: { status: 200, body: [ownRunningRow] }, ...ownRunning }).get);
    expect(decision.publish).toBe(true);
  });

  it('still compares while pinned, and says to deploy the application first when the database changed', async () => {
    const sha = commit();
    const migration = { status: 'ahead', files: [{ filename: 'prisma/migrations/2026/migration.sql', status: 'added' }] };
    const decision = await decideRun(push({ SHA: sha, PINNED: 'true' }), api({ ...recordedPublish(), [comparePath(deployment.sha, sha)]: { status: 200, body: migration } }).get);
    expect(decision).toMatchObject({ publish: false, notice: { title: 'box not published: pinned, and deploy the application first' } });
    const failing = await decideRun(push({ SHA: sha, PINNED: 'true' }), api({ [deploymentsPath]: { status: 502, body: null } }).get);
    expect(failing).toMatchObject({ publish: false, notice: { title: 'box not published: pinned' } });
    expect(failing.error).toBeUndefined();
  });

  it('fails loudly, naming the way out, when the deployments cannot be read', async () => {
    const decision = await decideRun(push({ SHA: commit() }), api({ [deploymentsPath]: { status: 502, body: null } }).get);
    expect(decision.publish).toBe(false);
    expect(decision.error).toContain('HTTP 502');
    expect(decision.error).toContain('Run the box workflow by hand on main with override_guard');
  });

  it('refuses a malformed repository or commit', async () => {
    const { get } = api({});
    await expect(decideRun(push({ GITHUB_REPOSITORY: 'owner/repo/../x', SHA: commit() }), get)).rejects.toThrow();
    await expect(decideRun(push({ SHA: 'main' }), get)).rejects.toThrow();
  });
});

describe('guard', () => {
  const run = (extra: Record<string, string | undefined> = {}) => ({ EVENT: 'push', REF: MAIN, GITHUB_REPOSITORY: RECORDED_REPO, SHA: commit(), ...extra });

  it('passes the first publish, where only its own in-progress deployment is listed', async () => {
    const { get } = api({ [deploymentsPath]: { status: 200, body: [ownRunningRow] }, ...ownRunning });
    expect((await guard(run({ SHA: ownRunningRow.sha }), get)).ok).toBe(true);
  });

  it('passes when the recorded deployment is this commit or an ancestor, whatever the number of files', async () => {
    const sha = commit();
    for (const body of [fixture('compare-ahead'), fixture('compare-cut-at-300'), { status: 'identical', files: [] }]) {
      const { get } = api({ ...recordedPublish(), [deploymentsPath]: { status: 200, body: [ownRunningRow, deployment] }, ...ownRunning, [comparePath(deployment.sha, sha)]: { status: 200, body } });
      expect((await guard(run({ SHA: sha }), get)).ok).toBe(true);
    }
    expect((await guard(run({ SHA: deployment.sha }), api(recordedPublish()).get)).ok).toBe(true);
  });

  it('refuses a re-run of an older run once production has moved past it, and names the way out', async () => {
    const older = commit();
    for (const body of [fixture('compare-behind'), { status: 'diverged', files: [] }]) {
      const result = await guard(run({ SHA: older }), api({ ...recordedPublish(), [comparePath(deployment.sha, older)]: { status: 200, body } }).get);
      expect(result.ok).toBe(false);
      expect(result.message).toContain('would deploy an older box over a newer one');
      expect(result.message).toContain('override_guard');
    }
  });

  it('refuses when what runs is not known, and a manual run with override_guard then passes', async () => {
    const unknownRuns = api({ ...recordedPublish(), [jobPath]: { status: 200, body: recordedJob } });
    const refused = await guard(run(), unknownRuns.get);
    expect(refused.ok).toBe(false);
    expect(refused.message).toContain('override_guard');
    expect((await guard(run({ EVENT: 'workflow_dispatch', OVERRIDE_GUARD: 'true', GITHUB_RUN_ATTEMPT: '1' }), unknownRuns.get)).ok).toBe(true);
    // The input means nothing on a push or a re-run of a push.
    expect((await guard(run({ OVERRIDE_GUARD: 'true', GITHUB_RUN_ATTEMPT: '1' }), unknownRuns.get)).ok).toBe(false);
  });

  it('holds override_guard for the first attempt only: a re-run of the override run is refused, asking GitHub nothing', async () => {
    const { get, asked } = api(recordedPublish());
    for (const attempt of ['2', '7', undefined]) {
      const result = await guard(run({ EVENT: 'workflow_dispatch', OVERRIDE_GUARD: 'true', GITHUB_RUN_ATTEMPT: attempt }), get);
      expect(result.ok).toBe(false);
      expect(result.message).toContain('first attempt of a run only');
      expect(result.message).toContain('new manual run');
    }
    expect(asked).toEqual([]);
  });

  it('reads the pin again: a pinned run publishes only by hand with publish_while_pinned, override_guard or not', async () => {
    const { get, asked } = api(recordedPublish());
    for (const extra of [{ PINNED: 'true' }, { PINNED: 'true', EVENT: 'workflow_dispatch' }, { PINNED: 'true', PUBLISH_WHILE_PINNED: 'true' }, { PINNED: 'true', EVENT: 'workflow_dispatch', OVERRIDE_GUARD: 'true' }]) {
      const result = await guard(run({ SHA: deployment.sha, ...extra }), get);
      expect(result.ok).toBe(false);
      expect(result.message).toContain('BOX_DEPLOY_PINNED is true');
      expect(result.message).toContain('Lift the pin');
    }
    expect(asked).toEqual([]);
    expect((await guard(run({ SHA: deployment.sha, PINNED: 'true', EVENT: 'workflow_dispatch', PUBLISH_WHILE_PINNED: 'true' }), get)).ok).toBe(true);
  });

  it('refuses a run that is not on main', async () => {
    expect((await guard(run({ REF: 'refs/heads/x' }), api(recordedPublish()).get)).ok).toBe(false);
  });
});

describe('the script as the workflow runs it', () => {
  it('writes publish=false and a notice for a pull request, without asking GitHub', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'publish-decision-'));
    try {
      const output = path.join(dir, 'output');
      const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'ci', 'publishDecision.ts')], {
        env: { PATH: process.env.PATH, EVENT: 'push', REF: MAIN, ENABLED: 'false', GITHUB_OUTPUT: output, GITHUB_API_URL: 'http://127.0.0.1:9' },
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      expect(readFileSync(output, 'utf8')).toBe('publish=false\n');
      expect(result.stdout).toMatch(/^::notice title=box not published::The repository variable BOX_DEPLOY_ENABLED/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails the step with publish=false and an error when GitHub cannot be asked', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'publish-decision-'));
    try {
      const output = path.join(dir, 'output');
      const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'ci', 'publishDecision.ts')], {
        env: { PATH: process.env.PATH, EVENT: 'push', REF: MAIN, ENABLED: 'true', GITHUB_REPOSITORY: REPO, SHA: commit(), BEFORE: commit(), GITHUB_OUTPUT: output, GITHUB_API_URL: 'http://127.0.0.1:9', GITHUB_TOKEN: 'test' },
        encoding: 'utf8',
      });
      expect(result.status).toBe(1);
      expect(readFileSync(output, 'utf8')).toBe('publish=false\n');
      expect(result.stdout).toMatch(/^::error::The commit running in box-production is not known \(the deployments answered HTTP 0\)/m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('as the guard, fails the step with an error while pinned, without asking GitHub', () => {
    const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'ci', 'publishDecision.ts'), 'guard'], {
      env: { PATH: process.env.PATH, EVENT: 'push', REF: MAIN, PINNED: 'true', GITHUB_REPOSITORY: REPO, SHA: commit(), GITHUB_API_URL: 'http://127.0.0.1:9' },
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/^::error::BOX_DEPLOY_PINNED is true now/);
  });

  it('as the guard, prints the verdict the workflow step looks for, also when started through a symlinked path', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'publish-decision-'));
    try {
      const linked = path.join(dir, 'publishDecision.ts');
      symlinkSync(path.join(__dirname, '..', 'ci', 'publishDecision.ts'), linked);
      // An override run passes before asking GitHub anything; a pinned push is refused the same way.
      const answer = spawnSync(process.execPath, [linked, 'guard'], {
        env: { PATH: process.env.PATH, EVENT: 'workflow_dispatch', REF: MAIN, OVERRIDE_GUARD: 'true', GITHUB_RUN_ATTEMPT: '1', GITHUB_REPOSITORY: REPO, SHA: commit(), GITHUB_API_URL: 'http://127.0.0.1:9' },
        encoding: 'utf8',
      });
      expect(answer.status).toBe(0);
      expect(answer.stdout).toBe(`${VERDICT}override_guard: the operator has checked what runs in box-production.\n`);
      const refused = spawnSync(process.execPath, [linked, 'guard'], {
        env: { PATH: process.env.PATH, EVENT: 'push', REF: MAIN, PINNED: 'true', GITHUB_REPOSITORY: REPO, SHA: commit(), GITHUB_API_URL: 'http://127.0.0.1:9' },
        encoding: 'utf8',
      });
      expect(refused.status).toBe(1);
      expect(refused.stdout).toMatch(/^::error::BOX_DEPLOY_PINNED is true now/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("box.yml's guard step", () => {
    const ROOT = path.join(__dirname, '..', '..', '..');
    /** The step's run block as written in the workflow, without its indentation. */
    const stepBody = () => {
      const workflow = readFileSync(path.join(ROOT, '.github', 'workflows', 'box.yml'), 'utf8');
      const start = workflow.indexOf('run: |', workflow.indexOf('- name: May this run still publish'));
      const lines = workflow.slice(start).split('\n').slice(1);
      const body = lines.slice(0, lines.findIndex((line) => line.trim() !== '' && !line.startsWith('          ')));
      return body.map((line) => line.slice(10)).join('\n');
    };
    /** Runs the step as GitHub does (bash -e -o pipefail), with `node` replaced by `fakeNode` when given. */
    const step = (env: Record<string, string>, fakeNode?: string) => {
      const dir = mkdtempSync(path.join(tmpdir(), 'guard-step-'));
      try {
        if (fakeNode !== undefined) {
          writeFileSync(path.join(dir, 'node'), `#!/bin/sh\n${fakeNode}\n`);
          chmodSync(path.join(dir, 'node'), 0o755);
        }
        const PATH = fakeNode === undefined ? `${path.dirname(process.execPath)}:${process.env.PATH}` : `${dir}:${process.env.PATH}`;
        return spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', stepBody()], { cwd: ROOT, env: { PATH, ...env }, encoding: 'utf8' });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };

    it('passes on the real guard\'s verdict', () => {
      const result = step({ EVENT: 'workflow_dispatch', REF: MAIN, OVERRIDE_GUARD: 'true', GITHUB_RUN_ATTEMPT: '1', GITHUB_REPOSITORY: REPO, SHA: commit(), GITHUB_API_URL: 'http://127.0.0.1:9' });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(VERDICT);
    });

    it('fails, showing the error, when the guard refuses', () => {
      const result = step({ EVENT: 'push', REF: MAIN, PINNED: 'true', GITHUB_REPOSITORY: REPO, SHA: commit(), GITHUB_API_URL: 'http://127.0.0.1:9' });
      expect(result.status).toBe(1);
      expect(result.stdout).toMatch(/^::error::BOX_DEPLOY_PINNED is true now/);
    });

    it('fails when the script exits 0 without a verdict, as one that checked nothing would', () => {
      for (const fakeNode of ['exit 0', "echo 'something else'"]) {
        const result = step({}, fakeNode);
        expect(result.status).toBe(1);
        expect(result.stdout).toContain('::error::The guard printed no verdict');
      }
    });
  });

  it('escapes what GitHub would read as a command', () => {
    expect(noticeLine({ title: 'a: b, c', message: 'x\ny%' })).toBe('::notice title=a%3A b%2C c::x%0Ay%25');
  });
});
