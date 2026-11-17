import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Whether a run of the box workflow publishes and deploys the image (decisions D53, D56 and D59 of
// docs/plans/2026-11-02-sandboxed-custom-code.md). Run by the workflow as `node ci/publishDecision.ts`
// (node strips the types); it needs nothing installed.
//
// The question is not what this push changed, but what changed since the commit that is running in
// production: the commit of the last successful deployment to the GitHub environment box-production.
// A cancelled or failed deploy is therefore picked up by the next run, whatever that run's push touched.

/** The files whose change means a new image: the box, what it bundles, how it is built and deployed. */
export const BOX_PATHS = ['services/box/', 'src/lib/customCode/contract.ts', 'Dockerfile.box', 'Dockerfile.box.dockerignore', '.github/workflows/box.yml'];

/** The files whose change means the application must be deployed first: the database the box reads. */
export const DATABASE_PATHS = ['prisma/migrations/', 'prisma/sql/'];

export const ENVIRONMENT = 'box-production';

/** What changed between two commits, as far as could be told. */
export type Changes = { kind: 'files'; files: string[] } | { kind: 'unknown'; reason: string };

/** The commit running in production: a commit, none ever deployed, or not known. */
export type Deployed = { kind: 'commit'; sha: string } | { kind: 'none' } | { kind: 'unknown'; reason: string };

export interface DecisionInput {
  event: string;
  ref: string;
  enabled: boolean;
  /** BOX_DEPLOY_PINNED: a rollback holds; nothing is published unless a manual run says so. */
  pinned: boolean;
  /** A manual run's input publish_while_pinned: publish main although the box is pinned. */
  publishWhilePinned: boolean;
  /** A manual run's input rollback_digest: this run redeploys that image and publishes nothing. */
  rollbackDigest: string;
  deployed: Deployed;
  /** The changes since the deployed commit, when it is known. */
  sinceDeployed: Changes;
  /** The changes of this push alone, used for the database check when nothing was ever deployed. */
  thisPush: Changes;
}

export interface Decision {
  publish: boolean;
  notice?: { title: string; message: string };
  /** Set when the run cannot decide: the step fails, and the operator re-runs it or runs the workflow by hand. */
  error?: string;
}

const touches = (files: readonly string[], paths: readonly string[]) =>
  files.some((file) => paths.some((path) => (path.endsWith('/') ? file.startsWith(path) : file === path)));

const DATABASE_NOTICE = {
  title: 'box not published: deploy the application first',
  message:
    'The database the box reads changed (prisma/migrations or prisma/sql) since the commit running in box-production. Migrations reach production only with a deploy of the application, so the box is not deployed now: deploy the application, then run the box workflow by hand on main (deploy/README.md, the box).',
};

const PINNED_NOTICE = {
  title: 'box not published: pinned',
  message:
    'The repository variable BOX_DEPLOY_PINNED is true: a rollback holds, so nothing is published. To lift the pin, deploy the application first if a migration landed since the rollback, then set BOX_DEPLOY_PINNED to false and run the box workflow by hand on main (deploy/README.md, the box).',
};

const PINNED_DATABASE_NOTICE = {
  title: 'box not published: pinned, and deploy the application first',
  message:
    'The repository variable BOX_DEPLOY_PINNED is true: a rollback holds, so nothing is published. The database the box reads (prisma/migrations or prisma/sql) has also changed since the commit running in box-production: before lifting the pin, deploy the application, then set BOX_DEPLOY_PINNED to false and run the box workflow by hand on main (deploy/README.md, the box).',
};

export function decide(input: DecisionInput): Decision {
  if (input.event === 'pull_request' || input.ref !== 'refs/heads/main') return { publish: false };
  if (!input.enabled) {
    return {
      publish: false,
      notice: {
        title: 'box not published',
        message: 'The repository variable BOX_DEPLOY_ENABLED is not true, so nothing is pushed or deployed. It is set in the operator step O1 (deploy/README.md).',
      },
    };
  }
  const manual = input.event === 'workflow_dispatch';
  // A rollback redeploys an image that exists; the rollback job does it, and nothing is built into production.
  if (manual && input.rollbackDigest !== '') {
    return { publish: false, notice: { title: 'box rollback', message: `This run redeploys the image ${input.rollbackDigest} and publishes nothing.` } };
  }
  // Pinned after a rollback: only a manual run that says so publishes, whatever changed.
  if (input.pinned) {
    if (manual && input.publishWhilePinned) return { publish: true };
    // The comparison is made while pinned too (on a push), so a database change is not hidden by the pin.
    const database = input.deployed.kind === 'commit' && input.sinceDeployed.kind === 'files' && touches(input.sinceDeployed.files, DATABASE_PATHS);
    return { publish: false, notice: database ? PINNED_DATABASE_NOTICE : PINNED_NOTICE };
  }
  // A manual run is the operator's word, given after the application's deploy: it always publishes.
  if (manual) return { publish: true };

  if (input.deployed.kind === 'none') {
    // Nothing ever ran: publish, unless this push already shows a database change.
    if (input.thisPush.kind === 'files' && touches(input.thisPush.files, DATABASE_PATHS)) return { publish: false, notice: DATABASE_NOTICE };
    return { publish: true, notice: { title: 'box published', message: 'The box is published because nothing has been deployed to box-production yet.' } };
  }
  // Not knowing what runs, or what changed since, is not a reason to publish: a database change could lie
  // in between. The step fails, and the operator re-runs it or runs the workflow by hand.
  if (input.deployed.kind === 'unknown') {
    return { publish: false, error: `The commit running in box-production is not known (${input.deployed.reason}). Re-run this run, or run the box workflow by hand on main once the application is deployed.` };
  }
  if (input.sinceDeployed.kind === 'unknown') {
    return { publish: false, error: `What changed since ${input.deployed.sha.slice(0, 12)}, the commit running in box-production, is not known (${input.sinceDeployed.reason}). Re-run this run, or run the box workflow by hand on main once the application is deployed.` };
  }
  const files = input.sinceDeployed.files;
  if (touches(files, DATABASE_PATHS)) return { publish: false, notice: DATABASE_NOTICE };
  if (touches(files, BOX_PATHS)) return { publish: true };
  return {
    publish: false,
    notice: {
      title: 'box not published',
      message: `Nothing of the box changed since ${input.deployed.sha.slice(0, 12)}, the commit running in box-production, so the image is tested and not published.`,
    },
  };
}

/** A GET against the GitHub API: the status, and the parsed body when it is JSON. */
export type GetJson = (path: string) => Promise<{ status: number; body: unknown }>;

interface DeploymentRow {
  id?: unknown;
  sha?: unknown;
  creator?: { login?: unknown } | null;
}

/** The workflow file and the jobs of it that deploy to box-production. */
export const WORKFLOW = 'box.yml';
export const DEPLOYING_JOBS = ['publish and deploy', 'roll back'];

const COMMIT = /^[0-9a-f]{40}$/;

/**
 * Whether a commit was deployed by this workflow: a run of box.yml on main at that commit in which the
 * publish or the rollback job succeeded. A deployment's status names no run (its log address is the
 * commit's checks page), so the runs of the commit are asked instead. Undefined when GitHub cannot say.
 */
export async function deployedByWorkflow(get: GetJson, repository: string, sha: string): Promise<boolean | undefined> {
  const runs = await get(`/repos/${repository}/actions/workflows/${WORKFLOW}/runs?head_sha=${sha}&branch=main&per_page=20`);
  const list = (runs.body as { workflow_runs?: unknown } | null)?.workflow_runs;
  if (runs.status !== 200 || !Array.isArray(list)) return undefined;
  for (const run of list as { id?: unknown; head_branch?: unknown; head_sha?: unknown; path?: unknown }[]) {
    if (typeof run.id !== 'number' || run.head_branch !== 'main' || run.head_sha !== sha) continue;
    if (typeof run.path === 'string' && !run.path.endsWith(`.github/workflows/${WORKFLOW}`)) continue;
    const jobs = await get(`/repos/${repository}/actions/runs/${run.id}/jobs?per_page=50`);
    const jobList = (jobs.body as { jobs?: unknown } | null)?.jobs;
    if (jobs.status !== 200 || !Array.isArray(jobList)) return undefined;
    if ((jobList as { name?: unknown; conclusion?: unknown }[]).some((job) => typeof job.name === 'string' && DEPLOYING_JOBS.includes(job.name) && job.conclusion === 'success')) return true;
  }
  return false;
}

/**
 * The commit of the newest deployment to box-production whose latest status is success, made by this
 * workflow. GitHub lists deployments newest first; a later success marks the earlier ones inactive, and a
 * failed or cancelled one never reaches success, so the first success found is what production runs. A
 * success this workflow did not make (by hand, or by another workflow through the API) is not trusted:
 * what runs is then not known, and the run fails loudly.
 */
export async function lastDeployed(get: GetJson, repository: string): Promise<Deployed> {
  const list = await get(`/repos/${repository}/deployments?environment=${ENVIRONMENT}&per_page=30`);
  if (list.status !== 200 || !Array.isArray(list.body)) return { kind: 'unknown', reason: `the deployments answered HTTP ${list.status}` };
  if (list.body.length === 0) return { kind: 'none' };
  for (const row of list.body as DeploymentRow[]) {
    if (typeof row.id !== 'number' || typeof row.sha !== 'string' || !COMMIT.test(row.sha)) continue;
    const statuses = await get(`/repos/${repository}/deployments/${row.id}/statuses?per_page=1`);
    if (statuses.status !== 200 || !Array.isArray(statuses.body)) {
      return { kind: 'unknown', reason: `a deployment's statuses answered HTTP ${statuses.status}` };
    }
    const latest = statuses.body[0] as { state?: unknown } | undefined;
    if (latest?.state !== 'success') continue;
    const short = row.sha.slice(0, 12);
    if (row.creator?.login !== 'github-actions[bot]') return { kind: 'unknown', reason: `the newest successful deployment, of ${short}, was not made by GitHub Actions` };
    const made = await deployedByWorkflow(get, repository, row.sha);
    if (made === undefined) return { kind: 'unknown', reason: `the runs of ${short} could not be read` };
    if (!made) return { kind: 'unknown', reason: `the newest successful deployment, of ${short}, was not made by a publish or rollback job of ${WORKFLOW} on main` };
    return { kind: 'commit', sha: row.sha };
  }
  return { kind: 'unknown', reason: 'none of the last 30 deployments succeeded' };
}

/** GitHub's compare lists at most 300 files; a longer list cannot be trusted to be whole. */
const COMPARE_FILE_LIMIT = 300;

/** The files changed from `base` to `head`, when `base` is an ancestor of `head` and the list is whole. */
export async function changedFiles(get: GetJson, repository: string, base: string, head: string): Promise<Changes> {
  const answer = await get(`/repos/${repository}/compare/${base}...${head}?per_page=1`);
  if (answer.status !== 200) return { kind: 'unknown', reason: `the comparison answered HTTP ${answer.status}` };
  const body = answer.body as { status?: unknown; files?: unknown };
  if (body.status === 'identical') return { kind: 'files', files: [] };
  if (body.status !== 'ahead') return { kind: 'unknown', reason: `the deployed commit is ${String(body.status)} of this one` };
  if (!Array.isArray(body.files) || body.files.length >= COMPARE_FILE_LIMIT) return { kind: 'unknown', reason: 'the list of changed files is not whole' };
  const files: string[] = [];
  for (const file of body.files as { filename?: unknown; previous_filename?: unknown }[]) {
    if (typeof file.filename === 'string') files.push(file.filename);
    if (typeof file.previous_filename === 'string') files.push(file.previous_filename);
  }
  return { kind: 'files', files };
}

const ZERO = /^0+$/;

function checkRun(repository: string, sha: string): void {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !COMMIT.test(sha)) {
    throw new Error('GITHUB_REPOSITORY or SHA is not what a run on main gives');
  }
}

