import { appendFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Whether this file is the program node was started with, by real path, so a symlinked path still runs it. */
export function isEntry(argv1: string | undefined, moduleUrl: string): boolean {
  if (argv1 === undefined) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

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

/**
 * A comparison of the commit running in production with this one, as GitHub's compare answers it: its
 * status (identical, ahead, behind, diverged) says whether that commit is an ancestor, and the files are
 * whole only below GitHub's 300.
 */
export type Comparison =
  | { kind: 'compared'; status: string; files: string[]; complete: boolean }
  | { kind: 'unknown'; reason: string };

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
  /** The deployed commit compared with this one, when it is known. */
  sinceDeployed: Comparison;
  /** This push alone, used for the database check when nothing was ever deployed. */
  thisPush: Comparison;
}

export interface Decision {
  publish: boolean;
  notice?: { title: string; message: string };
  /** Set when the run cannot decide: the step fails, and the operator re-runs it or runs the workflow by hand. */
  error?: string;
}

const touches = (files: readonly string[], paths: readonly string[]) =>
  files.some((file) => paths.some((path) => (path.endsWith('/') ? file.startsWith(path) : file === path)));

const ANCESTOR = new Set(['identical', 'ahead']);

const DATABASE_NOTICE = {
  title: 'box not published: deploy the application first',
  message:
    'The database the box reads changed (prisma/migrations or prisma/sql) since the commit running in box-production. Migrations reach production only with a deploy of the application, so the box is not deployed now: deploy the application, then run the box workflow by hand on main (deploy/README.md, the box).',
};

const CUT_NOTICE = {
  title: 'box not published: too many changes to check the database',
  message:
    'More files changed since the commit running in box-production than GitHub lists (300), so whether the database the box reads changed cannot be checked. If prisma/migrations or prisma/sql changed, deploy the application first; then run the box workflow by hand on main (deploy/README.md, the box).',
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

const BY_HAND =
  'Run the box workflow by hand on main with override_guard once you have checked what runs in box-production: without it, the publish job\'s guard asks the same question and refuses again (deploy/README.md, the box).';

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
  const since = input.sinceDeployed;
  // Pinned after a rollback: only a manual run that says so publishes, whatever changed.
  if (input.pinned) {
    if (manual && input.publishWhilePinned) return { publish: true };
    // The comparison is made while pinned too (on a push), so a database change is not hidden by the pin.
    const database = input.deployed.kind === 'commit' && since.kind === 'compared' && (!since.complete || touches(since.files, DATABASE_PATHS));
    return { publish: false, notice: database ? PINNED_DATABASE_NOTICE : PINNED_NOTICE };
  }
  // A manual run is the operator's word, given after the application's deploy: it always publishes.
  if (manual) return { publish: true };

  if (input.deployed.kind === 'none') {
    // Nothing ever reached success: publish, unless this push already shows a database change.
    const push = input.thisPush;
    if (push.kind === 'compared' && !push.complete) return { publish: false, notice: CUT_NOTICE };
    if (push.kind === 'compared' && touches(push.files, DATABASE_PATHS)) return { publish: false, notice: DATABASE_NOTICE };
    return { publish: true, notice: { title: 'box published', message: 'The box is published because no deployment to box-production has succeeded yet.' } };
  }
  // Not knowing what runs, or whether it is an ancestor, is not a reason to publish: a database change could
  // lie in between. The step fails; a re-run or a manual run is the way out.
  if (input.deployed.kind === 'unknown') {
    return { publish: false, error: `The commit running in box-production is not known (${input.deployed.reason}). Re-run this run, or: ${BY_HAND}` };
  }
  const short = input.deployed.sha.slice(0, 12);
  if (since.kind === 'unknown') return { publish: false, error: `${short}, the commit running in box-production, could not be compared with this one (${since.reason}). Re-run this run, or: ${BY_HAND}` };
  if (!ANCESTOR.has(since.status)) {
    return { publish: false, error: `${short}, the commit running in box-production, is ${since.status} of this one, not an ancestor. ${BY_HAND}` };
  }
  // A cut list cannot show the database hold: hold, and say how to go on.
  if (!since.complete) return { publish: false, notice: CUT_NOTICE };
  if (touches(since.files, DATABASE_PATHS)) return { publish: false, notice: DATABASE_NOTICE };
  if (touches(since.files, BOX_PATHS)) return { publish: true };
  return {
    publish: false,
    notice: {
      title: 'box not published',
      message: `Nothing of the box changed since ${short}, the commit running in box-production, so the image is tested and not published.`,
    },
  };
}

/** A GET against the GitHub API: the status, and the parsed body when it is JSON. */
export type GetJson = (path: string) => Promise<{ status: number; body: unknown }>;

/** The workflow file, and the jobs of it that deploy to box-production. */
export const WORKFLOW_PATH = '.github/workflows/box.yml';
export const DEPLOYING_JOBS = ['publish and deploy', 'roll back'];

const COMMIT = /^[0-9a-f]{40}$/;

/**
 * Whether a successful deployment was made by a publish or rollback job of box.yml on main. A job with
 * `environment:` creates its deployment itself, and every status of it names the job in its log address
 * (`<server>/<repository>/actions/runs/<run>/job/<job>`); the job and its run are asked for the rest. A
 * deployment made through the API (its log address is the commit's checks page) is not trusted.
 */
async function madeByThisWorkflow(get: GetJson, repository: string, serverUrl: string, sha: string, logUrl: unknown): Promise<boolean | 'unanswered'> {
  if (typeof logUrl !== 'string') return false;
  let url: URL;
  try {
    url = new URL(logUrl);
  } catch {
    return false;
  }
  const match = new RegExp(`^/${repository.replace(/[.]/g, '\\.')}/actions/runs/(\\d+)/job/(\\d+)$`).exec(url.pathname);
  if (url.origin !== serverUrl || !match) return false;
  const [, runId, jobId] = match;
  const job = await get(`/repos/${repository}/actions/jobs/${jobId}`);
  if (job.status !== 200) return 'unanswered';
  const j = job.body as { name?: unknown; conclusion?: unknown; head_branch?: unknown; head_sha?: unknown; run_id?: unknown } | null;
  if (typeof j?.name !== 'string' || !DEPLOYING_JOBS.includes(j.name) || j.conclusion !== 'success' || j.head_branch !== 'main' || j.head_sha !== sha || String(j.run_id) !== runId) return false;
  const run = await get(`/repos/${repository}/actions/runs/${runId}`);
  if (run.status !== 200) return 'unanswered';
  const r = run.body as { path?: unknown; head_branch?: unknown } | null;
  return r?.path === WORKFLOW_PATH && r.head_branch === 'main';
}

/** What the guard prints before its message when this run may publish; the workflow step looks for it. */
export const VERDICT = 'May publish: ';

/**
 * Deployments are read a page of 100 (GitHub's most) at a time, at most two pages: each row costs a call for
 * its statuses, and the token's calls are counted per hour. Past that, what runs is not known.
 */
export const DEPLOYMENT_PAGE = 100;
export const DEPLOYMENT_PAGES = 2;

/**
 * The commit of the newest deployment to box-production whose latest status is success. GitHub lists
 * deployments newest first: the publish job's own deployment, still in progress while it runs, and failed
 * ones are passed over, page after page. Only the end of the list without a success means none (the first
 * deploy); running past the page limit without one means not known. A success this workflow's deploying
 * jobs did not make is not trusted.
 */
export async function lastDeployed(get: GetJson, repository: string, serverUrl = 'https://github.com'): Promise<Deployed> {
  for (let page = 1; page <= DEPLOYMENT_PAGES; page += 1) {
    const list = await get(`/repos/${repository}/deployments?environment=${ENVIRONMENT}&per_page=${DEPLOYMENT_PAGE}&page=${page}`);
    if (list.status !== 200 || !Array.isArray(list.body)) return { kind: 'unknown', reason: `the deployments answered HTTP ${list.status}` };
    const found = await firstSuccess(get, repository, serverUrl, list.body as { id?: unknown; sha?: unknown }[]);
    if (found !== undefined) return found;
    // A page shorter than asked for is the end of the list.
    if (list.body.length < DEPLOYMENT_PAGE) return { kind: 'none' };
  }
  return { kind: 'unknown', reason: `none of the newest ${DEPLOYMENT_PAGE * DEPLOYMENT_PAGES} deployments succeeded` };
}

/** The verdict of the first successful deployment among `rows`, or undefined when none of them succeeded. */
async function firstSuccess(get: GetJson, repository: string, serverUrl: string, rows: { id?: unknown; sha?: unknown }[]): Promise<Deployed | undefined> {
  for (const row of rows) {
    if (typeof row.id !== 'number' || typeof row.sha !== 'string' || !COMMIT.test(row.sha)) continue;
    const statuses = await get(`/repos/${repository}/deployments/${row.id}/statuses?per_page=1`);
    if (statuses.status !== 200 || !Array.isArray(statuses.body)) return { kind: 'unknown', reason: `a deployment's statuses answered HTTP ${statuses.status}` };
    const latest = statuses.body[0] as { state?: unknown; log_url?: unknown } | undefined;
    if (latest?.state !== 'success') continue;
    const made = await madeByThisWorkflow(get, repository, serverUrl, row.sha, latest.log_url);
    const short = row.sha.slice(0, 12);
    if (made === 'unanswered') return { kind: 'unknown', reason: `the job of the deployment of ${short} could not be read` };
    if (!made) return { kind: 'unknown', reason: `the newest successful deployment, of ${short}, was not made by a publish or rollback job of box.yml on main` };
    return { kind: 'commit', sha: row.sha };
  }
  return undefined;
}

/** GitHub's compare lists at most 300 files; a longer list is cut. */
const COMPARE_FILE_LIMIT = 300;

/** The deployed commit compared with this one: whether it is an ancestor, and the files changed. */
export async function compare(get: GetJson, repository: string, base: string, head: string): Promise<Comparison> {
  const answer = await get(`/repos/${repository}/compare/${base}...${head}?per_page=1`);
  if (answer.status !== 200) return { kind: 'unknown', reason: `the comparison answered HTTP ${answer.status}` };
  const body = answer.body as { status?: unknown; files?: unknown } | null;
  if (typeof body?.status !== 'string') return { kind: 'unknown', reason: 'the comparison named no status' };
  const list = Array.isArray(body.files) ? (body.files as { filename?: unknown; previous_filename?: unknown }[]) : [];
  const files: string[] = [];
  for (const file of list) {
    if (typeof file.filename === 'string') files.push(file.filename);
    if (typeof file.previous_filename === 'string') files.push(file.previous_filename);
  }
  return { kind: 'compared', status: body.status, files, complete: Array.isArray(body.files) && list.length < COMPARE_FILE_LIMIT };
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
 * keeps the box job's decision and artifact from an earlier attempt. It reads the pin again (unless a
 * manual run with publish_while_pinned) and checks ancestry only: the image is pushed when the commit
 * running in box-production is this commit or an ancestor of it, so an older run cannot deploy over a
 * newer one. A manual run with override_guard passes after the operator has checked what runs.
 */
export async function guard(env: Record<string, string | undefined>, get: GetJson): Promise<Guard> {
  const repository = env.GITHUB_REPOSITORY ?? '';
  const sha = env.SHA ?? '';
  if (env.REF !== 'refs/heads/main') return { ok: false, message: 'Only main publishes.' };
  const manual = env.EVENT === 'workflow_dispatch';
  if (env.PINNED === 'true' && !(manual && env.PUBLISH_WHILE_PINNED === 'true')) {
    return {
      ok: false,
      message: 'BOX_DEPLOY_PINNED is true now: a rollback holds, so this run publishes nothing (a re-run keeps an earlier decision, which is asked again here). Lift the pin, or run the box workflow by hand with publish_while_pinned.',
    };
  }
  if (manual && env.OVERRIDE_GUARD === 'true') {
    // Only the first attempt: a re-run, days later, must not carry the override over a newer production.
    if (env.GITHUB_RUN_ATTEMPT !== '1') return { ok: false, message: 'override_guard holds for the first attempt of a run only, not a re-run. Start a new manual run on main once you have checked what runs in box-production.' };
    return { ok: true, message: 'override_guard: the operator has checked what runs in box-production.' };
  }
  checkRun(repository, sha);
  const way = 'If this is meant, run the box workflow by hand on main with override_guard once you have checked what runs in box-production (deploy/README.md, the box).';
  const deployed = await lastDeployed(get, repository, env.GITHUB_SERVER_URL ?? 'https://github.com');
  if (deployed.kind === 'none') return { ok: true, message: 'No deployment to box-production has succeeded yet.' };
  if (deployed.kind === 'unknown') return { ok: false, message: `The commit running in box-production is not known (${deployed.reason}); nothing is pushed. ${way}` };
  if (deployed.sha === sha) return { ok: true, message: 'This commit is the one running in box-production.' };
  const since = await compare(get, repository, deployed.sha, sha);
  const short = deployed.sha.slice(0, 12);
  if (since.kind === 'unknown') return { ok: false, message: `${short}, the commit running in box-production, could not be compared with this one (${since.reason}); nothing is pushed. ${way}` };
  if (ANCESTOR.has(since.status)) return { ok: true, message: `${short}, the commit running in box-production, is an ancestor of this one.` };
  return { ok: false, message: `${short}, the commit running in box-production, is ${since.status} of this one, so this run would deploy an older box over a newer one; nothing is pushed. To go back on purpose, roll back instead. ${way}` };
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
  const unknown = (reason: string): Comparison => ({ kind: 'unknown', reason });
  const settings = { event, ref, enabled, pinned, publishWhilePinned, rollbackDigest };
  // Only a push to main with publishing on needs GitHub at all.
  if (event !== 'push' || ref !== 'refs/heads/main' || !enabled) {
    return decide({ ...settings, deployed: { kind: 'none' }, sinceDeployed: unknown('not asked'), thisPush: unknown('not asked') });
  }
  checkRun(repository, sha);
  const deployed = await lastDeployed(get, repository, env.GITHUB_SERVER_URL ?? 'https://github.com');
  const sinceDeployed = deployed.kind === 'commit' ? await compare(get, repository, deployed.sha, sha) : unknown('no deployed commit');
  const thisPush = deployed.kind !== 'none' ? unknown('not needed') : !COMMIT.test(before) || ZERO.test(before) ? unknown('the push has no previous commit') : await compare(get, repository, before, sha);
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
    // The workflow step fails unless a line starts with VERDICT, so a script that checked nothing cannot pass.
    process.stdout.write(result.ok ? `${VERDICT}${result.message}\n` : `::error::${result.message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}\n`);
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

if (isEntry(process.argv[1], import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`publishDecision: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
