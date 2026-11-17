import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { changedFiles, decide, decideRun, type GetJson, lastDeployed, noticeLine } from '../ci/publishDecision';

const commit = () => randomBytes(20).toString('hex');
const REPO = 'owner/repo';
const MAIN = 'refs/heads/main';
const files = (...list: string[]) => ({ kind: 'files' as const, files: list });
const unknown = { kind: 'unknown' as const, reason: 'test' };

describe('decide', () => {
  const deployed = { kind: 'commit' as const, sha: commit() };
  const base = { event: 'push', ref: MAIN, enabled: true, deployed, sinceDeployed: files(), thisPush: files() };

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

  it('publishes when nothing was ever deployed or what runs is not known, and says why', () => {
    const none = decide({ ...base, deployed: { kind: 'none' }, sinceDeployed: unknown, thisPush: files('README.md') });
    expect(none.publish).toBe(true);
    expect(none.notice?.message).toContain('nothing has been deployed');
    const notKnown = decide({ ...base, deployed: { kind: 'unknown', reason: 'HTTP 500' }, sinceDeployed: unknown, thisPush: unknown });
    expect(notKnown.publish).toBe(true);
    expect(notKnown.notice?.message).toContain('HTTP 500');
    const notCompared = decide({ ...base, sinceDeployed: { kind: 'unknown', reason: 'diverged' }, thisPush: unknown });
    expect(notCompared.publish).toBe(true);
    expect(notCompared.notice?.message).toContain('diverged');
  });

  it('still holds a database change back when what runs is not known but this push shows it', () => {
    const decision = decide({ ...base, deployed: { kind: 'unknown', reason: 'x' }, sinceDeployed: unknown, thisPush: files('prisma/sql/box-reader.sql') });
    expect(decision.publish).toBe(false);
    expect(decision.notice?.title).toContain('deploy the application first');
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

describe('lastDeployed', () => {
  it('takes the newest deployment whose latest status is success, passing over failed, running and cancelled ones', async () => {
    const [failed, running, good, older] = [commit(), commit(), commit(), commit()];
    const { get } = api({
      [deploymentsPath]: { status: 200, body: [{ id: 4, sha: failed }, { id: 3, sha: running }, { id: 2, sha: good }, { id: 1, sha: older }] },
      [statusesPath(4)]: { status: 200, body: [{ state: 'failure' }] },
      [statusesPath(3)]: { status: 200, body: [{ state: 'in_progress' }] },
      [statusesPath(2)]: { status: 200, body: [{ state: 'success' }] },
      [statusesPath(1)]: { status: 200, body: [{ state: 'inactive' }] },
    });
    expect(await lastDeployed(get, REPO)).toEqual({ kind: 'commit', sha: good });
  });

  it('says none when nothing was ever deployed, and not known when the API fails or nothing succeeded', async () => {
    expect(await lastDeployed(api({ [deploymentsPath]: { status: 200, body: [] } }).get, REPO)).toEqual({ kind: 'none' });
    expect(await lastDeployed(api({ [deploymentsPath]: { status: 403, body: {} } }).get, REPO)).toMatchObject({ kind: 'unknown' });
    expect(await lastDeployed(api({ [deploymentsPath]: { status: 0, body: null } }).get, REPO)).toMatchObject({ kind: 'unknown' });
    const failedOnly = api({ [deploymentsPath]: { status: 200, body: [{ id: 1, sha: commit() }] }, [statusesPath(1)]: { status: 200, body: [{ state: 'error' }] } });
    expect(await lastDeployed(failedOnly.get, REPO)).toMatchObject({ kind: 'unknown' });
    const statusesFail = api({ [deploymentsPath]: { status: 200, body: [{ id: 1, sha: commit() }] }, [statusesPath(1)]: { status: 500, body: null } });
    expect(await lastDeployed(statusesFail.get, REPO)).toMatchObject({ kind: 'unknown' });
  });

  it('passes over a row that is not a deployment of a commit', async () => {
    const good = commit();
    const { get, asked } = api({
      [deploymentsPath]: { status: 200, body: [{ id: 2, sha: 'main' }, { id: '1', sha: good }, { id: 3, sha: good }] },
      [statusesPath(3)]: { status: 200, body: [{ state: 'success' }] },
    });
    expect(await lastDeployed(get, REPO)).toEqual({ kind: 'commit', sha: good });
    expect(asked).toEqual([deploymentsPath, statusesPath(3)]);
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
  it('asks GitHub nothing for a pull request, another branch, or with publishing off', async () => {
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

  it('compares the push with the deployed commit, and this push alone too', async () => {
    const [deployedSha, before, sha] = [commit(), commit(), commit()];
    const { get, asked } = api({
      [deploymentsPath]: { status: 200, body: [{ id: 7, sha: deployedSha }] },
      [statusesPath(7)]: { status: 200, body: [{ state: 'success' }] },
      [`/repos/${REPO}/compare/${deployedSha}...${sha}?per_page=1`]: { status: 200, body: { status: 'ahead', files: [{ filename: 'services/box/src/x.ts' }, { filename: 'README.md' }] } },
      [`/repos/${REPO}/compare/${before}...${sha}?per_page=1`]: { status: 200, body: { status: 'ahead', files: [{ filename: 'README.md' }] } },
    });
    const decision = await decideRun({ EVENT: 'push', REF: MAIN, ENABLED: 'true', GITHUB_REPOSITORY: REPO, SHA: sha, BEFORE: before }, get);
    expect(decision).toEqual({ publish: true });
    expect(asked).toHaveLength(4);
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

  it('escapes what GitHub would read as a command', () => {
    expect(noticeLine({ title: 'a: b, c', message: 'x\ny%' })).toBe('::notice title=a%3A b%2C c::x%0Ay%25');
  });
});
