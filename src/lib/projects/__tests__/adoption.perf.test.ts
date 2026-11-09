// Adoption cost (ROADMAP: "the first adoption in an open editor is slow"; review
// perf P1 to P3). Measures, on a realistic site in Node, what one adopted agent
// write costs the open editor: the time of each phase of adoptServerCopy (through
// its measurement hook), the serialisation LiveSync's clean check adds, and the
// patches the reconcile emits, which is what reaches autosave's onPatch, the undo
// entry and every observer of the changed values (a node whose props object is
// replaced re-renders on the canvas). Counts are asserted; times are logged only
// (machines differ), set ADOPTION_PERF_LOG=1 to print them.
//
// It cannot measure the canvas render after an adoption (no DOM here); fewer
// replaced values is the argument for that half.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runInAction } from 'mobx';
import { getSnapshot, onPatch } from 'mobx-state-tree';
import { createRootStore, getHistoryStore, type RootStoreType } from '@/stores/RootStore';
import ProjectModel, { type ProjectModelType, type ProjectSnapshotOut } from '@/models/ProjectModel';
import { applyOperations } from '@/lib/siteOps/applyOps';
import {
  adoptServerCopy,
  isSaved,
  openProject,
  setAdoptionProfilerForTests,
  type ProjectContent,
} from '@/stores/openProject';

const SITE = 'site_perf';
const PAGES = 4;
const SECTIONS = 8;
const CARDS = 3;

/** A site of about 400 nodes over four pages, with a reusable component placed on each. */
async function bigSite(): Promise<ProjectSnapshotOut> {
  const p = ProjectModel.create({ id: SITE, metadata: { title: 'Perf', description: '' }, pages: {} }) as ProjectModelType;
  const pages = Array.from({ length: PAGES }, (_, i) => p.createPage(i === 0 ? 'Home' : `Page ${i}`));
  pages[0].setSlug('');
  for (const page of pages) {
    const nodes = Array.from({ length: SECTIONS }, (_, s) => ({
      type: 'section',
      props: { style: { padding: '48px', display: 'flex', flexDirection: 'column', gap: '16px' } },
      children: [
        { type: 'h2', props: { children: `Section ${s} heading`, style: { fontSize: '32px' } } },
        { type: 'p', props: { children: `Section ${s} lead text that runs a little longer, like real copy does.` } },
        {
          type: 'div',
          props: { style: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '24px' } },
          children: Array.from({ length: CARDS }, (_, c) => ({
            type: 'div',
            props: { style: { padding: '24px', borderRadius: '12px' } },
            children: [
              { type: 'h3', props: { children: `Card ${c}` } },
              { type: 'p', props: { children: `Card ${c} body text.` } },
            ],
          })),
        },
      ],
    }));
    const outcome = await applyOperations(p, [{ op: 'insertNodes', pageId: page.id, nodes }]);
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.rejected));
  }
  // A reusable component from the first section of the home page, placed on every page.
  const home = pages[0];
  const firstSection = (home.appComponentTree.children[0] as { id: string }).id;
  const made = p.createComponentFromSelection(home.id, [firstSection], 'Feature block');
  if (!made.ok) throw new Error('component');
  return wire(getSnapshot(p) as ProjectSnapshotOut);
}

/** The server's copy after an agent's batch. */
async function serverAfter(from: ProjectSnapshotOut, ops: unknown[]): Promise<ProjectSnapshotOut> {
  const model = ProjectModel.create(from) as ProjectModelType;
  const outcome = await applyOperations(model, ops);
  if (!outcome.ok) throw new Error(JSON.stringify(outcome.rejected));
  return wire(getSnapshot(model) as ProjectSnapshotOut);
}

/** As the snapshot route delivers it: parsed JSON, sharing no object with any copy in memory. */
function wire(snapshot: ProjectSnapshotOut): ProjectSnapshotOut {
  return JSON.parse(JSON.stringify(snapshot)) as ProjectSnapshotOut;
}

interface Measured {
  ms: number;
  phases: Record<string, number>;
  /** The clean check LiveSync.take runs before adopting (one serialisation of the working copy). */
  cleanCheckMs: number;
  patches: number;
  historyPatches: number;
  /** Nodes of the open copy whose props object was replaced (each re-renders on the canvas). */
  replacedProps: number;
}

let store: RootStoreType;
let phases: Record<string, number>;

beforeEach(() => {
  store = createRootStore();
  phases = {};
  setAdoptionProfilerForTests((phase, ms) => {
    phases[phase] = (phases[phase] ?? 0) + ms;
  });
});

afterEach(() => {
  setAdoptionProfilerForTests(undefined);
});

const project = () => store.projectStore.getProject(SITE) as ProjectModelType;

