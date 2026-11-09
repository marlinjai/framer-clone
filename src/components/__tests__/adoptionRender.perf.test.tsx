// The canvas half of an adoption's cost (ROADMAP: "the first adoption in an open
// editor is slow"; review perf P1). Renders the home page of a site of about 400
// nodes with the real ComponentRenderer inside a React Profiler, adopts an agent's
// one-node change, and compares the time React spent re-rendering in that commit
// (actualDuration) with the time the whole tree takes to render (baseDuration).
// When every node's props were replaced, every node's observer re-rendered; with
// structural sharing only the changed node and its ancestors do. Asserted loosely
// (under a fifth of the tree), logged with ADOPTION_PERF_LOG=1.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { runInAction } from 'mobx';
import { getSnapshot } from 'mobx-state-tree';
import { createRootStore, type RootStoreType } from '@/stores/RootStore';
import ProjectModel, { type ProjectModelType, type ProjectSnapshotOut } from '@/models/ProjectModel';
import type { ComponentInstance } from '@/models/ComponentModel';
import { applyOperations } from '@/lib/siteOps/applyOps';
import { adoptServerCopy, openProject } from '@/stores/openProject';
import ComponentRenderer from '../ComponentRenderer';

let store: RootStoreType;
vi.mock('@/hooks/useStore', () => ({ useStore: () => store }));

const SITE = 'site_render_perf';

async function site(): Promise<ProjectSnapshotOut> {
  const p = ProjectModel.create({ id: SITE, metadata: { title: 'Perf', description: '' }, pages: {} }) as ProjectModelType;
  const home = p.createPage('Home');
  home.setSlug('');
  const nodes = Array.from({ length: 24 }, (_, s) => ({
    type: 'section',
    children: [
      { type: 'h2', props: { children: `Section ${s}` } },
      { type: 'p', props: { children: `Lead ${s}` } },
      { type: 'div', children: Array.from({ length: 3 }, (_, c) => ({ type: 'div', children: [{ type: 'h3', props: { children: `Card ${c}` } }, { type: 'p', props: { children: 'Body' } }] })) },
    ],
  }));
  for (let i = 0; i < nodes.length; i += 8) {
    const outcome = await applyOperations(p, [{ op: 'insertNodes', pageId: home.id, nodes: nodes.slice(i, i + 8) }]);
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.rejected));
  }
  return JSON.parse(JSON.stringify(getSnapshot(p))) as ProjectSnapshotOut;
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  store = createRootStore();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the canvas after an adopted one-node change', () => {
  it('re-renders a small share of the page, not the whole tree', async () => {
    const v1 = await site();
    openProject(store, v1, null, 1);
    const page = store.editorUI.currentPage!;
    const root = page.appComponentTree as ComponentInstance;
    const breakpoints = page.sortedViewportNodes.map((v) => ({ id: v.breakpointId!, minWidth: v.breakpointMinWidth ?? 0 }));
    const commits: Array<{ actual: number; base: number }> = [];
    render(
      <React.Profiler id="canvas" onRender={(_id, _phase, actual, base) => commits.push({ actual, base })}>
        <ComponentRenderer component={root} breakpointId={breakpoints[0].id} allBreakpoints={breakpoints} />
      </React.Profiler>,
    );
    const target = ((v1.pages[page.id].appComponentTree.children![5] as { children: Array<{ id: string }> }).children[0]).id;
    // Three adoptions: the first is asserted on its own (a first adoption that re-rendered the whole tree must
    // not hide behind cheap later ones), and the best of the three too, so one pause of the runner does not decide a ratio.
    let snapshot = v1;
    let actual = Number.POSITIVE_INFINITY;
    let first = Number.NaN;
    let base = commits[0].base;
    let renders = 0;
    for (let i = 0; i < 3; i++) {
      const model = ProjectModel.create(snapshot) as ProjectModelType;
      const outcome = await applyOperations(model, [{ op: 'updateText', nodeId: target, text: `Edited ${i}` }]);
      if (!outcome.ok) throw new Error('refused');
      snapshot = JSON.parse(JSON.stringify(getSnapshot(model))) as ProjectSnapshotOut;
      const before = commits.length;
      // As LiveSync.adopt calls it: inside one action.
      act(() => {
        runInAction(() => adoptServerCopy(store, snapshot, i + 2, 'Agent'));
      });
      const adoption = commits.slice(before);
      renders = adoption.length;
      const cost = adoption.reduce((sum, c) => sum + c.actual, 0);
      if (i === 0) first = cost;
      actual = Math.min(actual, cost);
      base = Math.max(base, ...adoption.map((c) => c.base));
    }
    const adoption = { length: renders };
    if (process.env.ADOPTION_PERF_LOG) {
      process.stderr.write(`[adoption render] ${adoption.length} commit(s), re-rendered ${actual.toFixed(1)} ms of a ${base.toFixed(1)} ms tree (${((actual / base) * 100).toFixed(0)}%), the first adoption ${first.toFixed(1)} ms\n`);
    }
    expect(document.body.textContent).toContain('Edited 2');
    // origin/main before the structural sharing: 29% (every node observer re-rendered); now about 1%.
    // A timing ratio: a margin wide enough for a loaded runner, still far from the 29% before.
    expect(first).toBeLessThan(base * 0.2);
    expect(actual).toBeLessThan(base * 0.2);
  });
});
