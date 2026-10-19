// @vitest-environment node
//
// src/lib/__tests__/editorHostConfig.test.ts
//
// A production start without EDITOR_HOST would treat every host as a published
// site, the editor included. Two layers refuse it: boot.sh (before migrating)
// and assertEditorHostConfigured, called from src/instrumentation.ts. Both are
// pinned here; dev and tests keep working with EDITOR_HOST unset.

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertEditorHostConfigured, EDITOR_HOST_MISSING_MESSAGE } from '../editorHost';

describe('assertEditorHostConfigured', () => {
  it.each([
    ['development, unset', { NODE_ENV: 'development' }],
    ['test, unset', { NODE_ENV: 'test' }],
    ['no NODE_ENV, unset', {}],
    ['production, set', { NODE_ENV: 'production', EDITOR_HOST: 'app.lumitra.co' }],
  ])('passes: %s', (_label, env) => {
    expect(() => assertEditorHostConfigured(env)).not.toThrow();
  });

  it.each([
    ['unset', { NODE_ENV: 'production' }],
    ['empty', { NODE_ENV: 'production', EDITOR_HOST: '' }],
    ['blank', { NODE_ENV: 'production', EDITOR_HOST: '   ' }],
  ])('refuses a production start with EDITOR_HOST %s', (_label, env) => {
    expect(() => assertEditorHostConfigured(env)).toThrow(EDITOR_HOST_MISSING_MESSAGE);
  });

  it('names the variable, the production value and the docs in its message', () => {
    expect(EDITOR_HOST_MISSING_MESSAGE).toMatch(/EDITOR_HOST/);
    expect(EDITOR_HOST_MISSING_MESSAGE).toMatch(/app\.lumitra\.co/);
    expect(EDITOR_HOST_MISSING_MESSAGE).toMatch(/deploy\/README\.md/);
  });
});

// boot.sh is run for real with `prisma` and `node` replaced by stubs on PATH
// that only record that they ran, so the test needs no database.
describe('boot.sh EDITOR_HOST check', () => {
  const bootScript = path.resolve(__dirname, '../../../boot.sh');

  function runBoot(env: Record<string, string>): { status: number; output: string } {
    const bin = mkdtempSync(path.join(tmpdir(), 'boot-stubs-'));
    for (const name of ['prisma', 'node']) {
      const stub = path.join(bin, name);
      writeFileSync(stub, `#!/bin/sh\necho "stub ${name} ran"\n`);
      chmodSync(stub, 0o755);
    }
    try {
      const output = execFileSync('/bin/sh', [bootScript], {
        env: { PATH: `${bin}:/usr/bin:/bin`, ...env } as unknown as NodeJS.ProcessEnv,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { status: 0, output };
    } catch (err) {
      const e = err as { status: number; stdout: string; stderr: string };
      return { status: e.status, output: `${e.stdout}${e.stderr}` };
    }
  }

  it('exits 1 before migrating when NODE_ENV=production and EDITOR_HOST is unset', () => {
    const result = runBoot({ NODE_ENV: 'production' });
    expect(result.status).toBe(1);
    expect(result.output).toMatch(/EDITOR_HOST is not set/);
    expect(result.output).not.toMatch(/stub prisma ran/);
  });

  it('exits 1 when EDITOR_HOST is blank', () => {
    const result = runBoot({ NODE_ENV: 'production', EDITOR_HOST: '  ' });
    expect(result.status).toBe(1);
    expect(result.output).not.toMatch(/stub prisma ran/);
  });

  it('continues to the migrations and the server when EDITOR_HOST is set', () => {
    const result = runBoot({ NODE_ENV: 'production', EDITOR_HOST: 'app.lumitra.co' });
    expect(result.status).toBe(0);
    expect(result.output).toMatch(/stub prisma ran/);
    expect(result.output).toMatch(/stub node ran/);
  });

  it('does not require EDITOR_HOST outside production', () => {
    const result = runBoot({ NODE_ENV: 'development' });
    expect(result.status).toBe(0);
    expect(result.output).toMatch(/stub prisma ran/);
  });
});
