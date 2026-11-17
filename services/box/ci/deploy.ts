// Deploys one image of the box, named by its digest, through Coolify, and waits until the box answers
// /health/db (decisions D53, D54 and D57 of docs/plans/2026-11-02-sandboxed-custom-code.md). Run by the
// publish and rollback jobs of .github/workflows/box.yml as `node services/box/ci/deploy.ts` (node strips
// the types); it needs nothing installed.
//
// 1. Points the Coolify application at the digest: the tag `sha256-<hex>`, which Coolify deploys as
//    `<image>@sha256:<hex>`, so what runs is the image named, whatever any tag holds later.
// 2. Calls the application's deploy webhook and follows the deployment until Coolify says it finished.
// 3. Waits until the box answers /health/db on its public host.
// Every way it can go wrong ends with status 1 and one error line. Nothing Coolify answers is printed but
// the status names below, and the Coolify address and the application's id (both part of the webhook
// secret) are masked in the log before anything is asked.

import { pathToFileURL } from 'node:url';

export interface Answer {
  status: number;
  body: unknown;
}

/** One HTTP call: the status (0 when there was no answer) and the parsed body when it is JSON. */
export type Call = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<Answer>;

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
  if (webhook.protocol !== 'https:' && webhook.protocol !== 'http:') return fail('COOLIFY_BOX_WEBHOOK is not an http address.');
  if (!ID.test(app)) return fail('COOLIFY_BOX_WEBHOOK names no application (it has no uuid= parameter).');
  if (token === '') return fail('COOLIFY_TOKEN is empty.');
  if (!DIGEST.test(digest)) return fail('IMAGE_DIGEST is not an image digest (sha256: and 64 hex digits).');
  if (!/^https:\/\/[^/]+\/health\/db$/.test(healthUrl)) return fail('HEALTH_URL is not the https address of /health/db.');
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  const tag = `sha256-${digest.slice('sha256:'.length)}`;

  const set = await deps.call(`${webhook.origin}/api/v1/applications/${app}`, {
    method: 'PATCH',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ docker_registry_image_tag: tag }),
  });
  if (set.status < 200 || set.status >= 300) {
    return fail(`Coolify did not take the image ${digest} (HTTP ${set.status}).${set.status === 401 || set.status === 403 ? TOKEN_HINT : ''}`);
  }
  deps.out(`The Coolify application now names the image ${digest}.`);

  const started = await deps.call(webhook.href, { method: 'POST', headers });
  if (started.status < 200 || started.status >= 300) {
    return fail(`The Coolify deploy webhook answered HTTP ${started.status}.${started.status === 401 || started.status === 403 ? TOKEN_HINT : ''}`);
  }
  const deployment = (started.body as { deployments?: { deployment_uuid?: unknown }[] } | null)?.deployments?.[0]?.deployment_uuid;
  if (typeof deployment !== 'string' || !ID.test(deployment)) return fail('Coolify named no deployment, so the deploy cannot be followed. Its log is in Coolify.');

  const begun = deps.now();
  for (;;) {
    const probe = await deps.call(`${webhook.origin}/api/v1/deployments/${deployment}`, { method: 'GET', headers });
    if (probe.status === 401 || probe.status === 403) {
      return fail(`The Coolify token cannot read deployments (HTTP ${probe.status}), so the deploy cannot be followed.${TOKEN_HINT}`);
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
    const health = await deps.call(healthUrl, { method: 'GET', headers: {} });
    if (health.status === 200) {
      deps.out(`The box answers /health/db (attempt ${attempt}).`);
      return 0;
    }
    if (attempt < HEALTH_TRIES) await deps.sleep(HEALTH_PAUSE_MS);
  }
  return fail(`The box did not answer ${healthUrl} within ${(HEALTH_TRIES * HEALTH_PAUSE_MS) / 1000} seconds.`);
}

/** A call with a time limit; what it answers is parsed, never printed. */
const realCall: Call = async (url, init) => {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
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

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
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
