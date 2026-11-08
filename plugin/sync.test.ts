// @vitest-environment node
// Run the actual sync script against local Git repositories. No GitHub access,
// credential helpers, user Git configuration or deploy keys are used.
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..');
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'plugin-sync-'));
  roots.push(root);
  const bin = join(root, 'bin');
  const temp = join(root, 'tmp');
  mkdirSync(bin);
  mkdirSync(temp);
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: 'test',
    PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    TMPDIR: temp,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Plugin test',
    GIT_COMMITTER_NAME: 'Plugin test',
    GIT_AUTHOR_EMAIL: 'plugin-test@example.invalid',
    GIT_COMMITTER_EMAIL: 'plugin-test@example.invalid',
    // Disabling hooks and signing keeps the test independent of workstation setup.
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'commit.gpgSign',
    GIT_CONFIG_VALUE_0: 'false',
    GIT_CONFIG_KEY_1: 'core.hooksPath',
    GIT_CONFIG_VALUE_1: '/dev/null',
  };
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const mirror = join(root, 'mirror.git');
  git(root, 'init', '--bare', '--initial-branch=main', mirror);
  const url = pathToFileURL(mirror).href;
  const run = (mode = '--check', overrides: Record<string, string> = {}) => {
    const result = spawnSync('bash', [join(ROOT, 'scripts/sync-plugin-repo.sh'), ...(mode ? [mode] : [])], {
      cwd: ROOT, env: { ...env, PLUGIN_MIRROR_URL: url, ...overrides }, encoding: 'utf8', timeout: 15_000,
    });
    return { status: result.status, output: result.stdout + result.stderr, error: result.error };
  };
  const seed = () => {
    const checkout = join(root, 'seed');
    git(root, 'clone', url, checkout);
    cpSync(join(ROOT, 'plugin/lumitra-sites'), checkout, { recursive: true });
    cpSync(join(ROOT, 'plugin/lumitra-sites-mirror'), checkout, { recursive: true });
    git(checkout, 'add', '-A');
    git(checkout, 'commit', '-m', 'Seed mirror');
    git(checkout, 'push', 'origin', 'HEAD:main');
    return checkout;
  };
  const commit = (checkout: string) => {
    git(checkout, 'add', '-A');
    git(checkout, 'commit', '-m', 'Change mirror');
    git(checkout, 'push', 'origin', 'HEAD:main');
  };
  return { root, bin, mirror, git, run, seed, commit };
}

describe('plugin mirror synchronization', () => {
  it('bootstraps an empty mirror and can check and sync again', () => {
    const { run } = fixture();
    expect(run('--check').status).toBe(1);
    const pushed = run('');
    expect(pushed.status, pushed.output).toBe(0);
    expect(run('--check').status).toBe(0);
    expect(run('').output).toContain('matches plugin/lumitra-sites');
  });

  it.each(['unborn', 'diverged'])('reads and pushes main when remote HEAD is %s master', (kind) => {
    const { mirror, git, run, seed } = fixture();
    const checkout = seed();
    if (kind === 'diverged') {
      git(checkout, 'checkout', '-b', 'master');
      writeFileSync(join(checkout, 'README.md'), 'A different default branch\n');
      git(checkout, 'add', '-A');
      git(checkout, 'commit', '-m', 'Diverge default branch');
      git(checkout, 'push', 'origin', 'master');
    }
    git(mirror, 'symbolic-ref', 'HEAD', 'refs/heads/master');
    expect(run('--check').status).toBe(0);
    git(checkout, 'checkout', 'main');
    writeFileSync(join(checkout, 'README.md'), 'Drift on main\n');
    git(checkout, 'add', '-A');
    git(checkout, 'commit', '-m', 'Drift main');
    git(checkout, 'push', 'origin', 'main');
    const result = run('');
    expect(result.status, result.output).toBe(0);
    expect(run('--check').status).toBe(0);
  });

  it('creates main from remote HEAD even when the existing payload already matches', () => {
    const { mirror, git, run, seed } = fixture();
    const checkout = seed();
    git(checkout, 'push', 'origin', 'HEAD:master');
    git(mirror, 'symbolic-ref', 'HEAD', 'refs/heads/master');
    git(mirror, 'update-ref', '-d', 'refs/heads/main');
    expect(run('--check').status).toBe(1);
    const result = run('');
    expect(result.status, result.output).toBe(0);
    expect(git(mirror, 'rev-parse', 'main')).toBe(git(mirror, 'rev-parse', 'master'));
    expect(run('--check').status).toBe(0);
  });

  it('detects and removes mirror-only files and symlinks, including dangling links', () => {
    const { mirror, git, run, seed, commit } = fixture();
    const checkout = seed();
    writeFileSync(join(checkout, 'obsolete.txt'), 'old content');
    symlinkSync('README.md', join(checkout, 'extra link'));
    symlinkSync('absent', join(checkout, 'dangling'));
    symlinkSync('skills', join(checkout, 'directory-link'));
    commit(checkout);
    const before = git(mirror, 'rev-parse', 'main');
    const checked = run('--check');
    expect(checked.status, checked.output).toBe(1);
    for (const name of ['obsolete.txt', 'extra link', 'dangling', 'directory-link']) expect(checked.output).toContain(`drift: ${name}`);
    expect(git(mirror, 'rev-parse', 'main')).toBe(before);
    const synced = run('');
    expect(synced.status, synced.output).toBe(0);
    expect(run('--check').status).toBe(0);
  });

  it('replaces symlinks at payload paths without reading or writing their targets', () => {
    const { root, run, seed, commit } = fixture();
    const checkout = seed();
    const outside = join(root, 'outside');
    mkdirSync(outside);
    const sentinel = join(outside, 'SKILL.md');
    writeFileSync(sentinel, 'untouched');
    rmSync(join(checkout, 'skills/build-a-site'), { recursive: true });
    symlinkSync(outside, join(checkout, 'skills/build-a-site'));
    rmSync(join(checkout, 'README.md'));
    symlinkSync(sentinel, join(checkout, 'README.md'));
    commit(checkout);
    expect(run('--check').status).toBe(1);
    const synced = run('');
    expect(synced.status, synced.output).toBe(0);
    expect(readFileSync(sentinel, 'utf8')).toBe('untouched');
    expect(run('--check').status).toBe(0);
  });

  it.each(['probe', 'clone'])('fails when the %s transport fails, even with the former allow-missing flag', (stage) => {
    const { bin, run } = fixture();
    writeFileSync(join(bin, 'git'), stage === 'probe'
      ? '#!/bin/sh\nexit 128\n'
      : '#!/bin/sh\nif [ "$1" = ls-remote ]; then exit 2; fi\nexit 128\n', { mode: 0o755 });
    const result = run('', { PLUGIN_MIRROR_ALLOW_MISSING: '1' });
    expect(result.status, result.output).toBe(2);
    expect(result.output).not.toContain('nothing to sync');
  });
});
