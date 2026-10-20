// deploy/custom-domains/sync-traefik.sh, the host-side half of the proxy
// boundary: it must re-validate every hostname the app sends, never let rule
// syntax into the Traefik file, keep the current file when the feed fails, and
// only rewrite the file when the content changed. Runs the real script with
// bash; the feed is a fake fetch command (FETCH) instead of curl.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '../../../../deploy/custom-domains/sync-traefik.sh');
let dir: string;

function run(feed: string, opts: { status?: string; env?: Record<string, string> } = {}) {
  const feedFile = join(dir, 'feed.txt');
  writeFileSync(feedFile, feed);
  const fetcher = join(dir, 'fetch.sh');
  writeFileSync(fetcher, `#!/bin/sh\ncat "${feedFile}" > "$1"\nprintf '%s' '${opts.status ?? '200'}'\n`);
  return spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      FEED_URL: 'https://app.lumitra.co/api/internal/custom-domains/hostnames',
      TRAEFIK_SERVICE: 'http-0-abc123@docker',
      OUTPUT_FILE: join(dir, 'out.yml'),
      FETCH: `sh ${fetcher}`,
      ...opts.env,
    } as unknown as NodeJS.ProcessEnv,
  });
}

const out = () => readFileSync(join(dir, 'out.yml'), 'utf8');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fc-sync-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('sync-traefik.sh', () => {
  it('is valid bash', () => {
    execFileSync('bash', ['-n', SCRIPT]);
  });

  it('writes an http redirect and an https router with the resolver per hostname', () => {
    const r = run('shop.example.com\nwww.example.org\n');
    expect(r.status).toBe(0);
    const yml = out();
    expect(yml).toContain('rule: "Host(`shop.example.com`)"');
    expect(yml).toContain('rule: "Host(`www.example.org`)"');
    expect(yml.match(/certResolver: letsencrypt/g)).toHaveLength(2);
    expect(yml.match(/service: http-0-abc123@docker/g)).toHaveLength(4);
    expect(yml).toContain('fc-cd-redirect-https');
    expect(yml).toContain('# 2 custom hostname(s).');
  });

  it('drops every line that is not a plain hostname, including rule injection', () => {
    const feed = [
      'good.example.com',
      'a.com`) || Host(`evil.com',
      'bad_label.example.com',
      'UPPER.example.com',
      '*.example.com',
      'example.com:443',
      '10.0.0.1',
      'single',
      'app.lumitra.co',
      'lumitra.co',
      `${'a'.repeat(64)}.example.com`,
      'good.example.com',
      'xn--bcher-kva.de\r',
      '',
    ].join('\n');
    const r = run(feed);
    expect(r.status).toBe(0);
    const yml = out();
    const rules = yml.match(/Host\(`[^`]*`\)/g) ?? [];
    expect([...new Set(rules)]).toEqual(['Host(`good.example.com`)', 'Host(`xn--bcher-kva.de`)']);
    expect(yml).not.toContain('evil');
    expect(yml).not.toContain('lumitra.co');
    expect(r.stderr).toContain('dropping');
  });

  it('caps the number of hostnames', () => {
    const feed = Array.from({ length: 5 }, (_, i) => `h${i}.example.com`).join('\n');
    run(feed, { env: { MAX_HOSTNAMES: '3' } });
    expect((out().match(/certResolver:/g) ?? []).length).toBe(3);
  });

  it('an empty feed writes a file without routers (every route removed)', () => {
    run('shop.example.com\n');
    run('');
    expect(out()).not.toContain('routers:');
  });

  it('keeps the current file when the feed fails', () => {
    run('shop.example.com\n');
    const before = out();
    const r = run('', { status: '500' });
    expect(r.status).not.toBe(0);
    expect(out()).toBe(before);
  });

  it('does not rewrite an unchanged file', () => {
    run('shop.example.com\n');
    const first = statSync(join(dir, 'out.yml')).mtimeMs;
    const r = run('shop.example.com\n');
    expect(r.status).toBe(0);
    expect(statSync(join(dir, 'out.yml')).mtimeMs).toBe(first);
    expect(existsSync(join(dir, 'out.yml.tmp'))).toBe(false);
  });

  it('refuses to run without, or with a malformed, service name', () => {
    expect(run('a.example.com', { env: { TRAEFIK_SERVICE: '' } }).status).not.toBe(0);
    expect(run('a.example.com', { env: { TRAEFIK_SERVICE: 'x\n  evil: 1' } }).status).not.toBe(0);
    expect(existsSync(join(dir, 'out.yml'))).toBe(false);
  });
});
