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
import { CmsActionError } from '@/lib/cms/actionResult';
import { createCmsServerActionsAdapter } from '../cmsServerActionsAdapter';

// Every action, read or write, is guarded and returns a CmsActionResult the
// adapter unwraps (reads used to be wired straight through, unauthenticated).
describe('createCmsServerActionsAdapter', () => {
  it('wires every one of the 40 DatabaseAdapter methods to its matching server action (no cross-wiring)', () => {
    const adapter = createCmsServerActionsAdapter() as unknown as Record<string, unknown>;
    const actionsMod = actions as unknown as Record<string, unknown>;

    // Guard against a method silently going missing or being added without a wire.
    expect(Object.keys(actionsMod).sort()).toEqual([...ACTION_NAMES].sort());

    for (const name of ACTION_NAMES) {
      expect(typeof adapter[name]).toBe('function');
      // A wrapper, never the raw action: the raw action returns a result object.
      expect(adapter[name]).not.toBe(actionsMod[name]);
    }
  });

  it('calls the matching action with the same arguments and unwraps its value', async () => {
    const adapter = createCmsServerActionsAdapter() as unknown as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >;
    const actionsMod = actions as unknown as Record<string, ReturnType<typeof vi.fn>>;
    for (const name of ACTION_NAMES) {
      actionsMod[name].mockResolvedValueOnce({ ok: true, value: `${name}-value` });
      await expect(adapter[name]('a', 'b', 'c')).resolves.toBe(`${name}-value`);
      // Each wrapper forwards its own arguments in order (1 to 3 of them).
      const forwarded = actionsMod[name].mock.lastCall!;
      expect(forwarded.length).toBeGreaterThan(0);
      expect(forwarded).toEqual(['a', 'b', 'c'].slice(0, forwarded.length));
    }
  });

  it('rethrows a failed READ on the client as a CmsActionError (a signed-out grid shows why)', async () => {
    const adapter = createCmsServerActionsAdapter();
    vi.mocked(actions.getRows).mockResolvedValueOnce({
      ok: false,
      code: 'unauthorized',
      message: 'Your session has expired. Sign in again to keep editing.',
    });
    const err = await adapter.getRows('t1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CmsActionError);
    expect((err as CmsActionError).code).toBe('unauthorized');
  });

  it('rethrows a failed result on the client as a CmsActionError with its code and message', async () => {
    const adapter = createCmsServerActionsAdapter();
    vi.mocked(actions.updateRow).mockResolvedValueOnce({
      ok: false,
      code: 'authz_unavailable',
      message: 'The permission service is temporarily unavailable, so the change was not saved.',
    });
    const err = await adapter.updateRow('r1', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CmsActionError);
    expect((err as CmsActionError).code).toBe('authz_unavailable');
    expect((err as CmsActionError).retryable).toBe(true);
    expect((err as CmsActionError).message).toMatch(/permission service/);
  });

  it('runs transaction locally as fn(adapter) (the CMS PrismaAdapter transaction is itself a no-op)', async () => {
    const adapter = createCmsServerActionsAdapter();
    const fn = vi.fn().mockResolvedValue('done');

    const result = await adapter.transaction(fn);

    expect(result).toBe('done');
    expect(fn).toHaveBeenCalledWith(adapter);
  });
});
