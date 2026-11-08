// The draft store (../draft.ts): keyed to its run, one tree per section index,
// detached from any project, and its breakpoint keys mapped to real ids; the
// outline's skeletons until each slot's section arrives.

import { describe, expect, it } from 'vitest';
import { hasParent } from 'mobx-state-tree';
import { PageGenDraftStore, buildDraftTree, draftTargetFor, type PageGenDraftTarget } from '../draft';
import type { PageGenOutline, PageGenSection } from '../protocol';
import type { CapturedTarget } from '../editorBridge';
import { validateGeneration } from '../validate';
import { deriveBreakpointKeys } from '../schema';

const CAPTURED: CapturedTarget = {
  kind: 'insert',
  pageId: 'page-1',
  componentId: 'root-1',
  breakpoints: [
    { id: 'bp-d', label: 'Desktop', minWidth: 1280 },
    { id: 'bp-m', label: 'Mobile', minWidth: 320 },
  ],
  viewports: [],
};

function target(requestKey = 'k1'): PageGenDraftTarget {
  return draftTargetFor({ requestKey, target: CAPTURED, rootId: 'root-1', siteLanguage: 'de' });
}

function section(index: number, label = `S${index}`, slot = index): PageGenSection {
  const out = validateGeneration(
    { nodes: [{ type: 'section', label, props: { style: { padding: { base: '64px', mobile: '24px' } } } }] },
    { breakpoints: deriveBreakpointKeys(CAPTURED.breakpoints) },
  );
  if (!out.ok) throw new Error(out.errors.join('; '));
  return { generationId: 'g', index, slot, attempt: 1, node: out.result.nodes[0] };
}

describe('draftTargetFor', () => {
  it('freezes the captured target, the page title and the shop locale', () => {
    expect(target()).toMatchObject({ kind: 'insert', pageId: 'page-1', componentId: 'root-1', targetIsRoot: true, title: 'New page', locale: 'de' });
    expect(draftTargetFor({ requestKey: 'k', target: { ...CAPTURED, componentId: 'c-2' }, rootId: 'root-1', title: ' Menu ' })).toMatchObject({
      targetIsRoot: false,
      title: 'Menu',
      locale: 'en',
    });
  });
});

describe('buildDraftTree', () => {
  it('builds a detached tree keyed to the real breakpoint ids', () => {
    const tree = buildDraftTree(section(0), target())!;
    expect(hasParent(tree)).toBe(false);
    expect(tree.props.style.padding).toEqual({ base: '64px', 'bp-m': '24px' });
  });

  it('refuses a node the editor model would not take, without throwing', () => {
    const bad = { ...section(0), node: { id: 'x', type: 42 } as unknown as PageGenSection['node'] };
    expect(buildDraftTree(bad, target())).toBeUndefined();
  });
});

describe('PageGenDraftStore', () => {
  it('adds sections of its run in index order, once each', () => {
    const d = new PageGenDraftStore();
    d.begin(target());
    expect(d.add('k1', section(1))).toBe(true);
    expect(d.add('k1', section(0))).toBe(true);
    expect(d.add('k1', section(0, 'again'))).toBe(false);
    expect(d.sections.map((s) => s.tree.label)).toEqual(['S0', 'S1']);
  });

  it('drops a section of another run, a bad index, and anything before begin or after clear', () => {
    const d = new PageGenDraftStore();
    expect(d.add('k1', section(0))).toBe(false);
    d.begin(target());
    expect(d.add('k2', section(0))).toBe(false);
    expect(d.add('k1', { ...section(0), index: -1 })).toBe(false);
    expect(d.add('k1', { ...section(0), index: 1.5 })).toBe(false);
    d.clear('k2'); // not its run: kept
    expect(d.target).toBeDefined();
    d.clear('k1');
    expect(d.target).toBeUndefined();
    expect(d.add('k1', section(0))).toBe(false);
  });

  it('a new run replaces the old draft; the phase follows its own run only', () => {
    const d = new PageGenDraftStore();
    d.begin(target('k1'));
    d.add('k1', section(0));
    d.setPhase('k1', 'polishing');
    d.begin(target('k2'));
    expect(d.sections).toEqual([]);
    expect(d.phase).toBe('writing');
    d.setPhase('k1', 'checking');
    expect(d.phase).toBe('writing');
    expect(d.targetOn('page-1')?.requestKey).toBe('k2');
    expect(d.targetOn('page-2')).toBeUndefined();
  });
});

function outline(...entries: Array<[string, string]>): PageGenOutline {
  return { generationId: 'g', attempt: 1, outline: entries.map(([title, kind]) => ({ title, kind })) as PageGenOutline['outline'] };
}

