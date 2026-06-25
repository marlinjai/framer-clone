import { describe, it, expect, vi } from 'vitest';

// The 40 DatabaseAdapter methods backed by a server action (everything except
// `transaction`, which the adapter runs locally). Mocking the actions module
// here means the real server-only / Prisma chain never loads in the test, and
// each action becomes a distinct spy we can assert identity against.
const ACTION_NAMES = [
  'createTable', 'getTable', 'updateTable', 'deleteTable', 'listTables',
  'createColumn', 'getColumns', 'getColumn', 'updateColumn', 'deleteColumn', 'reorderColumns',
  'createSelectOption', 'getSelectOptions', 'updateSelectOption', 'deleteSelectOption', 'reorderSelectOptions',
  'createRow', 'getRow', 'getRows', 'updateRow', 'deleteRow', 'archiveRow', 'unarchiveRow',
  'bulkCreateRows', 'bulkDeleteRows', 'bulkArchiveRows',
  'createRelation', 'deleteRelation', 'getRelatedRows', 'getRelationsForRow',
  'addFileReference', 'removeFileReference', 'getFileReferences', 'reorderFileReferences',
  'createView', 'getViews', 'getView', 'updateView', 'deleteView', 'reorderViews',
] as const;

vi.mock('@/server/cms/actions', () => {
  const mod: Record<string, unknown> = {};
  for (const name of [
    'createTable', 'getTable', 'updateTable', 'deleteTable', 'listTables',
    'createColumn', 'getColumns', 'getColumn', 'updateColumn', 'deleteColumn', 'reorderColumns',
    'createSelectOption', 'getSelectOptions', 'updateSelectOption', 'deleteSelectOption', 'reorderSelectOptions',
    'createRow', 'getRow', 'getRows', 'updateRow', 'deleteRow', 'archiveRow', 'unarchiveRow',
    'bulkCreateRows', 'bulkDeleteRows', 'bulkArchiveRows',
    'createRelation', 'deleteRelation', 'getRelatedRows', 'getRelationsForRow',
    'addFileReference', 'removeFileReference', 'getFileReferences', 'reorderFileReferences',
    'createView', 'getViews', 'getView', 'updateView', 'deleteView', 'reorderViews',
  ]) {
    mod[name] = vi.fn().mockResolvedValue(undefined);
  }
  return mod;
});

import * as actions from '@/server/cms/actions';
import { createCmsServerActionsAdapter } from '../cmsServerActionsAdapter';

describe('createCmsServerActionsAdapter', () => {
  it('wires every one of the 40 DatabaseAdapter methods to its matching server action (no cross-wiring)', () => {
    const adapter = createCmsServerActionsAdapter() as unknown as Record<string, unknown>;
    const actionsMod = actions as unknown as Record<string, unknown>;

    // Guard against a method silently going missing or being added without a wire.
    expect(Object.keys(actionsMod).sort()).toEqual([...ACTION_NAMES].sort());

    for (const name of ACTION_NAMES) {
      expect(adapter[name]).toBe(actionsMod[name]);
    }
  });

  it('runs transaction locally as fn(adapter) (the CMS PrismaAdapter transaction is itself a no-op)', async () => {
    const adapter = createCmsServerActionsAdapter();
    const fn = vi.fn().mockResolvedValue('done');

    const result = await adapter.transaction(fn);

    expect(result).toBe('done');
    expect(fn).toHaveBeenCalledWith(adapter);
  });
});
