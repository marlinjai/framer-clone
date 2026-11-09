// The audit rows that back the editor's activity feed after a reload
// (src/server/siteOps/audit.ts): ids the write created travel in the row's
// detail, not in `ops`, so the line's change count stays the batch's.

import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { recentSiteOperations, recordSiteOperation } from '../audit';

const scope = { tenantGroupId: 't', workspaceId: 'w' } as never;
const caller = { scope, actor: { kind: 'key', id: 'k1' }, actorLabel: 'Claude', liveCallId: '11111111-1111-4111-8111-111111111111' } as never;

describe('created ids in the audit row', () => {
  it('are stored apart from the ops and come back as the line\'s nodes and page', async () => {
    const rows: Array<Record<string, unknown>> = [];
    const prisma = {
      siteOperationAudit: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          rows.push({ id: 'r1', createdAt: new Date('2026-11-08T12:00:00Z'), ...data });
        }),
        findMany: vi.fn(async () => rows),
      },
    } as never;
    await recordSiteOperation(prisma, caller, {
      siteId: 's1',
      operation: 'batch',
      ops: [{ op: 'createPage' }, { op: 'insertNodes' }],
      created: { nodeIds: ['n-new'], pageIds: ['p-new'] },
    });
    const [line] = await recentSiteOperations(prisma, scope, 's1');
    expect(line).toMatchObject({ tool: 'apply_batch', nodeIds: ['n-new'], pageId: 'p-new', changes: 2 });
    expect(rows[0].ops).toEqual([{ op: 'createPage' }, { op: 'insertNodes' }]);
  });
});

describe('deleted pages in the audit row', () => {
  it('come back as the line\'s deleted page ids, ids only, never the stored title', async () => {
    const rows: Array<Record<string, unknown>> = [];
    const prisma = {
      siteOperationAudit: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          rows.push({ id: 'r1', createdAt: new Date('2026-11-08T12:00:00Z'), ...data });
        }),
        findMany: vi.fn(async () => rows),
      },
    } as never;
    await recordSiteOperation(prisma, caller, {
      siteId: 's1',
      operation: 'batch',
      ops: [{ op: 'updateText', nodeId: 'n1' }, { op: 'deletePage', pageId: 'p-about', slug: 'about', title: 'About us' }],
    });
    const [line] = await recentSiteOperations(prisma, scope, 's1');
    expect(line).toMatchObject({ tool: 'apply_batch', changes: 2, deletedPageIds: ['p-about'] });
    expect(JSON.stringify(line)).not.toContain('About us');
  });

  it('are absent from a batch that deleted nothing', async () => {
    const rows = [{ id: 'r1', createdAt: new Date(), actorKind: 'key', actorId: 'k1', actorDetail: {}, operation: 'batch', ops: [{ op: 'updateText', nodeId: 'n1' }] }];
    const prisma = { siteOperationAudit: { findMany: vi.fn(async () => rows) } } as never;
    const [line] = await recentSiteOperations(prisma, scope, 's1');
    expect(line).not.toHaveProperty('deletedPageIds');
  });
});