export interface Guard {
  ok: boolean;
  message: string;
}

/**
 * Asked again at the start of the publish job, with that job's own token, because "Re-run failed jobs"
 * keeps the box job's decision and artifact from an earlier attempt: the pin is read again (unless this is
 * a manual run with publish_while_pinned), and the image is pushed only when the commit running in
 * box-production is this commit or an ancestor of it, so an older run cannot deploy over a newer one.
 */
export async function guard(env: Record<string, string | undefined>, get: GetJson): Promise<Guard> {
  const repository = env.GITHUB_REPOSITORY ?? '';
  const sha = env.SHA ?? '';
  if (env.REF !== 'refs/heads/main') return { ok: false, message: 'Only main publishes.' };
  const manualOverride = env.EVENT === 'workflow_dispatch' && env.PUBLISH_WHILE_PINNED === 'true';
  if (env.PINNED === 'true' && !manualOverride) {
    return { ok: false, message: 'BOX_DEPLOY_PINNED is true now: a rollback holds, so this run publishes nothing (a re-run keeps an earlier decision, which is asked again here).' };
  }
  checkRun(repository, sha);
  const deployed = await lastDeployed(get, repository);
  if (deployed.kind === 'none') return { ok: true, message: 'Nothing has been deployed to box-production yet.' };
  if (deployed.kind === 'unknown') return { ok: false, message: `The commit running in box-production is not known (${deployed.reason}); nothing is pushed. Run the box workflow by hand on main.` };
  if (deployed.sha === sha) return { ok: true, message: `This commit is the one running in box-production.` };
  const since = await changedFiles(get, repository, deployed.sha, sha);
  if (since.kind === 'files') return { ok: true, message: `${deployed.sha.slice(0, 12)}, the commit running in box-production, is an ancestor of this one.` };
  return {
    ok: false,
    message: `${deployed.sha.slice(0, 12)}, the commit running in box-production, is not this commit or an ancestor of it (${since.reason}), so this run would deploy an older box over a newer one; nothing is pushed.`,
  };
}


