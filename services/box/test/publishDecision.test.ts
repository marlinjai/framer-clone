import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { changedFiles, decide, decideRun, type GetJson, guard, lastDeployed, noticeLine } from '../ci/publishDecision';

const commit = () => randomBytes(20).toString('hex');
const REPO = 'owner/repo';
const MAIN = 'refs/heads/main';
const files = (...list: string[]) => ({ kind: 'files' as const, files: list });
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
    expect(none.notice?.message).toContain('nothing has been deployed');
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
    expect(notKnown.error).toContain('run the box workflow by hand');
    const notCompared = decide({ ...base, sinceDeployed: { kind: 'unknown', reason: 'diverged' }, thisPush: files('services/box/src/main.ts') });
    expect(notCompared.publish).toBe(false);
    expect(notCompared.error).toContain('diverged');
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

const deploymentsPath = `/repos/${REPO}/deployments?environment=box-production&per_page=30`;
const statusesPath = (id: number) => `/repos/${REPO}/deployments/${id}/statuses?per_page=1`;

const BOT = { login: 'github-actions[bot]' };
const runsPath = (sha: string) => `/repos/${REPO}/actions/workflows/box.yml/runs?head_sha=${sha}&branch=main&per_page=20`;
const jobsPath = (run: number) => `/repos/${REPO}/actions/runs/${run}/jobs?per_page=50`;

/** The answers that show a commit was deployed by a run of box.yml on main whose given job succeeded. */
function madeBy(sha: string, run: number, job = 'publish and deploy') {
  return {
    [runsPath(sha)]: { status: 200, body: { workflow_runs: [{ id: run, head_branch: 'main', head_sha: sha, path: '.github/workflows/box.yml' }] } },
    [jobsPath(run)]: { status: 200, body: { jobs: [{ name: 'box', conclusion: 'success' }, { name: job, conclusion: 'success' }] } },
  };
}

/** One successful deployment of a commit, made by the workflow. */
function deployedAt(sha: string, id = 7) {
  return {
    [deploymentsPath]: { status: 200, body: [{ id, sha, creator: BOT }] },
    [statusesPath(id)]: { status: 200, body: [{ state: 'success' }] },
    ...madeBy(sha, 100 + id),
  };
}

