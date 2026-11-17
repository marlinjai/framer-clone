import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { type Answer, type Call, deploy, DEPLOY_LIMIT_MS, HEALTH_TRIES } from '../ci/deploy';

const COOLIFY = 'https://coolify.example.test:8443';
const APP = 'app0123456789';
const HEALTH = 'https://run.example.test/health/db';
const digest = () => `sha256:${randomBytes(32).toString('hex')}`;

interface Script {
  patch?: Answer;
  webhook?: Answer;
  /** The answers to the deployment's status, in order; the last one repeats. */
  statuses?: readonly Answer[];
  /** The answers of /health/db, in order; the last one repeats. */
  health?: readonly Answer[];
}

function run(script: Script, env: Record<string, string | undefined> = {}) {
  const token = `test-token-${randomBytes(12).toString('hex')}`;
  const image = digest();
  const calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] = [];
  const lines: string[] = [];
  let clock = 0;
  let statusIndex = 0;
  let healthIndex = 0;
  const pick = (list: readonly Answer[] | undefined, index: number, fallback: Answer) => (list ? (list[Math.min(index, list.length - 1)] ?? fallback) : fallback);
  const call: Call = async (url, init) => {
    calls.push({ url, ...init });
    if (init.method === 'PATCH') return script.patch ?? { status: 200, body: { uuid: APP } };
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
      `PATCH ${COOLIFY}/api/v1/applications/${APP}`,
      `POST ${COOLIFY}/api/v1/deploy?uuid=${APP}&force=false`,
      `GET ${COOLIFY}/api/v1/deployments/dep-1`,
      `GET ${COOLIFY}/api/v1/deployments/dep-1`,
      `GET ${COOLIFY}/api/v1/deployments/dep-1`,
      `GET ${HEALTH}`,
      `GET ${HEALTH}`,
    ]);
    // The digest in Coolify's form, which it deploys as <image>@sha256:<hex>.
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ docker_registry_image_tag: `sha256-${image.slice(7)}` });
    for (const c of calls.slice(0, 5)) expect(c.headers.Authorization).toBe(`Bearer ${token}`);
    // The health check is asked without the token.
    expect(calls[5]?.headers.Authorization).toBeUndefined();
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
    ['the tag is refused for the token', { patch: { status: 403, body: null } }, 'Coolify did not take the image', true],
    ['the tag is refused', { patch: { status: 422, body: { message: 'x' } } }, 'Coolify did not take the image', false],
    ['the webhook is refused', { webhook: { status: 401, body: null } }, 'The Coolify deploy webhook answered HTTP 401.', true],
    ['the webhook does not answer', { webhook: { status: 0, body: null } }, 'The Coolify deploy webhook answered HTTP 0.', false],
    ['no deployment is named', { webhook: { status: 200, body: { deployments: [] } } }, 'Coolify named no deployment', false],
    ['a malformed deployment is named', { webhook: { status: 200, body: { deployments: [{ deployment_uuid: '../x' }] } } }, 'Coolify named no deployment', false],
    ['the token cannot read deployments', { statuses: [{ status: 401, body: null }] }, 'cannot read deployments (HTTP 401)', true],
  ] as const)('fails when %s', async (_name, script, message, hint) => {
    const { done, lines, calls } = run(script);
    expect(await done).toBe(1);
    const log = shown(lines);
    expect(log).toContain(message);
    expect(log.includes('read, write and deploy permissions, limited to the box application')).toBe(hint);
    expect(calls.some((c) => c.url === HEALTH)).toBe(false);
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
    expect(shown(lines)).toContain(`::error::The box did not answer ${HEALTH} within 120 seconds.`);
  });

  it.each([
    ['a webhook without an application', { COOLIFY_BOX_WEBHOOK: `${COOLIFY}/api/v1/deploy?force=false` }, 'names no application'],
    ['a webhook that is not an address', { COOLIFY_BOX_WEBHOOK: 'not an address' }, 'is not an address'],
    ['no token', { COOLIFY_TOKEN: '' }, 'COOLIFY_TOKEN is empty'],
    ['a tag instead of a digest', { IMAGE_DIGEST: 'latest' }, 'IMAGE_DIGEST is not an image digest'],
    ['a short digest', { IMAGE_DIGEST: 'sha256:abc' }, 'IMAGE_DIGEST is not an image digest'],
    ['a plain http health address', { HEALTH_URL: 'http://run.example.test/health/db' }, 'HEALTH_URL'],
  ])('refuses %s before asking Coolify anything', async (_name, env, message) => {
    const { done, calls, lines } = run({}, env);
    expect(await done).toBe(1);
    expect(calls).toEqual([]);
    expect(shown(lines)).toContain(message);
  });
});