function propsById(): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const visit = (node: { id: string; props: unknown; children?: unknown[] }) => {
    out.set(node.id, node.props);
    for (const child of (node.children ?? []) as Array<typeof node>) visit(child);
  };
  for (const page of project().pagesArray) {
    visit(page.appComponentTree as never);
    for (const node of page.canvasNodes.values()) visit(node as never);
  }
  return out;
}

function adopt(snapshot: ProjectSnapshotOut, version: number): Measured {
  phases = {};
  const beforeProps = propsById();
  let patches = 0;
  const stop = onPatch(project(), () => {
    patches++;
  });
  const t0 = performance.now();
  isSaved(SITE, getSnapshot(project()) as unknown as ProjectContent);
  const cleanCheckMs = performance.now() - t0;
  const t1 = performance.now();
  // As LiveSync.adopt calls it: inside one action.
  const out = runInAction(() => adoptServerCopy(store, snapshot, version, 'Agent'));
  const ms = performance.now() - t1;
  stop();
  if (!out) throw new Error('not adopted');
  const afterProps = propsById();
  let replacedProps = 0;
  for (const [id, props] of afterProps) if (beforeProps.has(id) && beforeProps.get(id) !== props) replacedProps++;
  const history = getHistoryStore()!;
  const last = out.recorded ? history.history.at(-1) : undefined;
  return { ms, phases: { ...phases }, cleanCheckMs, patches, historyPatches: last?.patches.length ?? 0, replacedProps };
}

function log(name: string, m: Measured) {
  if (!process.env.ADOPTION_PERF_LOG) return;
  const round = (n: number) => Math.round(n * 10) / 10;
  const detail = Object.entries(m.phases).map(([k, v]) => `${k} ${round(v)}`).join(', ');
  process.stderr.write(
    `[adoption] ${name}: ${round(m.ms)} ms (clean check ${round(m.cleanCheckMs)} ms; ${detail}); ` +
      `onPatch ${m.patches}, undo entry ${m.historyPatches} patches, props replaced on ${m.replacedProps} nodes\n`,
  );
}

describe('adoption cost on a site of about 400 nodes', () => {
  it('one changed text node: a constant number of patches, and only that node re-renders', async () => {
    const v1 = await bigSite();
    openProject(store, v1, null, 1);
    const home = Object.values(v1.pages).find((p) => p.slug === '')!;
    const target = (home.appComponentTree.children![1] as { children: Array<{ id: string }> }).children[0].id;
    // The first adoption (cold) and three more, each changing one node's text.
    let snapshot = v1;
    const runs: Measured[] = [];
    for (let i = 0; i < 4; i++) {
      snapshot = await serverAfter(snapshot, [{ op: 'updateText', nodeId: target, text: `Edited ${i}` }]);
      const m = adopt(snapshot, i + 2);
      log(i === 0 ? 'first one-node change' : `one-node change ${i + 1}`, m);
      runs.push(m);
    }
    for (const m of runs) {
      expect(m.patches).toBeLessThanOrEqual(2);
      expect(m.historyPatches).toBeLessThanOrEqual(2);
      expect(m.replacedProps).toBe(1);
    }
  });

  it('an identical copy at a newer version (a description-only write): no patch and no undo step', async () => {
    const v1 = await bigSite();
    openProject(store, v1, null, 1);
    const m = adopt(wire(v1), 2);
    log('identical copy', m);
    expect(m.patches).toBe(0);
    expect(m.historyPatches).toBe(0);
    expect(m.replacedProps).toBe(0);
  });

  it('one page deleted: patches only for that page', async () => {
    const v1 = await bigSite();
    openProject(store, v1, null, 1);
    const last = Object.values(v1.pages).find((p) => p.metadata.title === `Page ${PAGES - 1}`)!;
    const v2 = await serverAfter(v1, [{ op: 'deletePage', pageId: last.id }]);
    const m = adopt(v2, 2);
    log('one page deleted', m);
    expect(m.patches).toBeLessThanOrEqual(2);
    expect(m.replacedProps).toBe(0);
  });

  it('an agent inserts a section: patches for the insert only', async () => {
    const v1 = await bigSite();
    openProject(store, v1, null, 1);
    const home = Object.values(v1.pages).find((p) => p.slug === '')!;
    const v2 = await serverAfter(v1, [
      { op: 'insertNodes', pageId: home.id, nodes: [{ type: 'section', children: [{ type: 'h2', props: { children: 'New' } }] }] },
    ]);
    const m = adopt(v2, 2);
    log('one section inserted', m);
    expect(m.patches).toBeLessThanOrEqual(3);
    expect(m.replacedProps).toBe(0);
  });
});
