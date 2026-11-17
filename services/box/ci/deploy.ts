// Deploys one image of the box, named by its digest, through Coolify, and waits until the box answers
// /health/db (decisions D53, D54 and D57 of docs/plans/2026-11-02-sandboxed-custom-code.md). Run by the
// publish and rollback jobs of .github/workflows/box.yml as `node services/box/ci/deploy.ts` (node strips
// the types); it needs nothing installed.
//
// 0. Reads the tag the application names now, to put it back if the deploy fails before it starts.
// 1. Points the Coolify application at the digest: the tag `sha256-<hex>`, which Coolify deploys as
//    `<image>@sha256:<hex>`, so what runs is the image named, whatever any tag holds later.
// 2. Calls the application's deploy webhook and follows the deployment until Coolify says it finished.
// 3. Waits until the box answers /health/db on its public host.
// Every way it can go wrong ends with status 1 and one error line. Nothing Coolify answers is printed but
// the status names below, and the Coolify address and the application's id (both part of the webhook
// secret) are masked in the log before anything is asked.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Whether this file is the program node was started with, by real path, so a symlinked path still runs it. */
function isEntry(argv1: string | undefined, moduleUrl: string): boolean {
  if (argv1 === undefined) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

export interface Answer {
  status: number;
  body: unknown;
}

/** One HTTP call: the status (0 when there was no answer) and the parsed body when it is JSON. */
export type Call = (url: string, init: { method: string; headers: Record<string, string>; body?: string; timeoutMs?: number }) => Promise<Answer>;

export interface DeployDeps {
  call: Call;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  out: (line: string) => void;
}

export const DIGEST = /^sha256:[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9_-]+$/;
export const DEPLOY_LIMIT_MS = 900_000;
export const POLL_MS = 10_000;
export const HEALTH_TRIES = 24;
export const HEALTH_PAUSE_MS = 5_000;
/** Each health call's own limit, so the tries fit in about four minutes whatever the box does. */
export const HEALTH_CALL_MS = 5_000;
/** A deployment Coolify did not queue is never found; this many answers of 404 in a row end the follow. */
export const NOT_FOUND_LIMIT = 3;
const TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

/** A Coolify image tag as a person reads it: the digest for the sha256- form, the tag otherwise. */
export function describeTag(tag: string | null): string {
  if (tag === null) return 'no tag';
  if (/^sha256-[0-9a-f]{64}$/.test(tag)) return `sha256:${tag.slice('sha256-'.length)}`;
  return TAG.test(tag) ? `the tag ${tag}` : 'an unreadable tag';
}

const TOKEN_HINT = ' The token needs the read, write and deploy permissions, limited to the box application.';

export async function deploy(env: Record<string, string | undefined>, deps: DeployDeps): Promise<number> {
  const fail = (message: string) => {
    deps.out(`::error::${message}`);
    return 1;
  };
  const token = env.COOLIFY_TOKEN ?? '';
  const digest = env.IMAGE_DIGEST ?? '';
  const healthUrl = env.HEALTH_URL ?? '';
  let webhook: URL;
  try {
    webhook = new URL(env.COOLIFY_BOX_WEBHOOK ?? '');
  } catch {
    return fail('COOLIFY_BOX_WEBHOOK is not an address.');
  }
  const app = webhook.searchParams.get('uuid') ?? '';
  // The mask first: from here on the address and the id never reach the log in the clear.
  deps.out(`::add-mask::${webhook.origin}`);
  deps.out(`::add-mask::${webhook.host}`);
  deps.out(`::add-mask::${webhook.hostname}`);
  if (app !== '') deps.out(`::add-mask::${app}`);
  // The webhook carries the token: never over plain http.
  if (webhook.protocol !== 'https:') return fail('COOLIFY_BOX_WEBHOOK is not an https address.');
  if (!ID.test(app)) return fail('COOLIFY_BOX_WEBHOOK names no application (it has no uuid= parameter).');
  if (token === '') return fail('COOLIFY_TOKEN is empty.');
  if (!DIGEST.test(digest)) return fail('IMAGE_DIGEST is not an image digest (sha256: and 64 hex digits).');
  if (!/^https:\/\/[^/]+\/health\/db$/.test(healthUrl)) return fail('HEALTH_URL is not the https address of /health/db.');
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  const tag = `sha256-${digest.slice('sha256:'.length)}`;

  const appUrl = `${webhook.origin}/api/v1/applications/${app}`;
  const hint = (status: number) => (status === 401 || status === 403 ? TOKEN_HINT : '');

  const current = await deps.call(appUrl, { method: 'GET', headers });
  if (current.status !== 200) return fail(`Coolify did not show the application (HTTP ${current.status}); nothing was changed.${hint(current.status)}`);
  const previousTag = (current.body as { docker_registry_image_tag?: unknown } | null)?.docker_registry_image_tag;
  const previous = typeof previousTag === 'string' && TAG.test(previousTag) ? previousTag : null;
  const was = describeTag(typeof previousTag === 'string' ? previousTag : null);

  const setTag = (value: string) =>
    deps.call(appUrl, { method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ docker_registry_image_tag: value }) });
  const set = await setTag(tag);
  if (set.status < 200 || set.status >= 300) {
    return fail(`Coolify did not take the image ${digest} (HTTP ${set.status}); it still names ${was}.${hint(set.status)}`);
  }
  deps.out(`The Coolify application now names the image ${digest} (it named ${was}).`);

  // Before a deployment has started, a failure puts the earlier tag back, so a restart or a redeploy from
  // Coolify's interface does not start an image this run never proved.
  const failBeforeStart = async (message: string) => {
    if (previous === null) return fail(`${message} Coolify names ${digest}; it named ${was} before, which cannot be put back. Set the tag in Coolify.`);
    const back = await setTag(previous);
    if (back.status >= 200 && back.status < 300) return fail(`${message} Coolify names ${was} again, not ${digest}.`);
    return fail(`${message} Putting back ${was} failed (HTTP ${back.status}): Coolify still names ${digest}. Set the tag in Coolify.`);
  };

  // cancel_previous=queued cancels older webhook or API deployments still waiting for another commit or tag.
  // It does not help against one already queued for this application: Coolify 4.7.5 checks for that first
  // and skips ours, which the three 404s below then catch.
  const trigger = new URL(webhook.href);
  trigger.searchParams.set('cancel_previous', 'queued');
  const started = await deps.call(trigger.href, { method: 'POST', headers });
  if (started.status < 200 || started.status >= 300) {
    return failBeforeStart(`The Coolify deploy webhook answered HTTP ${started.status}.${hint(started.status)}`);
  }
  const first = (started.body as { deployments?: { deployment_uuid?: unknown; message?: unknown }[] } | null)?.deployments?.[0];
  const deployment = first?.deployment_uuid;
  if (typeof deployment !== 'string' || !ID.test(deployment)) {
    // A token without the deploy permission gets 200 with "Unauthorized to deploy" and no id; Coolify's words
    // are not printed, only the hint.
    const refused = typeof first?.message === 'string' && /unauthori[sz]ed/i.test(first.message);
    return failBeforeStart(`Coolify named no deployment, so the deploy cannot be followed.${refused ? TOKEN_HINT : ''}`);
  }

  const begun = deps.now();
  let notFound = 0;
  for (;;) {
    const probe = await deps.call(`${webhook.origin}/api/v1/deployments/${deployment}`, { method: 'GET', headers });
    if (probe.status === 401 || probe.status === 403) {
      return fail(`The Coolify token cannot read deployments (HTTP ${probe.status}), so the deploy cannot be followed.${TOKEN_HINT}`);
    }
    notFound = probe.status === 404 ? notFound + 1 : 0;
    if (notFound >= NOT_FOUND_LIMIT) {
      // Coolify answers a deploy it skips (one is already queued or running for the box) with a deployment
      // id it never queues.
      return failBeforeStart('Coolify did not queue a deployment (one may already be running for the box).');
    }
    const elapsed = Math.round((deps.now() - begun) / 1000);
    const status = probe.status === 200 ? (probe.body as { status?: unknown } | null)?.status : undefined;
    // Coolify's statuses: queued, in_progress, finished, failed, cancelled-by-user (and skipped in later versions).
    if (status === 'finished') {
      deps.out(`The Coolify deployment finished (${elapsed}s).`);
      break;
    }
    if (status === 'failed' || status === 'cancelled-by-user' || status === 'skipped') {
      return fail(`The Coolify deployment ended with status ${status}. Its log is in Coolify.`);
    }
    if (status === 'queued' || status === 'in_progress') deps.out(`Deployment status: ${status} (${elapsed}s)`);
    else if (probe.status !== 200) deps.out(`Deployment status: no answer (HTTP ${probe.status}, ${elapsed}s)`);
    else deps.out(`Deployment status: not one Coolify is known to give (${elapsed}s)`);
    if (deps.now() - begun >= DEPLOY_LIMIT_MS) return fail(`The Coolify deployment did not end within ${DEPLOY_LIMIT_MS / 1000} seconds.`);
    await deps.sleep(POLL_MS);
  }

  // Readiness, not liveness: /health/db calls the box's one database function as box_reader, so a box that
  // cannot read (no role, no function, no network to the database) fails the deploy loudly.
  for (let attempt = 1; attempt <= HEALTH_TRIES; attempt += 1) {
    const health = await deps.call(healthUrl, { method: 'GET', headers: {}, timeoutMs: HEALTH_CALL_MS });
    if (health.status === 200) {
      deps.out(`The box answers /health/db (attempt ${attempt}).`);
      return 0;
    }
    if (attempt < HEALTH_TRIES) await deps.sleep(HEALTH_PAUSE_MS);
  }
  return fail(`The box did not answer ${healthUrl} in ${HEALTH_TRIES} tries over about ${Math.round((HEALTH_TRIES * (HEALTH_CALL_MS + HEALTH_PAUSE_MS)) / 60_000)} minutes. Coolify now runs ${digest}.`);
}

/** A call with a time limit; what it answers is parsed, never printed. */
const realCall: Call = async (url, init) => {
  try {
    const response = await fetch(url, { method: init.method, headers: init.headers, body: init.body, signal: AbortSignal.timeout(init.timeoutMs ?? 30_000) });
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

if (isEntry(process.argv[1], import.meta.url)) {
  deploy(process.env, {
    call: realCall,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    out: (line) => process.stdout.write(`${line}\n`),
  }).then(
    (status) => process.exit(status),
    () => {
      process.stdout.write('::error::The deploy failed.\n');
      process.exit(1);
    },
  );
}