describe('lastDeployed', () => {
  it('takes the newest deployment whose latest status is success, passing over failed, running and cancelled ones', async () => {
    const [failed, running, good, older] = [commit(), commit(), commit(), commit()];
    const { get } = api({
      [deploymentsPath]: { status: 200, body: [{ id: 4, sha: failed, creator: BOT }, { id: 3, sha: running, creator: BOT }, { id: 2, sha: good, creator: BOT }, { id: 1, sha: older, creator: BOT }] },
      [statusesPath(4)]: { status: 200, body: [{ state: 'failure' }] },
      [statusesPath(3)]: { status: 200, body: [{ state: 'in_progress' }] },
      [statusesPath(2)]: { status: 200, body: [{ state: 'success' }] },
      [statusesPath(1)]: { status: 200, body: [{ state: 'inactive' }] },
      ...madeBy(good, 20),
    });
    expect(await lastDeployed(get, REPO)).toEqual({ kind: 'commit', sha: good });
  });

  it('counts a rollback job as a deployment of the workflow', async () => {
    const sha = commit();
    const { get } = api({ [deploymentsPath]: { status: 200, body: [{ id: 1, sha, creator: BOT }] }, [statusesPath(1)]: { status: 200, body: [{ state: 'success' }] }, ...madeBy(sha, 5, 'roll back') });
    expect(await lastDeployed(get, REPO)).toEqual({ kind: 'commit', sha });
  });

  it('says none when nothing was ever deployed, and not known when the API fails or nothing succeeded', async () => {
    expect(await lastDeployed(api({ [deploymentsPath]: { status: 200, body: [] } }).get, REPO)).toEqual({ kind: 'none' });
    expect(await lastDeployed(api({ [deploymentsPath]: { status: 403, body: {} } }).get, REPO)).toMatchObject({ kind: 'unknown' });
    expect(await lastDeployed(api({ [deploymentsPath]: { status: 0, body: null } }).get, REPO)).toMatchObject({ kind: 'unknown' });
    const failedOnly = api({ [deploymentsPath]: { status: 200, body: [{ id: 1, sha: commit(), creator: BOT }] }, [statusesPath(1)]: { status: 200, body: [{ state: 'error' }] } });
    expect(await lastDeployed(failedOnly.get, REPO)).toMatchObject({ kind: 'unknown' });
    const statusesFail = api({ [deploymentsPath]: { status: 200, body: [{ id: 1, sha: commit(), creator: BOT }] }, [statusesPath(1)]: { status: 500, body: null } });
    expect(await lastDeployed(statusesFail.get, REPO)).toMatchObject({ kind: 'unknown' });
  });

  it('trusts no success this workflow did not make: by hand, by another workflow, or with no deploying job', async () => {
    const sha = commit();
    const success = { [deploymentsPath]: { status: 200, body: [{ id: 1, sha, creator: { login: 'someone' } }] }, [statusesPath(1)]: { status: 200, body: [{ state: 'success' }] } };
    expect(await lastDeployed(api({ ...success, ...madeBy(sha, 3) }).get, REPO)).toMatchObject({ kind: 'unknown', reason: expect.stringContaining('not made by GitHub Actions') });
    const byBot = { [deploymentsPath]: { status: 200, body: [{ id: 1, sha, creator: BOT }] }, [statusesPath(1)]: { status: 200, body: [{ state: 'success' }] } };
    // No run of box.yml on main at that commit (a branch workflow made it through the API).
    expect(await lastDeployed(api({ ...byBot, [runsPath(sha)]: { status: 200, body: { workflow_runs: [] } } }).get, REPO)).toMatchObject({ kind: 'unknown', reason: expect.stringContaining('was not made by a publish or rollback job') });
    // A run of another branch or another file, or one whose deploying job did not succeed.
    for (const run of [
      { id: 3, head_branch: 'feature', head_sha: sha, path: '.github/workflows/box.yml' },
      { id: 3, head_branch: 'main', head_sha: sha, path: '.github/workflows/other.yml' },
    ]) {
      expect(await lastDeployed(api({ ...byBot, [runsPath(sha)]: { status: 200, body: { workflow_runs: [run] } }, [jobsPath(3)]: { status: 200, body: { jobs: [{ name: 'publish and deploy', conclusion: 'success' }] } } }).get, REPO)).toMatchObject({ kind: 'unknown' });
    }
    const skipped = { ...byBot, ...madeBy(sha, 3), [jobsPath(3)]: { status: 200, body: { jobs: [{ name: 'publish and deploy', conclusion: 'skipped' }, { name: 'roll back', conclusion: 'failure' }] } } };
    expect(await lastDeployed(api(skipped).get, REPO)).toMatchObject({ kind: 'unknown' });
    expect(await lastDeployed(api({ ...byBot, [runsPath(sha)]: { status: 502, body: null } }).get, REPO)).toMatchObject({ kind: 'unknown', reason: expect.stringContaining('could not be read') });
  });

  it('passes over a row that is not a deployment of a commit', async () => {
    const good = commit();
    const { get, asked } = api({
      [deploymentsPath]: { status: 200, body: [{ id: 2, sha: 'main' }, { id: '1', sha: good }, { id: 3, sha: good, creator: BOT }] },
      [statusesPath(3)]: { status: 200, body: [{ state: 'success' }] },
      ...madeBy(good, 9),
    });
    expect(await lastDeployed(get, REPO)).toEqual({ kind: 'commit', sha: good });
    expect(asked).toEqual([deploymentsPath, statusesPath(3), runsPath(good), jobsPath(9)]);
  });
});

