// The draft store (../draft.ts): keyed to its run, one tree per section index,
// detached from any project, and its breakpoint keys mapped to real ids.

import { describe, expect, it } from 'vitest';
import { hasParent } from 'mobx-state-tree';
import { PageGenDraftStore, buildDraftTree, draftTargetFor, type PageGenDraftTarget } from '../draft';
import type { PageGenSection } from '../protocol';
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

function section(index: number, label = `S${index}`): PageGenSection {
  const out = validateGeneration(
    { nodes: [{ type: 'section', label, props: { style: { padding: { base: '64px', mobile: '24px' } } } }] },
    { breakpoints: deriveBreakpointKeys(CAPTURED.breakpoints) },
  );
  if (!out.ok) throw new Error(out.errors.join('; '));
  return { generationId: 'g', index, attempt: 1, node: out.result.nodes[0] };
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
