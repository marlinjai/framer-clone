// What the endpoint's tests give the branch operations (src/server/siteOps/branches.ts) when a test is not
// about branches: the switch off, and every site id a main site, so publish and rollback pass their
// "is this a branch" check without a database.

import type { BranchOpsDeps } from '@/server/siteOps/branches';

const unused = async (): Promise<never> => {
  throw new Error('a test without branches called a branch operation');
};

export const NO_BRANCHES: BranchOpsDeps = {
  enabled: () => false,
  branches: {
    siteBranchContext: async (_scope, siteId) => ({ kind: 'main', siteId, openBranches: 0 }),
    listBranches: unused,
    createBranch: unused,
    setBranchReady: unused,
    discardBranch: unused,
  },
  merges: { changes: unused, update: unused, merge: unused },
  audit: async () => {},
};