/** Reads the run, asks GitHub, decides. Everything it reads comes in through `env` and `get`. */
export async function decideRun(env: Record<string, string | undefined>, get: GetJson): Promise<Decision> {
  const event = env.EVENT ?? '';
  const ref = env.REF ?? '';
  const enabled = env.ENABLED === 'true';
  const repository = env.GITHUB_REPOSITORY ?? '';
  const sha = env.SHA ?? '';
  const before = env.BEFORE ?? '';
  const pinned = env.PINNED === 'true';
  const publishWhilePinned = env.PUBLISH_WHILE_PINNED === 'true';
  const rollbackDigest = env.ROLLBACK_DIGEST ?? '';
  const unknown = (reason: string): Changes => ({ kind: 'unknown', reason });
  const settings = { event, ref, enabled, pinned, publishWhilePinned, rollbackDigest };
  // Only a push to main with publishing on needs GitHub at all.
  if (event !== 'push' || ref !== 'refs/heads/main' || !enabled) {
    return decide({ ...settings, deployed: { kind: 'none' }, sinceDeployed: unknown('not asked'), thisPush: unknown('not asked') });
  }
  checkRun(repository, sha);
  const deployed = await lastDeployed(get, repository);
  const sinceDeployed = deployed.kind === 'commit' ? await changedFiles(get, repository, deployed.sha, sha) : unknown('no deployed commit');
  const thisPush = deployed.kind !== 'none' ? unknown('not needed') : !COMMIT.test(before) || ZERO.test(before) ? unknown('the push has no previous commit') : await changedFiles(get, repository, before, sha);
  return decide({ ...settings, deployed, sinceDeployed, thisPush });
}

