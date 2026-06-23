// Unit tests for the framer-clone permission vocabulary and the fail-closed
// can()/requirePermission helpers in src/lib/permissions.ts.
//
// The auth-brain SDK client is mocked so these tests assert the MAPPING and the
// FAIL-CLOSED contract without any network:
//   - each framer action maps to the correct workspace.<role> requirement
//   - can() returns the client's boolean on success
//   - can() returns false on ANY thrown OpenFGA error (fail-closed)
//   - requirePermission throws PermissionDeniedError on a deny

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted mock: a single fake `can` we can re-program per test. The real client
// would reach OpenFGA over the network; we never want that in a unit test.
const mockCan = vi.fn();
vi.mock('@/lib/auth-brain', () => ({
  authBrainClient: {
    can: (...args: unknown[]) => mockCan(...args),
    verifySession: vi.fn(),
    verifyApiKey: vi.fn(),
    getCurrentUser: vi.fn(),
  },
}));

import {
  FRAMER_PERMISSIONS,
  can,
  requirePermission,
  PermissionDeniedError,
} from '@/lib/permissions';

beforeEach(() => {
  mockCan.mockReset();
});

describe('FRAMER_PERMISSIONS vocabulary', () => {
  it('maps reads to workspace.viewer and every mutation to workspace.admin', () => {
    expect(FRAMER_PERMISSIONS.viewSite.requires).toBe('workspace.viewer');
    expect(FRAMER_PERMISSIONS.editSite.requires).toBe('workspace.admin');
    expect(FRAMER_PERMISSIONS.publishSite.requires).toBe('workspace.admin');
    expect(FRAMER_PERMISSIONS.manageDomain.requires).toBe('workspace.admin');
  });

  it('carries a human description for every action', () => {
    for (const def of Object.values(FRAMER_PERMISSIONS)) {
      expect(typeof def.description).toBe('string');
      expect(def.description!.length).toBeGreaterThan(0);
    }
  });
});

describe('can()', () => {
  it('forwards the mapped requirement + workspace resource to the SDK', async () => {
    mockCan.mockResolvedValue(true);

    const allowed = await can('user-1', 'editSite', 'ws-42');

    expect(allowed).toBe(true);
    expect(mockCan).toHaveBeenCalledWith('user-1', 'workspace.admin', {
      type: 'workspace',
      id: 'ws-42',
      workspaceId: 'ws-42',
    });
  });

  it('returns the SDK boolean when the relation is absent (deny)', async () => {
    mockCan.mockResolvedValue(false);
    expect(await can('user-1', 'viewSite', 'ws-42')).toBe(false);
  });

  it('fails CLOSED: any thrown OpenFGA error becomes a deny', async () => {
    mockCan.mockRejectedValue(new Error('openfga unreachable'));
    expect(await can('user-1', 'publishSite', 'ws-42')).toBe(false);
  });
});

describe('requirePermission()', () => {
  it('resolves when the SDK allows the action', async () => {
    mockCan.mockResolvedValue(true);
    await expect(requirePermission('user-1', 'editSite', 'ws-42')).resolves.toBeUndefined();
  });

  it('throws PermissionDeniedError when the action is denied', async () => {
    mockCan.mockResolvedValue(false);
    await expect(requirePermission('user-1', 'editSite', 'ws-42')).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
  });
});
