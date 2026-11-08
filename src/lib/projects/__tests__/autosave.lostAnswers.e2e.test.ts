// Lost answers end to end (fifth review): the REAL autosave controller writing
// through the REAL SiteRepository, against a database stand-in that keeps one
// site row, and a network that commits a write but loses its answer. Two lost
// answers in a row must not end in a false "changed elsewhere"; a write by
// someone else, or by an older container that does not know the key, must.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getSnapshot } from 'mobx-state-tree';
import { createRootStore, type RootStoreType } from '@/stores/RootStore';
import ProjectModel, { type ProjectSnapshotOut } from '@/models/ProjectModel';
import { knownServerVersion, openProject } from '@/stores/openProject';
import { SiteRepository, type TenantScope } from '@/server/sites/repository';
import { SiteChangedError } from '@/server/sites/errors';
import type { ProjectWriteResult } from '../projectWrite';
import { AUTOSAVE_BACKOFF_MS, AUTOSAVE_DEBOUNCE_MS, autosaveFor, resetAutosaveForTests, type AutosaveWriteOptions } from '../autosave';

const SCOPE: TenantScope = { workspaceId: 'ws_e2e', tenantGroupId: 'tg_e2e' };

interface Row {
  id: string;
  workspaceId: string;
  erasureEpoch: number;
  version: number;
  lastWriteKey: string | null;
  lastWriteVersion: number | null;
  description: string;
  redirects: unknown[];
  siteSettings: Record<string, unknown>;
  status: string;
  publishedRevisionId: string | null;
}

let row: Row;
/** The database stand-in: one site row, its pages ignored. */
function database() {
  const prisma = {
    $queryRaw: async () => [],
    site: {
      findUnique: async () => ({ ...row }),
      findFirst: async () => ({ version: row.version }),
      updateMany: async ({ where, data }: { where: { version?: number }; data: Partial<Row> }) => {
        if (where.version !== undefined && where.version !== row.version) return { count: 0 };
        for (const key of ['version', 'lastWriteKey', 'lastWriteVersion', 'description'] as const) {
          if (key in data) (row as unknown as Record<string, unknown>)[key] = data[key];
        }
        return { count: 1 };
      },
    },
    sitePage: { findMany: async () => [], upsert: async () => ({}), deleteMany: async () => ({ count: 0 }) },
    siteDomain: { findFirst: async () => null },
    siteImage: { findMany: async () => [] },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
  };
  return prisma;
}

let store: RootStoreType;
let repo: SiteRepository;
/** Answers to lose: the write commits, the client hears a 502. */
let lose = 0;
let sends = 0;

async function write(snapshot: unknown, expectedVersion: number | undefined, options: AutosaveWriteOptions): Promise<ProjectWriteResult> {
  sends++;
  try {
    const { version } = await repo.saveProject(SCOPE, snapshot as ProjectSnapshotOut, {
      mustExist: true,
      expectedVersion,
      requestKey: options.requestKey,
      ...(options.previousRequestKeys ? { previousRequestKeys: options.previousRequestKeys } : {}),
    });
    if (lose > 0) {
      lose--;
      return { kind: 'error', status: 502, message: 'Bad gateway.' };
    }
    return { kind: 'ok', version, payload: { version } };
  } catch (err) {
    if (err instanceof SiteChangedError) return { kind: 'conflict', currentVersion: err.currentVersion };
    throw err;
  }
}

function open(id: string) {
  const p = ProjectModel.create({ id, metadata: { title: 'Site', description: '' }, pages: {} });
  p.createPage('Home').setSlug('');
  const project = openProject(store, getSnapshot(p) as ProjectSnapshotOut, null, 4).project!;
  const autosave = autosaveFor(id);
  autosave.attach(project);
  return { project, autosave };
}

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers();
  lose = 0;
  sends = 0;
  row = {
    id: 'site_e2e',
    workspaceId: SCOPE.workspaceId,
    erasureEpoch: 0,
    version: 4,
    lastWriteKey: null,
    lastWriteVersion: null,
    description: '',
    redirects: [],
    siteSettings: {},
    status: 'draft',
    publishedRevisionId: null,
  };
  repo = new SiteRepository(database() as never);
  resetAutosaveForTests({ write });
  store = createRootStore();
});
afterEach(() => {
  resetAutosaveForTests();
  vi.useRealTimers();
});

describe('lost answers, client and repository together', () => {
  it('two lost answers in a row, then the retry: saved, on the version this tab wrote, no conflict', async () => {
    const { project, autosave } = open('site_e2e');
    lose = 2;
    project.updateMetadata({ description: 'A' });
    await advance(AUTOSAVE_DEBOUNCE_MS); // A writes 5, answer lost
    expect(row.version).toBe(5);
    project.updateMetadata({ description: 'B' });
    await advance(AUTOSAVE_BACKOFF_MS[0]); // B builds on A: 6, answer lost
    expect(row.version).toBe(6);
    await advance(AUTOSAVE_BACKOFF_MS[1]); // B's retry: replayed
    expect(row.version).toBe(6);
    expect(autosave.getState().phase).toBe('saved');
    expect(knownServerVersion('site_e2e')).toBe(6);
    project.updateMetadata({ description: 'C' });
    await advance(AUTOSAVE_DEBOUNCE_MS);
    expect(row).toMatchObject({ version: 7, description: 'C' });
    expect(autosave.getState().phase).toBe('saved');
    expect(sends).toBe(4);
  });

  it('newer content after two lost answers builds on the latest of them', async () => {
    const { project, autosave } = open('site_e2e');
    lose = 2;
    project.updateMetadata({ description: 'A' });
    await advance(AUTOSAVE_DEBOUNCE_MS);
    project.updateMetadata({ description: 'B' });
    await advance(AUTOSAVE_BACKOFF_MS[0]);
    project.updateMetadata({ description: 'C' });
    await advance(AUTOSAVE_BACKOFF_MS[1]); // C names A and B; B is the latest write
    expect(row).toMatchObject({ version: 7, description: 'C' });
    expect(autosave.getState().phase).toBe('saved');
  });

  it('a write by someone else in between is still "changed elsewhere"', async () => {
    const { project, autosave } = open('site_e2e');
    lose = 1;
    project.updateMetadata({ description: 'A' });
    await advance(AUTOSAVE_DEBOUNCE_MS); // A writes 5, lost
    // An agent writes 6 (a writer of today clears the key).
    row = { ...row, version: 6, lastWriteKey: null, lastWriteVersion: null, description: 'agent' };
    project.updateMetadata({ description: 'B' });
    await advance(AUTOSAVE_BACKOFF_MS[0]);
    expect(autosave.getState()).toMatchObject({ phase: 'conflict', currentVersion: 6 });
    expect(row.description).toBe('agent');
  });

  it('a stale key after an older container wrote (it moved the version, left the key) is "changed elsewhere"', async () => {
    const { project, autosave } = open('site_e2e');
    lose = 1;
    project.updateMetadata({ description: 'A' });
    await advance(AUTOSAVE_DEBOUNCE_MS); // A writes 5 with its key, lost
    row = { ...row, version: 6, description: 'old container' }; // key and its version untouched
    await advance(AUTOSAVE_BACKOFF_MS[0]); // A's retry: same key, but the key is no longer bound to 6
    expect(autosave.getState()).toMatchObject({ phase: 'conflict', currentVersion: 6 });
    expect(row.description).toBe('old container');
  });
});