describe('changedFiles', () => {
  const [base, head] = [commit(), commit()];
  const comparePath = `/repos/${REPO}/compare/${base}...${head}?per_page=1`;

  it('lists the files of a comparison, with the old name of a renamed file', async () => {
    const { get } = api({
      [comparePath]: { status: 200, body: { status: 'ahead', files: [{ filename: 'a.ts' }, { filename: 'services/box/b.ts', previous_filename: 'old/b.ts' }] } },
    });
    expect(await changedFiles(get, REPO, base, head)).toEqual({ kind: 'files', files: ['a.ts', 'services/box/b.ts', 'old/b.ts'] });
  });

  it('gives no files for the same commit, and not known for a commit that is not an ancestor, a cut list or a failed call', async () => {
    expect(await changedFiles(api({ [comparePath]: { status: 200, body: { status: 'identical', files: [] } } }).get, REPO, base, head)).toEqual({ kind: 'files', files: [] });
    for (const status of ['behind', 'diverged']) {
      expect(await changedFiles(api({ [comparePath]: { status: 200, body: { status, files: [] } } }).get, REPO, base, head)).toMatchObject({ kind: 'unknown' });
    }
    const many = Array.from({ length: 300 }, (_, index) => ({ filename: `f${index}` }));
    expect(await changedFiles(api({ [comparePath]: { status: 200, body: { status: 'ahead', files: many } } }).get, REPO, base, head)).toMatchObject({ kind: 'unknown' });
    expect(await changedFiles(api({ [comparePath]: { status: 404, body: null } }).get, REPO, base, head)).toMatchObject({ kind: 'unknown' });
  });
});

describe('decideRun', () => {
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

  it('compares the push with the deployed commit, and asks nothing about this push alone', async () => {
    const [deployedSha, before, sha] = [commit(), commit(), commit()];
    const { get } = api({
      ...deployedAt(deployedSha),
      [`/repos/${REPO}/compare/${deployedSha}...${sha}?per_page=1`]: { status: 200, body: { status: 'ahead', files: [{ filename: 'services/box/src/x.ts' }, { filename: 'README.md' }] } },
    });
    const decision = await decideRun({ EVENT: 'push', REF: MAIN, ENABLED: 'true', GITHUB_REPOSITORY: REPO, SHA: sha, BEFORE: before }, get);
    expect(decision).toEqual({ publish: true });
  });

  it('still compares while pinned, and says to deploy the application first when the database changed', async () => {
    const [deployedSha, sha] = [commit(), commit()];
    const { get } = api({
      ...deployedAt(deployedSha),
      [`/repos/${REPO}/compare/${deployedSha}...${sha}?per_page=1`]: { status: 200, body: { status: 'ahead', files: [{ filename: 'prisma/migrations/2026/migration.sql' }] } },
    });
    const decision = await decideRun({ EVENT: 'push', REF: MAIN, ENABLED: 'true', PINNED: 'true', GITHUB_REPOSITORY: REPO, SHA: sha, BEFORE: commit() }, get);
    expect(decision.publish).toBe(false);
    expect(decision.error).toBeUndefined();
    expect(decision.notice?.title).toContain('pinned, and deploy the application first');
    // A GitHub that cannot be asked does not fail a pinned run: it publishes nothing anyway.
    const failing = await decideRun({ EVENT: 'push', REF: MAIN, ENABLED: 'true', PINNED: 'true', GITHUB_REPOSITORY: REPO, SHA: sha, BEFORE: commit() }, api({ [deploymentsPath]: { status: 502, body: null } }).get);
    expect(failing).toMatchObject({ publish: false, notice: { title: 'box not published: pinned' } });
    expect(failing.error).toBeUndefined();
  });

  it('fails loudly when the deployments cannot be read', async () => {
    const { get } = api({ [deploymentsPath]: { status: 502, body: null } });
    const decision = await decideRun({ EVENT: 'push', REF: MAIN, ENABLED: 'true', GITHUB_REPOSITORY: REPO, SHA: commit(), BEFORE: commit() }, get);
    expect(decision.publish).toBe(false);
    expect(decision.error).toContain('HTTP 502');
  });

  it('treats a push without a previous commit as not known, and refuses a malformed repository or commit', async () => {
    const sha = commit();
    const { get, asked } = api({ [deploymentsPath]: { status: 200, body: [] } });
    const decision = await decideRun({ EVENT: 'push', REF: MAIN, ENABLED: 'true', GITHUB_REPOSITORY: REPO, SHA: sha, BEFORE: '0'.repeat(40) }, get);
    expect(decision.publish).toBe(true);
    expect(asked).toEqual([deploymentsPath]);
    await expect(decideRun({ EVENT: 'push', REF: MAIN, ENABLED: 'true', GITHUB_REPOSITORY: 'owner/repo/../x', SHA: sha, BEFORE: '' }, get)).rejects.toThrow();
    await expect(decideRun({ EVENT: 'push', REF: MAIN, ENABLED: 'true', GITHUB_REPOSITORY: REPO, SHA: 'main', BEFORE: '' }, get)).rejects.toThrow();
  });
});

