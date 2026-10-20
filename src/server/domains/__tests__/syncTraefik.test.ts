// deploy/custom-domains/sync-traefik.sh, the host-side half of the proxy
// boundary. It must refuse anything that is not exactly the app's feed (wrong
// status or content type, body not matching its hash or count, any invalid
// line), refuse suspicious drops unless forced, keep the current file on every
// refusal, never let rule syntax or blocked zones into the Traefik file, and
// rewrite the file only on change. Runs the real script with bash; the feed is
// a fake fetch command (FETCH) instead of curl.

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '../../../../deploy/custom-domains/sync-traefik.sh');
let dir: string;

interface Feed {
  body: string;
  status?: string;
  contentType?: string | null;
  sha?: string | null;
  count?: string | null;
  truncated?: boolean;
}

const lines = (...hosts: string[]) => (hosts.length ? `${hosts.join('\n')}\n` : '');

function headersFor(feed: Feed): string {
  const sha = feed.sha === undefined ? createHash('sha256').update(feed.body).digest('hex') : feed.sha;
  const count =
    feed.count === undefined ? String(feed.body.split('\n').filter((l) => l.length > 0).length) : feed.count;
  const out = ['HTTP/2 200'];
  const ct = feed.contentType === undefined ? 'text/plain; charset=utf-8' : feed.contentType;
  if (ct !== null) out.push(`Content-Type: ${ct}`);
  if (sha !== null) out.push(`X-Content-Sha256: ${sha}`);
  if (count !== null) out.push(`x-hostname-count: ${count}`);
  if (feed.truncated) out.push('x-hostname-truncated: true');
  return `${out.join('\r\n')}\r\n\r\n`;
}

function run(feed: Feed, env: Record<string, string> = {}) {
  writeFileSync(join(dir, 'feed.body'), feed.body);
  writeFileSync(join(dir, 'feed.headers'), headersFor(feed));
  const fetcher = join(dir, 'fetch.sh');
  writeFileSync(
    fetcher,
    `#!/bin/sh\ncat "${dir}/feed.body" > "$1"\ncat "${dir}/feed.headers" > "$2"\nprintf '%s' '${feed.status ?? '200'}'\n`,
  );
  return spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      FEED_URL: 'https://app.lumitra.co/api/internal/custom-domains/hostnames',
      TRAEFIK_SERVICE: 'http-0-abc123@docker',
      OUTPUT_FILE: join(dir, 'out.yml'),
      STATE_DIR: join(dir, 'state'),
      FETCH: `sh ${fetcher}`,
      ...env,
    } as unknown as NodeJS.ProcessEnv,
  });
}

