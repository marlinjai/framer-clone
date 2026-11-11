// The shared rules of a site branch (src/lib/sites/branches.ts) and the per-company switch
// (src/server/sites/branches/switch.ts).

import { describe, expect, it } from 'vitest';
import { BRANCH_NAME_MAX_LENGTH, isOpenBranchStatus, validateBranchName } from '../branches';
import { siteBranchesEnabled } from '@/server/sites/branches/switch';

describe('validateBranchName', () => {
  it('trims, collapses whitespace and removes control and bidirectional characters', () => {
    expect(validateBranchName('  Spring\n\tsale  ')).toEqual({ ok: true, name: 'Spring sale' });
    expect(validateBranchName('a\u202Eb\u2066c\u0000d')).toEqual({ ok: true, name: 'a b c d' });
  });

  it('refuses an empty, invisible, too long or non-string name', () => {
    for (const raw of ['', '   ', '\u200B\u200D', '\u0007', 42, null]) expect(validateBranchName(raw).ok).toBe(false);
    expect(validateBranchName('x'.repeat(BRANCH_NAME_MAX_LENGTH)).ok).toBe(true);
    expect(validateBranchName('x'.repeat(BRANCH_NAME_MAX_LENGTH + 1)).ok).toBe(false);
    // Code points, not UTF-16 units: an emoji counts once.
    expect(validateBranchName('\u{1F600}'.repeat(BRANCH_NAME_MAX_LENGTH)).ok).toBe(true);
  });

  it('knows which states hold content', () => {
    expect(['open', 'ready', 'merged', 'discarded'].map((s) => isOpenBranchStatus(s as never))).toEqual([true, true, false, false]);
  });
});

describe('siteBranchesEnabled', () => {
  it('is off unless the variable names the company or says *', () => {
    expect(siteBranchesEnabled('c1', undefined)).toBe(false);
    expect(siteBranchesEnabled('c1', '')).toBe(false);
    expect(siteBranchesEnabled('c1', 'c2, c3')).toBe(false);
    expect(siteBranchesEnabled('c1', 'c2, c1 ')).toBe(true);
    expect(siteBranchesEnabled('c1', '*')).toBe(true);
    expect(siteBranchesEnabled(null, '*')).toBe(false);
    expect(siteBranchesEnabled('', '*')).toBe(false);
  });
});
