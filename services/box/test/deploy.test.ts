import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Answer, type Call, deploy, DEPLOY_LIMIT_MS, HEALTH_TRIES } from '../ci/deploy';

const COOLIFY = 'https://coolify.example.test:8443';
const APP = 'app0123456789';
const HEALTH = 'https://run.example.test/health/db';
const digest = () => `sha256:${randomBytes(32).toString('hex')}`;
const PREVIOUS = digest();
const PREVIOUS_TAG = `sha256-${PREVIOUS.slice(7)}`;
const WEBHOOK_CALL = `${COOLIFY}/api/v1/deploy?uuid=${APP}&force=false&cancel_previous=queued`;

interface Script {
  /** The application as Coolify shows it before the change. */
  app?: Answer;
  patch?: Answer;
  /** The answer to putting the earlier tag back. */
  restore?: Answer;
  webhook?: Answer;
  /** The answers to the deployment's status, in order; the last one repeats. */
  statuses?: readonly Answer[];
  /** The answers of /health/db, in order; the last one repeats. */
  health?: readonly Answer[];
}

function run(script: Script, env: Record<string, string | undefined> = {}) {
  const token = `test-token-${randomBytes(12).toString('hex')}`;
  const image = digest();
  const calls: { url: string; method: string; headers: Record<string, string>; body?: string; timeoutMs?: number }[] = [];
  const lines: string[] = [];
  let clock = 0;
  let statusIndex = 0;
  let healthIndex = 0;
  const pick = (list: readonly Answer[] | undefined, index: number, fallback: Answer) => (list ? (list[Math.min(index, list.length - 1)] ?? fallback) : fallback);
  let patches = 0;
  const call: Call = async (url, init) => {
    calls.push({ url, ...init });
    if (init.method === 'GET' && url === `${COOLIFY}/api/v1/applications/${APP}`) return script.app ?? { status: 200, body: { uuid: APP, docker_registry_image_tag: PREVIOUS_TAG } };
    if (init.method === 'PATCH') return (patches++ === 0 ? script.patch : script.restore) ?? { status: 200, body: { uuid: APP } };
    if (init.method === 'POST') return script.webhook ?? { status: 200, body: { deployments: [{ deployment_uuid: 'dep-1', resource_uuid: APP }] } };
    if (url === HEALTH) return pick(script.health, healthIndex++, { status: 200, body: null });
    return pick(script.statuses, statusIndex++, { status: 200, body: { status: 'finished' } });
  };
  const done = deploy(
    { COOLIFY_BOX_WEBHOOK: `${COOLIFY}/api/v1/deploy?uuid=${APP}&force=false`, COOLIFY_TOKEN: token, IMAGE_DIGEST: image, HEALTH_URL: HEALTH, ...env },
    { call, sleep: async (ms) => void (clock += ms), now: () => clock, out: (line) => lines.push(line) },
  );
  return { done, calls, lines, token, image };
}

/** Everything written after the masks: what the log shows. */
const shown = (lines: string[]) => lines.filter((line) => !line.startsWith('::add-mask::')).join('\n');