describe('guard', () => {
  const run = (extra: Record<string, string | undefined> = {}) => ({ EVENT: 'push', REF: MAIN, GITHUB_REPOSITORY: REPO, SHA: '', ...extra });

  it('lets a run publish when the deployed commit is this one or an ancestor, or nothing was deployed', async () => {
    const [deployedSha, sha] = [commit(), commit()];
    const ahead = api({ ...deployedAt(deployedSha), [`/repos/${REPO}/compare/${deployedSha}...${sha}?per_page=1`]: { status: 200, body: { status: 'ahead', files: [] } } });
    expect((await guard(run({ SHA: sha }), ahead.get)).ok).toBe(true);
    expect((await guard(run({ SHA: deployedSha }), api(deployedAt(deployedSha)).get)).ok).toBe(true);
    expect((await guard(run({ SHA: sha }), api({ [deploymentsPath]: { status: 200, body: [] } }).get)).ok).toBe(true);
  });

  it('refuses a re-run of an older run once production has moved past it', async () => {
    const [newer, older] = [commit(), commit()];
    for (const status of ['behind', 'diverged']) {
      const { get } = api({ ...deployedAt(newer), [`/repos/${REPO}/compare/${newer}...${older}?per_page=1`]: { status: 200, body: { status, files: [] } } });
      const result = await guard(run({ SHA: older }), get);
      expect(result.ok).toBe(false);
      expect(result.message).toContain('would deploy an older box over a newer one');
    }
  });

  it('reads the pin again: a pinned run publishes only by hand with publish_while_pinned', async () => {
    const sha = commit();
    const { get, asked } = api(deployedAt(sha));
    for (const extra of [{ PINNED: 'true' }, { PINNED: 'true', EVENT: 'workflow_dispatch' }, { PINNED: 'true', PUBLISH_WHILE_PINNED: 'true' }] as Record<string, string>[]) {
      const result = await guard(run({ SHA: sha, ...extra }), get);
      expect(result.ok).toBe(false);
      expect(result.message).toContain('BOX_DEPLOY_PINNED is true');
    }
    expect(asked).toEqual([]);
    expect((await guard(run({ SHA: sha, PINNED: 'true', EVENT: 'workflow_dispatch', PUBLISH_WHILE_PINNED: 'true' }), get)).ok).toBe(true);
  });

  it('refuses when what runs is not known, or the run is not on main', async () => {
    const sha = commit();
    expect((await guard(run({ SHA: sha }), api({ [deploymentsPath]: { status: 500, body: null } }).get)).ok).toBe(false);
    expect((await guard(run({ SHA: sha, REF: 'refs/heads/x' }), api(deployedAt(sha)).get)).ok).toBe(false);
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

  it('escapes what GitHub would read as a command', () => {
    expect(noticeLine({ title: 'a: b, c', message: 'x\ny%' })).toBe('::notice title=a%3A b%2C c::x%0Ay%25');
  });
});