/** A GET with the run's token, a time limit, and nothing of the answer printed. */
function githubGet(apiUrl: string, token: string): GetJson {
  return async (path) => {
    try {
      const response = await fetch(`${apiUrl}${path}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
        signal: AbortSignal.timeout(15_000),
      });
      const text = await response.text();
      let body: unknown = null;
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
      return { status: response.status, body };
    } catch {
      return { status: 0, body: null };
    }
  };
}

/** One line for the workflow log: GitHub's notice command, with its special characters escaped. */
export function noticeLine(notice: { title: string; message: string }): string {
  const escape = (text: string) => text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  const escapeProperty = (text: string) => escape(text).replace(/:/g, '%3A').replace(/,/g, '%2C');
  return `::notice title=${escapeProperty(notice.title)}::${escape(notice.message)}`;
}

async function main(): Promise<void> {
  const env = process.env;
  const get = githubGet(env.GITHUB_API_URL ?? 'https://api.github.com', env.GITHUB_TOKEN ?? '');
  if (process.argv[2] === 'guard') {
    const result = await guard(env, get);
    process.stdout.write(result.ok ? `${result.message}\n` : `::error::${result.message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}\n`);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  const decision = await decideRun(env, get);
  if (decision.notice) process.stdout.write(`${noticeLine(decision.notice)}\n`);
  const output = env.GITHUB_OUTPUT;
  if (!output) throw new Error('GITHUB_OUTPUT is not set');
  appendFileSync(output, `publish=${decision.publish}\n`);
  if (decision.error !== undefined) {
    process.stdout.write(`::error::${decision.error.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`publishDecision: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