describe('the deploy through Coolify', () => {
  it('points the application at the digest, deploys, follows the deployment and waits for /health/db', async () => {
    const { done, calls, lines, token, image } = run({
      statuses: [{ status: 200, body: { status: 'queued' } }, { status: 200, body: { status: 'in_progress' } }, { status: 200, body: { status: 'finished' } }],
      health: [{ status: 503, body: null }, { status: 200, body: null }],
    });
    expect(await done).toBe(0);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${COOLIFY}/api/v1/applications/${APP}`,
      `PATCH ${COOLIFY}/api/v1/applications/${APP}`,
      `POST ${WEBHOOK_CALL}`,
      `GET ${COOLIFY}/api/v1/deployments/dep-1`,
      `GET ${COOLIFY}/api/v1/deployments/dep-1`,
      `GET ${COOLIFY}/api/v1/deployments/dep-1`,
      `GET ${HEALTH}`,
      `GET ${HEALTH}`,
    ]);
    // The digest in Coolify's form, which it deploys as <image>@sha256:<hex>.
    expect(JSON.parse(calls[1]?.body ?? '{}')).toEqual({ docker_registry_image_tag: `sha256-${image.slice(7)}` });
    for (const c of calls.slice(0, 6)) expect(c.headers.Authorization).toBe(`Bearer ${token}`);
    // The health check is asked without the token, with its own short limit.
    expect(calls[6]?.headers.Authorization).toBeUndefined();
    expect(calls[6]?.timeoutMs).toBe(5_000);
    // Both images named: the new one and the one before.
    expect(shown(lines)).toContain(`now names the image ${image} (it named ${PREVIOUS})`);
    // The address and the application's id are masked before anything else is written, and the token never shows.
    expect(lines.slice(0, 4)).toEqual([`::add-mask::${COOLIFY}`, '::add-mask::coolify.example.test:8443', '::add-mask::coolify.example.test', `::add-mask::${APP}`]);
    expect(lines.join('\n')).not.toContain(token);
    expect(shown(lines)).not.toContain('coolify.example.test');
    expect(shown(lines)).toContain('The box answers /health/db (attempt 2).');
  });

  it.each([
    ['failed'],
    ['cancelled-by-user'],
    ['skipped'],
  ])('fails when the deployment ends with status %s, and never asks /health/db', async (status) => {
    const { done, calls, lines } = run({ statuses: [{ status: 200, body: { status } }] });
    expect(await done).toBe(1);
    expect(shown(lines)).toContain(`::error::The Coolify deployment ended with status ${status}.`);
    expect(calls.some((c) => c.url === HEALTH)).toBe(false);
  });

  it.each([
    ['the application cannot be read', { app: { status: 403, body: null } }, 'Coolify did not show the application (HTTP 403); nothing was changed.', true],
    ['the tag is refused for the token', { patch: { status: 403, body: null } }, 'Coolify did not take the image', true],
    ['the tag is refused', { patch: { status: 422, body: { message: 'x' } } }, 'Coolify did not take the image', false],
    ['the token cannot read deployments', { statuses: [{ status: 401, body: null }] }, 'cannot read deployments (HTTP 401)', true],
  ] as const)('fails when %s, putting nothing back that was not changed', async (_name, script, message, hint) => {
    const { done, lines, calls } = run(script);
    expect(await done).toBe(1);
    const log = shown(lines);
    expect(log).toContain(message);
    expect(log.includes('read, write and deploy permissions, limited to the box application')).toBe(hint);
    expect(calls.filter((c) => c.method === 'PATCH').length).toBeLessThanOrEqual(1);
    expect(calls.some((c) => c.url === HEALTH)).toBe(false);
  });

  it('names both images when the tag is refused', async () => {
    const { done, lines, image } = run({ patch: { status: 422, body: null } });
    expect(await done).toBe(1);
    expect(shown(lines)).toContain(`Coolify did not take the image ${image} (HTTP 422); it still names ${PREVIOUS}.`);
  });

  it.each([
    ['the webhook is refused', { webhook: { status: 401, body: null } }, 'The Coolify deploy webhook answered HTTP 401.', true],
    ['the webhook does not answer', { webhook: { status: 0, body: null } }, 'The Coolify deploy webhook answered HTTP 0.', false],
    ['no deployment is named', { webhook: { status: 200, body: { deployments: [] } } }, 'Coolify named no deployment', false],
    ['a malformed deployment is named', { webhook: { status: 200, body: { deployments: [{ deployment_uuid: '../x' }] } } }, 'Coolify named no deployment', false],
    // Coolify 4.7.5 answers a token without the deploy permission with 200, this message and no id.
    ['the token may not deploy', { webhook: { status: 200, body: { deployments: [{ message: 'Unauthorized to deploy this application.' }] } } }, 'Coolify named no deployment', true],
    ['Coolify did not queue the deployment', { statuses: [{ status: 404, body: null }] }, 'Coolify did not queue a deployment (one may already be running for the box).', false],
  ] as const)('puts the earlier image back when %s before a deployment started', async (_name, script, message, hint) => {
    const { done, lines, calls, image } = run(script);
    expect(await done).toBe(1);
    expect(shown(lines).includes('read, write and deploy permissions, limited to the box application')).toBe(hint);
    const patches = calls.filter((c) => c.method === 'PATCH');
    expect(patches.map((c) => JSON.parse(c.body ?? '{}').docker_registry_image_tag)).toEqual([`sha256-${image.slice(7)}`, PREVIOUS_TAG]);
    expect(shown(lines)).toContain(message);
    expect(shown(lines)).toContain(`Coolify names ${PREVIOUS} again, not ${image}.`);
    expect(calls.some((c) => c.url === HEALTH)).toBe(false);
  });

  it('stops after three answers of 404 in a row, not after 15 minutes, and keeps following after a single one', async () => {
    const notQueued = run({ statuses: [{ status: 404, body: null }] });
    expect(await notQueued.done).toBe(1);
    expect(notQueued.calls.filter((c) => c.url.includes('/deployments/'))).toHaveLength(3);
    const blip = run({ statuses: [{ status: 404, body: null }, { status: 404, body: null }, { status: 200, body: { status: 'in_progress' } }, { status: 404, body: null }, { status: 200, body: { status: 'finished' } }] });
    expect(await blip.done).toBe(0);
  });

  it('says so when the earlier image cannot be put back', async () => {
    const failed = run({ webhook: { status: 500, body: null }, restore: { status: 500, body: null } });
    expect(await failed.done).toBe(1);
    expect(shown(failed.lines)).toContain(`Putting back ${PREVIOUS} failed (HTTP 500): Coolify still names ${failed.image}. Set the tag in Coolify.`);
    const none = run({ webhook: { status: 500, body: null }, app: { status: 200, body: { docker_registry_image_tag: null } } });
    expect(await none.done).toBe(1);
    expect(none.calls.filter((c) => c.method === 'PATCH')).toHaveLength(1);
    expect(shown(none.lines)).toContain('it named no tag before, which cannot be put back');
  });

  it('keeps following a deployment Coolify does not answer for, prints no status it does not know, and gives up after 15 minutes', async () => {
    const { done, lines } = run({ statuses: [{ status: 502, body: null }, { status: 200, body: { status: '<script>' } }] });
    expect(await done).toBe(1);
    const log = shown(lines);
    expect(log).toContain('Deployment status: no answer (HTTP 502, 0s)');
    expect(log).toContain('Deployment status: not one Coolify is known to give');
    expect(log).not.toContain('<script>');
    expect(log).toContain(`::error::The Coolify deployment did not end within ${DEPLOY_LIMIT_MS / 1000} seconds.`);
  });

  it('fails when the box does not answer /health/db after a finished deployment', async () => {
    const { done, calls, lines } = run({ health: [{ status: 503, body: null }] });
    expect(await done).toBe(1);
    expect(calls.filter((c) => c.url === HEALTH)).toHaveLength(HEALTH_TRIES);
    expect(shown(lines)).toContain(`::error::The box did not answer ${HEALTH} in ${HEALTH_TRIES} tries over about 4 minutes.`);
  });

  it.each([
    ['a webhook without an application', { COOLIFY_BOX_WEBHOOK: `${COOLIFY}/api/v1/deploy?force=false` }, 'names no application'],
    ['a webhook that is not an address', { COOLIFY_BOX_WEBHOOK: 'not an address' }, 'is not an address'],
    ['no token', { COOLIFY_TOKEN: '' }, 'COOLIFY_TOKEN is empty'],
    ['a tag instead of a digest', { IMAGE_DIGEST: 'latest' }, 'IMAGE_DIGEST is not an image digest'],
    ['a short digest', { IMAGE_DIGEST: 'sha256:abc' }, 'IMAGE_DIGEST is not an image digest'],
    ['a plain http health address', { HEALTH_URL: 'http://run.example.test/health/db' }, 'HEALTH_URL'],
    ['a plain http webhook', { COOLIFY_BOX_WEBHOOK: `http://coolify.example.test:8000/api/v1/deploy?uuid=${APP}` }, 'COOLIFY_BOX_WEBHOOK is not an https address'],
  ])('refuses %s before asking Coolify anything', async (_name, env, message) => {
    const { done, calls, lines } = run({}, env);
    expect(await done).toBe(1);
    expect(calls).toEqual([]);
    expect(shown(lines)).toContain(message);
  });
});

describe('the script as the workflow runs it', () => {
  it('runs when started through a symlinked path, so a wrong entry check cannot pass the step having done nothing', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'deploy-'));
    try {
      const linked = path.join(dir, 'deploy.ts');
      symlinkSync(path.join(__dirname, '..', 'ci', 'deploy.ts'), linked);
      const result = spawnSync(process.execPath, [linked], { env: { PATH: process.env.PATH }, encoding: 'utf8' });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('::error::COOLIFY_BOX_WEBHOOK is not an address.\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