describe('PageGenDraftStore outline', () => {
  const FOUR = outline(['Hero', 'hero'], ['Breads', 'features'], ['Story', 'generic'], ['Footer', 'footer']);

  it('forward: a skeleton per outline entry, and the section of slot i replaces skeleton i', () => {
    const d = new PageGenDraftStore();
    d.begin(target());
    expect(d.setOutline('k1', FOUR)).toBe(true);
    expect(d.skeletons.map((s) => [s.slot, s.title, s.kind])).toEqual([
      [0, 'Hero', 'hero'],
      [1, 'Breads', 'features'],
      [2, 'Story', 'generic'],
      [3, 'Footer', 'footer'],
    ]);
    d.add('k1', section(0));
    expect(d.skeletons.map((s) => s.slot)).toEqual([1, 2, 3]);
    d.add('k1', section(1));
    expect(d.items.map((i) => `${i.kind}:${i.slot}`)).toEqual(['section:0', 'section:1', 'skeleton:2', 'skeleton:3']);
  });

  it('a section that failed validation leaves its skeleton in place; the next section takes its own slot', () => {
    const d = new PageGenDraftStore();
    d.begin(target());
    d.setOutline('k1', FOUR);
    d.add('k1', section(0));
    // nodes[1] failed validation on the server: the next section sent is index 1, slot 2.
    d.add('k1', section(1, 'Story', 2));
    expect(d.items.map((i) => `${i.kind}:${i.slot}`)).toEqual(['section:0', 'skeleton:1', 'section:2', 'skeleton:3']);
  });

  it('an outline shorter than the sections: the sections past it appear as before', () => {
    const d = new PageGenDraftStore();
    d.begin(target());
    d.setOutline('k1', outline(['Hero', 'hero']));
    d.add('k1', section(0));
    d.add('k1', section(1));
    expect(d.skeletons).toEqual([]);
    expect(d.items.map((i) => `${i.kind}:${i.slot}`)).toEqual(['section:0', 'section:1']);
  });

  it('an outline longer than the sections: the extra skeletons stay until the draft is dropped', () => {
    const d = new PageGenDraftStore();
    d.begin(target());
    d.setOutline('k1', FOUR);
    d.add('k1', section(0));
    expect(d.skeletons).toHaveLength(3);
    // The result lands: the dialog drops the draft in the same action as the apply.
    d.clear('k1');
    expect(d.skeletons).toEqual([]);
    expect(d.outline).toEqual([]);
  });

  it('a growing outline replaces the earlier one; the same one again changes nothing', () => {
    const d = new PageGenDraftStore();
    d.begin(target());
    expect(d.setOutline('k1', outline(['Hero', 'hero']))).toBe(true);
    expect(d.setOutline('k1', outline(['Hero', 'hero'], ['', 'generic']))).toBe(true);
    expect(d.setOutline('k1', outline(['Hero', 'hero'], ['', 'generic']))).toBe(false);
    expect(d.skeletons).toHaveLength(2);
  });

  it('backtrack: a new run or a cancel drops the old outline; an outline of another run is ignored', () => {
    const d = new PageGenDraftStore();
    d.begin(target('k1'));
    d.setOutline('k1', FOUR);
    d.begin(target('k2'));
    expect(d.skeletons).toEqual([]);
    expect(d.setOutline('k1', FOUR)).toBe(false);
    expect(d.skeletons).toEqual([]);
    d.setOutline('k2', FOUR);
    d.clear('k2');
    expect(d.skeletons).toEqual([]);
    expect(d.setOutline('k2', FOUR)).toBe(false);
  });

  it('resume: the outline and the sections rebuild in either order, repeats included', () => {
    const a = new PageGenDraftStore();
    a.begin(target());
    a.add('k1', section(0));
    a.setOutline('k1', FOUR);
    const b = new PageGenDraftStore();
    b.begin(target());
    b.setOutline('k1', FOUR);
    b.add('k1', section(0));
    b.add('k1', section(0));
    b.setOutline('k1', FOUR);
    const shape = (d: PageGenDraftStore) => d.items.map((i) => `${i.kind}:${i.slot}`);
    expect(shape(a)).toEqual(['section:0', 'skeleton:1', 'skeleton:2', 'skeleton:3']);
    expect(shape(b)).toEqual(shape(a));
  });

  it('re-entry after a failure or a refusal: the dialog clears, nothing stays behind', () => {
    const d = new PageGenDraftStore();
    d.begin(target());
    d.setOutline('k1', FOUR);
    d.clear('k1');
    expect(d.target).toBeUndefined();
    expect(d.items).toEqual([]);
    // The next run starts clean.
    d.begin(target('k2'));
    expect(d.items).toEqual([]);
  });

  it('sanitises the entries again, whatever sent them, and refuses a payload without an outline array', () => {
    const d = new PageGenDraftStore();
    d.begin(target());
    expect(d.setOutline('k1', { generationId: 'g', attempt: 1, outline: [{ title: 'A\u202Eb', kind: 'evil' }] } as unknown as PageGenOutline)).toBe(true);
    expect(d.outline).toEqual([{ title: 'A b', kind: 'generic' }]);
    expect(d.setOutline('k1', { generationId: 'g', attempt: 1 } as unknown as PageGenOutline)).toBe(false);
    expect(d.setOutline('k1', null as unknown as PageGenOutline)).toBe(false);
  });

  it('a section the editor refuses leaves its skeleton', () => {
    const d = new PageGenDraftStore();
    d.begin(target());
    d.setOutline('k1', FOUR);
    const bad = { ...section(0), node: { id: 'x', type: 42 } as unknown as PageGenSection['node'] };
    expect(d.add('k1', bad)).toBe(false);
    expect(d.skeletons.map((s) => s.slot)).toEqual([0, 1, 2, 3]);
  });
});
