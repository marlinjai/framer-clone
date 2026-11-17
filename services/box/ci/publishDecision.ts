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
  deployed: Deployed;
  /** The changes since the deployed commit, when it is known. */
  sinceDeployed: Changes;
  /** The changes of this push alone, used for the database check when the deployed commit is not known. */
  thisPush: Changes;
}

export interface Decision {
  publish: boolean;
  notice?: { title: string; message: string };
}

const touches = (files: readonly string[], paths: readonly string[]) =>
  files.some((file) => paths.some((path) => (path.endsWith('/') ? file.startsWith(path) : file === path)));

const DATABASE_NOTICE = {
  title: 'box not published: deploy the application first',
  message:
    'The database the box reads changed (prisma/migrations or prisma/sql) since the commit running in box-production. Migrations reach production only with a deploy of the application, so the box is not deployed now: deploy the application, then run the box workflow by hand on main (deploy/README.md, the box).',
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
  // A manual run is the operator's word, given after the application's deploy: it always publishes.
  if (input.event === 'workflow_dispatch') return { publish: true };

  if (input.deployed.kind === 'commit' && input.sinceDeployed.kind === 'files') {
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

  // What runs in production is not known, or nothing ever ran: publish, unless this push alone already
  // shows a database change.
  if (input.thisPush.kind === 'files' && touches(input.thisPush.files, DATABASE_PATHS)) return { publish: false, notice: DATABASE_NOTICE };
  const why =
    input.deployed.kind === 'none'
      ? 'nothing has been deployed to box-production yet'
      : input.deployed.kind === 'unknown'
        ? `the commit running in box-production is not known (${input.deployed.reason})`
        : `the changes since it are not known (${input.sinceDeployed.kind === 'unknown' ? input.sinceDeployed.reason : ''})`;
  return { publish: true, notice: { title: 'box published', message: `The box is published because ${why}.` } };
}

/** A GET against the GitHub API: the status, and the parsed body when it is JSON. */
export type GetJson = (path: string) => Promise<{ status: number; body: unknown }>;

interface DeploymentRow {
  id?: unknown;
  sha?: unknown;
}

const COMMIT = /^[0-9a-f]{40}$/;

/**
 * The commit of the newest deployment to box-production whose latest status is success. GitHub lists
 * deployments newest first; a later success marks the earlier ones inactive, and a failed or cancelled
 * one never reaches success, so the first success found is what production runs.
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
    if (latest?.state === 'success') return { kind: 'commit', sha: row.sha };
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


/** Reads the run, asks GitHub, decides. Everything it reads comes in through `env` and `get`. */
export async function decideRun(env: Record<string, string | undefined>, get: GetJson): Promise<Decision> {
  const event = env.EVENT ?? '';
  const ref = env.REF ?? '';
  const enabled = env.ENABLED === 'true';
  const repository = env.GITHUB_REPOSITORY ?? '';
  const sha = env.SHA ?? '';
  const before = env.BEFORE ?? '';
  const unknown = (reason: string): Changes => ({ kind: 'unknown', reason });
  // Only a push to main with publishing on needs GitHub at all.
  if (event !== 'push' || ref !== 'refs/heads/main' || !enabled) {
    return decide({ event, ref, enabled, deployed: { kind: 'none' }, sinceDeployed: unknown('not asked'), thisPush: unknown('not asked') });
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !COMMIT.test(sha)) {
    throw new Error('GITHUB_REPOSITORY or SHA is not what a push to main gives');
  }
  const deployed = await lastDeployed(get, repository);
  const sinceDeployed = deployed.kind === 'commit' ? await changedFiles(get, repository, deployed.sha, sha) : unknown('no deployed commit');
  const thisPush = !COMMIT.test(before) || ZERO.test(before) ? unknown('the push has no previous commit') : await changedFiles(get, repository, before, sha);
  return decide({ event, ref, enabled, deployed, sinceDeployed, thisPush });
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
  const decision = await decideRun(env, githubGet(env.GITHUB_API_URL ?? 'https://api.github.com', env.GITHUB_TOKEN ?? ''));
  if (decision.notice) process.stdout.write(`${noticeLine(decision.notice)}\n`);
  const output = env.GITHUB_OUTPUT;
  if (!output) throw new Error('GITHUB_OUTPUT is not set');
  appendFileSync(output, `publish=${decision.publish}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`publishDecision: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