const out = () => readFileSync(join(dir, 'out.yml'), 'utf8');
const rules = () => [...new Set(out().match(/Host\(`[^`]*`\)/g) ?? [])];

function expectRefusedKeepingFile(r: ReturnType<typeof run>, before: string | null, reason: RegExp) {
  expect(r.status).not.toBe(0);
  expect(r.stderr).toMatch(/REFUSED/);
  expect(r.stderr).toMatch(reason);
  if (before === null) expect(existsSync(join(dir, 'out.yml'))).toBe(false);
  else expect(out()).toBe(before);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fc-sync-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('sync-traefik.sh: writing routes', () => {
  it('is valid bash', () => {
    execFileSync('bash', ['-n', SCRIPT]);
  });

  it('writes an http redirect and an https router per hostname, at priority 1', () => {
    const r = run({ body: lines('shop.example.com', 'xn--bcher-kva.de') });
    expect(r.status).toBe(0);
    const yml = out();
    expect(rules()).toEqual(['Host(`shop.example.com`)', 'Host(`xn--bcher-kva.de`)']);
    expect(yml.match(/certResolver: letsencrypt/g)).toHaveLength(2);
    expect(yml.match(/service: http-0-abc123@docker/g)).toHaveLength(4);
    expect(yml.match(/priority: 1\n/g)).toHaveLength(4);
    expect(yml).toContain('# hostname: shop.example.com');
    expect(yml).toContain('fc-cd-redirect-https');
  });

  it('logs when the app reports its cap was reached', () => {
    const r = run({ body: lines('a.example.com'), truncated: true });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('cap was reached');
  });

  it('does not rewrite an unchanged file', () => {
    run({ body: lines('shop.example.com') });
    const first = statSync(join(dir, 'out.yml')).mtimeMs;
    const r = run({ body: lines('shop.example.com') });
    expect(r.status).toBe(0);
    expect(statSync(join(dir, 'out.yml')).mtimeMs).toBe(first);
    expect(existsSync(join(dir, 'out.yml.tmp'))).toBe(false);
  });

  it('a first run with an empty feed writes a file without routers', () => {
    const r = run({ body: '' });
    expect(r.status).toBe(0);
    expect(out()).not.toContain('routers:');
  });
});

describe('sync-traefik.sh: refusing what is not the feed', () => {
  it('refuses a non-200 answer', () => {
    run({ body: lines('shop.example.com') });
    const before = out();
    expectRefusedKeepingFile(run({ body: '', status: '500' }), before, /HTTP 500/);
  });

  it('refuses an HTML page served with 200 (a login or error page)', () => {
    run({ body: lines('shop.example.com', 'www.example.org') });
    const before = out();
    const html = '<!doctype html><html><body>Sign in</body></html>\n';
    expectRefusedKeepingFile(run({ body: html, contentType: 'text/html; charset=utf-8' }), before, /content-type/);
    // Even mislabelled as text/plain, HTML is not a list of hostnames.
    expectRefusedKeepingFile(run({ body: html }), before, /not a plain hostname/);
  });

  it('refuses a missing content type', () => {
    expectRefusedKeepingFile(run({ body: lines('a.example.com'), contentType: null }), null, /content-type/);
  });

  it('refuses a body that does not match its hash, or a missing hash', () => {
    run({ body: lines('a.example.com', 'b.example.com') });
    const before = out();
    expectRefusedKeepingFile(run({ body: lines('a.example.com', 'b.example.com'), sha: 'f'.repeat(64) }), before, /x-content-sha256/);
    expectRefusedKeepingFile(run({ body: lines('a.example.com'), sha: null }), before, /x-content-sha256/);
  });

  it('refuses a body whose line count does not match the header', () => {
    expectRefusedKeepingFile(run({ body: lines('a.example.com', 'b.example.com'), count: '3' }), null, /x-hostname-count/);
    expectRefusedKeepingFile(run({ body: lines('a.example.com'), count: null }), null, /x-hostname-count/);
  });

  it.each([
    ['rule injection', 'a.com`) || Host(`evil.com'],
    ['an underscore', 'bad_label.example.com'],
    ['upper case', 'UPPER.example.com'],
    ['a wildcard', '*.example.com'],
    ['a port', 'example.com:443'],
    ['an IP address', '10.0.0.1'],
    ['a single label', 'single'],
    ['a platform host', 'app.lumitra.co'],
    ['the platform zone', 'lumitra.co'],
    ['a reserved ending', 'shop.localhost'],
    ['the test ending', 'shop.test'],
    ['the onion ending', 'abc.onion'],
    ['a label over 63 characters', `${'a'.repeat(64)}.example.com`],
    ['a repeated line', 'good.example.com'],
  ])('refuses the WHOLE feed when one line is %s', (_why, bad) => {
    run({ body: lines('good.example.com', 'other.example.com') });
    const before = out();
    expectRefusedKeepingFile(run({ body: lines('good.example.com', 'other.example.com', bad) }), before, /line 3/);
  });

  it('refuses hostnames under a BLOCKED_ZONES entry', () => {
    const r = run({ body: lines('shop.example.com', 'x.other-product.io') }, { BLOCKED_ZONES: 'other-product.io, Second.NET' });
    expectRefusedKeepingFile(r, null, /blocked zone other-product\.io/);
    const r2 = run({ body: lines('second.net') }, { BLOCKED_ZONES: 'other-product.io, Second.NET' });
    expectRefusedKeepingFile(r2, null, /blocked zone second\.net/);
  });

  it('refuses a malformed BLOCKED_ZONES entry or service name', () => {
    expect(run({ body: lines('a.example.com') }, { BLOCKED_ZONES: 'a.com,`x`' }).status).toBe(2);
    expect(run({ body: lines('a.example.com') }, { TRAEFIK_SERVICE: '' }).status).not.toBe(0);
    expect(run({ body: lines('a.example.com') }, { TRAEFIK_SERVICE: 'x\n  evil: 1' }).status).toBe(2);
    expect(existsSync(join(dir, 'out.yml'))).toBe(false);
  });

  it('refuses more hostnames than MAX_HOSTNAMES', () => {
    const many = Array.from({ length: 5 }, (_, i) => `h${i}.example.com`);
    expectRefusedKeepingFile(run({ body: lines(...many) }, { MAX_HOSTNAMES: '3' }), null, /MAX_HOSTNAMES/);
  });
});

describe('sync-traefik.sh: drop protection', () => {
  const hosts = (n: number, prefix = 'site') => Array.from({ length: n }, (_, i) => `${prefix}${i}.example.com`);
  const stateFile = () => join(dir, 'state', 'high-water');
  const forceFile = () => join(dir, 'state', 'force-once');

  it('holds a large drop but still applies additions (the union is written, exit 3)', () => {
    run({ body: lines(...hosts(20)) });
    const r = run({ body: lines(...hosts(4), 'brand-new.example.com') });
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/HELD: the feed would drop from 20 to 5/);
    const written = rules();
    expect(written).toHaveLength(21);
    expect(written).toContain('Host(`brand-new.example.com`)');
    expect(written).toContain('Host(`site19.example.com`)');
  });

  it('applies drops of DROP_FLOOR routes or fewer, even to zero', () => {
    run({ body: lines(...hosts(5)) });
    const r = run({ body: '' });
    expect(r.status).toBe(0);
    expect(out()).not.toContain('routers:');
  });

  it('applies drops of half or less (ordinary disconnects)', () => {
    run({ body: lines(...hosts(20)) });
    expect(run({ body: lines(...hosts(10)) }).status).toBe(0);
    expect(rules()).toHaveLength(10);
  });

  it('compares against the 24 h high-water mark, not only the previous run', () => {
    run({ body: lines(...hosts(20)) });
    expect(run({ body: lines(...hosts(12)) }).status).toBe(0); // 20 -> 12: fine
    const r = run({ body: lines(...hosts(8)) }); // 12 -> 8 looks small, but 20 -> 8 is not
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/from 20 to 8/);
    expect(rules()).toHaveLength(12);
  });

  it('an expired high-water mark no longer counts', () => {
    run({ body: lines(...hosts(20)) });
    expect(run({ body: lines(...hosts(12)) }).status).toBe(0);
    writeFileSync(stateFile(), `20 ${Math.floor(Date.now() / 1000) - 90_000}\n`);
    expect(run({ body: lines(...hosts(8)) }).status).toBe(0);
    expect(rules()).toHaveLength(8);
    expect(readFileSync(stateFile(), 'utf8').split(' ')[0]).toBe('8');
  });

  it('a held drop leaves the high-water mark alone; force-once confirms it once and is deleted', () => {
    run({ body: lines(...hosts(20)) });
    expect(run({ body: '' }).status).toBe(3);
    expect(rules()).toHaveLength(20);
    expect(readFileSync(stateFile(), 'utf8').split(' ')[0]).toBe('20');

    writeFileSync(forceFile(), '');
    const forced = run({ body: '' });
    expect(forced.status).toBe(0);
    expect(forced.stderr).toContain('force-once flag found and consumed');
    expect(existsSync(forceFile())).toBe(false);
    expect(out()).not.toContain('routers:');
    expect(readFileSync(stateFile(), 'utf8').split(' ')[0]).toBe('0');

    // The confirmation was one-shot: from 20 again, the next big drop is held.
    run({ body: lines(...hosts(20)) });
    expect(run({ body: lines(...hosts(2)) }).status).toBe(3);
  });

  it('a refused feed never touches the high-water mark', () => {
    run({ body: lines(...hosts(10)) });
    const before = readFileSync(stateFile(), 'utf8');
    run({ body: '<html></html>\n', contentType: 'text/html' });
    expect(readFileSync(stateFile(), 'utf8')).toBe(before);
  });
});

describe('sync-traefik.sh: the token file', () => {
  function runCurlPath(mode: number, ownerUid: string) {
    const tokenFile = join(dir, 'token.header');
    writeFileSync(tokenFile, 'Authorization: Bearer test-token\n');
    chmodSync(tokenFile, mode);
    return spawnSync('bash', [SCRIPT], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        FEED_URL: 'https://127.0.0.1:9/never',
        TRAEFIK_SERVICE: 'http-0-abc123@docker',
        OUTPUT_FILE: join(dir, 'out.yml'),
        TOKEN_FILE: tokenFile,
        TOKEN_OWNER_UID: ownerUid,
      } as unknown as NodeJS.ProcessEnv,
    });
  }
  const myUid = String(process.getuid?.() ?? 0);

  it('refuses a token file readable by others', () => {
    const r = runCurlPath(0o644, myUid);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('mode 0600');
  });

  it('refuses a token file not owned by the required user', () => {
    const r = runCurlPath(0o600, String(Number(myUid) + 1));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('owned by uid');
  });

  it('accepts a correctly owned 0600 file and then fails closed on the unreachable feed', () => {
    const r = runCurlPath(0o600, myUid);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('could not be fetched');
    expect(existsSync(join(dir, 'out.yml'))).toBe(false);
  });
});
