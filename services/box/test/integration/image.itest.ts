import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BOX_COMMON_HEADERS, BOX_DOCUMENT_POLICY, BOX_DOCUMENT_PREFIX, BOX_REFUSAL_POLICY } from '../../../../src/lib/customCode/contract';
import { boxImage, docker, dockerResult, FRAME_HEADERS, freePort, httpGet, randomName, startScratchPostgres, until, type RawResponse, type ScratchPostgres } from './docker';

// The built image, run the way it is meant to run (read-only root file
// system, every capability dropped, no new privileges, memory and process
// limits, published on 127.0.0.1 only), against a scratch Postgres on a
// private docker network. Nothing here reaches beyond this machine.

const SITE_A = '0b0e7c1a-5d2f-4c3b-9a8e-1f2d3c4b5a69';
const SITE_B = '7a1f3c55-0e2d-4b6a-8c9d-2e3f4a5b6c7d';
const HASH = 'a'.repeat(64);
const BLOCKED = 'b'.repeat(64);

const HARDENING = ['--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '256m', '--cpus', '0.5', '--pids-limit', '64'];

let pg: ScratchPostgres;
let image: string;
const containers: string[] = [];

interface Box {
  name: string;
  port: number;
}

async function runBox(env: Record<string, string | undefined>, extraArgs: string[] = []): Promise<Box> {
  const name = randomName('box-itest');
  const port = await freePort();
  const full: Record<string, string | undefined> = {
    BOX_DATABASE_URL: pg.readerUrlInNetwork,
    BOX_EDITOR_HOST: 'app.lumitra.co',
    BOX_SITES_BASE_HOST: 'sites.lumitra.co',
    CUSTOM_CODE_DISABLED: '0',
    ...env,
  };
  const passed: Record<string, string> = {};
  const flags: string[] = [];
  for (const [key, value] of Object.entries(full)) {
    if (value === undefined) continue;
    passed[key] = value;
    // The name only: docker takes the value from its own environment, so nothing secret is on a command line.
    flags.push('-e', key);
  }
  docker(['run', '-d', '--name', name, '--network', pg.network, ...HARDENING, '-p', `127.0.0.1:${port}:8080`, ...flags, ...extraArgs, image], { env: passed });
  containers.push(name);
  return { name, port };
}

async function ready(box: Box): Promise<void> {
  await until(async () => (await httpGet(box.port, '/health')).status === 200, 'the box');
}

function expectNoCookie(response: RawResponse) {
  expect(response.rawHeaderNames.map((name) => name.toLowerCase())).not.toContain('set-cookie');
}

function expectRefusal(response: RawResponse, status: number) {
  expect(response.status).toBe(status);
  expect(response.headers['content-security-policy']).toBe(BOX_REFUSAL_POLICY);
  expect(response.headers['cache-control']).toBe('no-store');
  expectNoCookie(response);
}

beforeAll(async () => {
  image = boxImage();
  pg = await startScratchPostgres();
  pg.sql(`
    INSERT INTO sites (id, custom_code_enabled) VALUES ('${SITE_A}', true), ('${SITE_B}', true);
    INSERT INTO site_domains (id, site_id, subdomain, custom_hostname, verification_status) VALUES
      ('d1', '${SITE_A}', 'shop', NULL, 'active'),
      ('d2', '${SITE_A}', NULL, 'www.example.com', 'active'),
      ('d3', '${SITE_A}', NULL, 'preview-x.sites.lumitra.co', 'active');
    INSERT INTO custom_code_blobs (site_id, sha256, document, declaration, title, created_by, blocked_at) VALUES
      ('${SITE_A}', '${HASH}', '<p>site a</p>', '{}', 'A', 'u1', NULL),
      ('${SITE_A}', '${BLOCKED}', '<p>blocked</p>', '{}', 'Blocked', 'u1', now());
  `);
});

afterAll(() => {
  for (const name of containers) {
    try {
      docker(['rm', '-f', '-v', name]);
    } catch {
      // Already gone.
    }
  }
  pg?.remove();
});

describe('the image', () => {
  let box: Box;
  beforeAll(async () => {
    box = await runBox({});
    await ready(box);
  });

  /** Runs a line of JavaScript inside the container with node, the only program left in it to run one. */
  const inBox = (script: string) => docker(['exec', box.name, 'node', '-e', script]).trim();

  it('runs as an unprivileged user on a read-only file system, with no shell and no package manager', () => {
    expect(docker(['image', 'inspect', '--format', '{{.Config.User}}', image]).trim()).toBe('node');
    expect(inBox('console.log(process.getuid(), process.geteuid())')).toBe('1000 1000');
    // Nothing can be written: not beside the service, not over it, not in /tmp.
    for (const file of ['/app/x', '/app/box.cjs', '/tmp/x', '/home/node/x', '/usr/local/bin/x']) {
      expect(inBox(`try { require('fs').writeFileSync(${JSON.stringify(file)}, 'x'); console.log('written'); } catch (e) { console.log(e.code); }`), file).toMatch(/^(EROFS|EACCES)$/);
    }
    // No shell and no package manager, by name on the path or by file.
    for (const program of ['sh', 'bash', 'dash', 'npm', 'npx', 'yarn', 'corepack', 'apt', 'apt-get', 'dpkg', 'wget', 'curl', 'perl']) {
      expect(() => docker(['exec', box.name, program, '--version']), program).toThrow();
    }
    expect(inBox(`console.log(['/bin/sh','/usr/bin/sh','/bin/bash','/usr/bin/dash','/usr/local/bin/npm','/usr/bin/apt','/usr/bin/dpkg','/usr/local/lib/node_modules'].filter((p) => require('fs').existsSync(p)).join(','))`)).toBe('');
    // The service is one file, owned by root, not writable, and the only thing in its directory.
    expect(inBox(`const fs = require('fs'); const s = fs.statSync('/app/box.cjs'); console.log(fs.readdirSync('/app').join(','), s.uid, (s.mode & 0o777).toString(8))`)).toBe('box.cjs 0 444');
    // The published port is bound to this machine only.
    expect(docker(['port', box.name, '8080']).trim()).toBe(`127.0.0.1:${box.port}`);
    // Capabilities: none effective, none permitted.
    const status = inBox(`console.log(require('fs').readFileSync('/proc/1/status', 'utf8'))`);
    expect(status).toMatch(/CapEff:\s+0000000000000000/);
    expect(status).toMatch(/CapPrm:\s+0000000000000000/);
    expect(status).toMatch(/NoNewPrivs:\s+1/);
  });

  it('serves a block to a cross-site frame with every decided header, byte for byte', async () => {
    const response = await httpGet(box.port, `/box/${SITE_A}/${HASH}`, FRAME_HEADERS);
    expect(response.status).toBe(200);
    expect(response.body).toBe(`${BOX_DOCUMENT_PREFIX}<p>site a</p>`);
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(response.headers['content-security-policy']).toBe(
      `${BOX_DOCUMENT_POLICY}; frame-ancestors https://shop.sites.lumitra.co https://www.example.com https://app.lumitra.co; report-uri https://app.lumitra.co/api/csp-report/box`,
    );
    expect(response.headers['cache-control']).toBe('private, max-age=300');
    expect(response.headers.vary).toBe('Sec-Fetch-Dest, Sec-Fetch-Site');
    for (const [name, value] of Object.entries(BOX_COMMON_HEADERS)) expect(response.headers[name.toLowerCase()]).toBe(value);
    // Nothing beyond the decided set and what HTTP itself needs (the connection headers depend on the client).
    const names = response.rawHeaderNames.map((name) => name.toLowerCase()).filter((name) => name !== 'connection' && name !== 'keep-alive');
    expect(names.sort()).toEqual(
      ['cache-control', 'content-length', 'content-security-policy', 'content-type', 'cross-origin-resource-policy', 'date', 'permissions-policy', 'referrer-policy', 'strict-transport-security', 'vary', 'x-content-type-options', 'x-dns-prefetch-control'].sort(),
    );
    const head = await httpGet(box.port, `/box/${SITE_A}/${HASH}`, FRAME_HEADERS, 'HEAD');
    expect(head.status).toBe(200);
    expect(head.body).toBe('');
    expect(head.headers['content-length']).toBe(response.headers['content-length']);
  });

  it('answers 503 while the database is frozen with its connections open, stays up, and serves again when it thaws', async () => {
    const target = `/box/${SITE_A}/${'9'.repeat(64)}`;
    expect((await httpGet(box.port, target, FRAME_HEADERS)).status).toBe(404);
    pg.pause();
    try {
      const down = await httpGet(box.port, `/box/${SITE_A}/${'8'.repeat(64)}`, FRAME_HEADERS);
      expectRefusal(down, 503);
      expect(down.body).toBe('');
    } finally {
      pg.unpause();
    }
    await until(async () => (await httpGet(box.port, `/box/${SITE_A}/${'8'.repeat(64)}`, FRAME_HEADERS)).status === 404, 'the box to reach the thawed database', 30_000);
    // The process was never ended by a stray failure: the same container is still the one answering.
    expect(docker(['inspect', '--format', '{{.RestartCount}} {{.State.Status}}', box.name]).trim()).toBe('0 running');
    expect(docker(['logs', box.name])).not.toContain('uncaught');
  });

  it('refuses every other request with its own status, the refusal policy and no cookie', async () => {
    const get = (target: string, headers: Record<string, string> = FRAME_HEADERS, method = 'GET') => httpGet(box.port, target, headers, method);
    expectRefusal(await get(`/box/${SITE_A}/${HASH}`, {}), 403);
    expectRefusal(await get(`/box/${SITE_A}/${HASH}`, { 'Sec-Fetch-Dest': 'iframe' }), 403);
    expectRefusal(await get(`/box/${SITE_A}/${HASH}`, { 'Sec-Fetch-Site': 'cross-site' }), 403);
    expectRefusal(await get(`/box/${SITE_A}/${HASH}`, { 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Site': 'none' }), 403);
    expectRefusal(await get(`/box/${SITE_A}/${HASH}`, { 'Sec-Fetch-Dest': 'iframe', 'Sec-Fetch-Site': 'same-site' }), 403);
    expectRefusal(await get(`/box/${SITE_A}/${HASH}?x=1`), 400);
    expectRefusal(await get(`/box/${SITE_A}/${'A'.repeat(64)}`), 404);
    expectRefusal(await get(`/box/not-a-site/${HASH}`), 404);
    expectRefusal(await get(`/box/${SITE_A}/${'c'.repeat(64)}`), 404);
    expectRefusal(await get(`/box/${SITE_B}/${HASH}`), 404);
    expectRefusal(await get(`/box/${SITE_A}/${BLOCKED}`), 410);
    expectRefusal(await get('/nothing'), 404);
    expectRefusal(await get(`/box/${SITE_A}/${HASH}`, FRAME_HEADERS, 'POST'), 405);
    expectRefusal(await get(`/box/${SITE_A}/${HASH}`, FRAME_HEADERS, 'DELETE'), 405);
    expectRefusal(await get('/health', {}), 200);
    expectRefusal(await get('/health/db', {}), 200);
    expectRefusal(await get('/', {}), 200);
  });

  it('answers 429 past 60 requests a minute for one path, and does not believe X-Forwarded-For', async () => {
    // The limit gives its allowance back one request a second (held exactly, with a clock the test
    // moves, in test/handler.test.ts). This test runs on real time inside a container, so what it may
    // expect depends on how long its own requests took: 60 at once, and one more for each second
    // that passed. An earlier form expected exactly 60 whatever the time, and failed when 62 requests
    // took 1.26 seconds on a busy machine.
    const target = `/box/${SITE_A}/${'d'.repeat(64)}`;
    const statuses: number[] = [];
    const started = Date.now();
    // Every request claims another client address in X-Forwarded-For; none of that is believed.
    for (let i = 0; i < 90; i++) statuses.push((await httpGet(box.port, target, { ...FRAME_HEADERS, 'X-Forwarded-For': `198.51.100.${i}` })).status);
    const seconds = (Date.now() - started) / 1000;
    const let_through = statuses.filter((status) => status === 404).length;
    const refused = statuses.filter((status) => status === 429).length;
    expect(let_through + refused).toBe(90);
    // The first 60 are let through, whatever the time.
    expect(statuses.slice(0, 60).every((status) => status === 404)).toBe(true);
    // Beyond them, no more than one for each second that passed (and one for the second under way).
    expect(let_through).toBeGreaterThanOrEqual(60);
    expect(let_through).toBeLessThanOrEqual(60 + Math.floor(seconds) + 1);
    // So some were refused, unless the 90 requests took half a minute, which would say nothing.
    expect(seconds).toBeLessThan(25);
    expect(refused).toBeGreaterThanOrEqual(90 - 60 - Math.floor(seconds) - 1);
    expect(refused).toBeGreaterThan(0);
    // A refusal, right after another refusal, has the refusal's headers.
    const last = await httpGet(box.port, target, FRAME_HEADERS);
    if (last.status === 429) expectRefusal(last, 429);
    else expect(last.status).toBe(404);
  });

  it('says at start how many proxies it believes, and logs no path, no whole address and no secret', async () => {
    expect(docker(['logs', box.name])).toMatch(/"event":"listening","port":8080,"serving":true,"trustedProxies":0/);
    await httpGet(box.port, '/box/data-smuggled-in-a-path/x', { ...FRAME_HEADERS, 'User-Agent': 'agent-in-a-header', Referer: 'https://preview-secret.sites.lumitra.co/' });
    const logs = docker(['logs', box.name]);
    expect(logs).toContain('"route":"box"');
    expect(logs).toContain(`"site":"${SITE_A}"`);
    expect(logs).not.toContain('data-smuggled');
    expect(logs).not.toContain('agent-in-a-header');
    expect(logs).not.toContain('preview-secret');
    expect(logs).not.toContain('box_reader');
    expect(logs).not.toContain(HASH);
    expect(logs).not.toMatch(/"net":"\d+\.\d+\.\d+\.(?!0\/24")/);
  });

  it('answers 503 while the database is away and serves again when it is back', async () => {
    const target = `/box/${SITE_A}/${'e'.repeat(64)}`;
    expect((await httpGet(box.port, target, FRAME_HEADERS)).status).toBe(404);
    pg.stop();
    try {
      const down = await httpGet(box.port, `/box/${SITE_A}/${'f'.repeat(64)}`, FRAME_HEADERS);
      expectRefusal(down, 503);
      expect(down.body).toBe('');
      expect(down.headers['retry-after']).toBe('5');
      await until(async () => (await httpGet(box.port, '/health/db')).status === 503, 'the health check to notice', 20_000);
      expect((await httpGet(box.port, '/health/db')).body).toMatch(/^unavailable: (connect|timeout)$/);
      expect((await httpGet(box.port, '/health')).status).toBe(200);
    } finally {
      await pg.start();
    }
    await until(async () => (await httpGet(box.port, `/box/${SITE_A}/${'f'.repeat(64)}`, FRAME_HEADERS)).status === 404, 'the box to reach the database again', 30_000);
    await until(async () => (await httpGet(box.port, '/health/db')).status === 200, 'the health check to recover', 20_000);
  });
});

describe('the image, started without a decision to serve', () => {
  it('answers 410 to every block while CUSTOM_CODE_DISABLED is not exactly 0, and stays healthy', async () => {
    for (const value of [undefined, '1', 'false']) {
      const box = await runBox({ CUSTOM_CODE_DISABLED: value });
      await ready(box);
      expectRefusal(await httpGet(box.port, `/box/${SITE_A}/${HASH}`, FRAME_HEADERS), 410);
      expect((await httpGet(box.port, '/health')).body).toBe('ok');
      docker(['rm', '-f', box.name]);
    }
  });

  it.each([
    ['no database address', { BOX_DATABASE_URL: undefined }, 'BOX_DATABASE_URL'],
    ['no editor host', { BOX_EDITOR_HOST: undefined }, 'BOX_EDITOR_HOST'],
    ['a wildcard editor host', { BOX_EDITOR_HOST: '*.lumitra.co' }, 'BOX_EDITOR_HOST'],
    ['no sites base host', { BOX_SITES_BASE_HOST: undefined }, 'BOX_SITES_BASE_HOST'],
    ['a proxy network that is everyone', { BOX_TRUSTED_PROXIES: '0.0.0.0/0' }, 'BOX_TRUSTED_PROXIES'],
    ['a listen host that is a name', { BOX_LISTEN_HOST: 'localhost' }, 'BOX_LISTEN_HOST'],
    ['a database address with a malformed escape', { BOX_DATABASE_URL: 'postgres://box_reader:a%zzb@pg:5432/postgres' }, 'BOX_DATABASE_URL'],
    ['a database address that asks for encryption this version does not have', { BOX_DATABASE_URL: 'postgres://box_reader:x@pg:5432/postgres?sslmode=verify-full' }, 'BOX_DATABASE_URL'],
  ])('refuses to start with %s, naming the variable and nothing it holds', async (_name, env, variable) => {
    const box = await runBox(env);
    await until(() => docker(['inspect', '--format', '{{.State.Status}}', box.name]).trim() === 'exited', 'the box to stop');
    expect(docker(['inspect', '--format', '{{.State.ExitCode}}', box.name]).trim()).toBe('78');
    const logs = (await dockerResult(['logs', box.name])).output;
    expect(logs).toContain(`box: ${variable} `);
    expect(logs).not.toContain('box_reader');
    expect(logs).not.toContain('postgres://');
    // No stack trace of the service or the driver.
    expect(logs).not.toMatch(/\n\s+at /);
  });

  it('refuses to start as root', async () => {
    const box = await runBox({}, ['--user', '0']);
    await until(() => docker(['inspect', '--format', '{{.State.Status}}', box.name]).trim() === 'exited', 'the box to stop');
    expect(docker(['inspect', '--format', '{{.State.ExitCode}}', box.name]).trim()).toBe('78');
    expect((await dockerResult(['logs', box.name])).output).toContain('box: refusing to run as root');
  });
});
