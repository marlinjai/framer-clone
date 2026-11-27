// A behaviour shard waits for the shared build job; these hold that rerunning only a failed shard still finds it.

import { describe, expect, it } from 'vitest';
import { pickBuild } from '../pick-build.mjs';

const verdict = (listing: string, attempt: number) => pickBuild(listing, attempt).verdict;

describe('pickBuild', () => {
  it('follows the build of the first attempt', () => {
    expect(verdict('', 1)).toBe('wait');
    expect(verdict('1 queued \n', 1)).toBe('wait');
    expect(verdict('1 in_progress \n', 1)).toBe('wait');
    expect(verdict('1 completed success\n', 1)).toBe('ready');
    for (const bad of ['failure', 'cancelled', 'skipped', 'timed_out']) {
      expect(verdict(`1 completed ${bad}\n`, 1)).toBe('failed');
    }
  });

  it('reuses an earlier good build when only a shard is rerun', () => {
    expect(verdict('1 completed success\n', 2)).toBe('ready');
    expect(verdict('1 completed success\n2 completed success\n', 2)).toBe('ready');
  });

  it('prefers the newest build up to this attempt', () => {
    expect(verdict('1 completed success\n2 in_progress \n', 2)).toBe('wait');
    expect(verdict('2 completed failure\n1 completed success\n', 2)).toBe('failed');
    expect(verdict('1 completed failure\n2 completed success\n', 2)).toBe('ready');
    expect(verdict('1 completed success\n2 completed failure\n', 1)).toBe('ready');
  });

  it('does not end the wait on an earlier failure whose rebuild is not listed yet', () => {
    expect(verdict('1 completed failure\n', 2)).toBe('wait');
  });
});
