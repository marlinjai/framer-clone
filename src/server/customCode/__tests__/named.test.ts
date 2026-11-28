// src/server/customCode/__tests__/named.test.ts
//
// The pure parts of the one reading of "named" (src/server/customCode/named.ts, plan D113 and D114): what a save of
// one row may count as kept alive by something else, and the union of all names. The queries behind them are
// proven against Postgres in lifecycle.itest.ts.

import { describe, expect, it } from 'vitest';
import { allNamed, namedOutside, type NamedHashes } from '../named';

const named = (over: Partial<NamedHashes> = {}): NamedHashes => ({
  workingCopy: new Map([['main', 2]]),
  branches: new Set(['b1', 'b2', 'record']),
  branchCopies: new Map([
    ['branch-1', new Set(['b1'])],
    ['branch-2', new Set(['b2'])],
  ]),
  branchRecords: new Set(['record']),
  revisions: new Set(['revision']),
  ...over,
});

describe('namedOutside', () => {
  it('for main: revisions, branch records and every branch copy, never main\'s own copy', () => {
    expect([...namedOutside(named(), 'main-id', 'main-id')].sort()).toEqual(['b1', 'b2', 'record', 'revision']);
  });

  it('for a branch: main\'s copy and the other branches, never its own copy', () => {
    expect([...namedOutside(named(), 'branch-1', 'main-id')].sort()).toEqual(['b2', 'main', 'record', 'revision']);
  });

  it('keeps a hash its own copy shares with another place', () => {
    const shared = named({ branchCopies: new Map([['branch-1', new Set(['shared'])], ['branch-2', new Set(['shared'])]]) });
    expect(namedOutside(shared, 'branch-1', 'main-id').has('shared')).toBe(true);
  });
});

describe('allNamed', () => {
  it('is every hash from the working copy, the branches and the revisions', () => {
    expect([...allNamed(named())].sort()).toEqual(['b1', 'b2', 'main', 'record', 'revision']);
  });
});
// ci-replay touch
