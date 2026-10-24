// The review against a REAL editor store: the tree it sends (breakpoint keys,
// not ids), applying operations as ONE undo step, refusing what no longer
// fits the live page, failing soft (nothing changed) and the guarded undo.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { unprotect } from 'mobx-state-tree';
import { createRootStore, getHistoryStore, type RootStoreType } from '@/stores/RootStore';
import type { ComponentInstance } from '@/models/ComponentModel';
import type { PageModelType } from '@/models/PageModel';
import { validateGeneration } from '@/lib/ai/pageGen/validate';
import { deriveBreakpointKeys } from '@/lib/ai/pageGen/schema';
import { applyResult, captureTarget } from '@/lib/ai/pageGen/editorBridge';
import { applyReviewOps, reviewBreakpoints, serializeForReview, undoReview } from '../editorReview';
import type { ReviewOp } from '../protocol';

let store: RootStoreType;
let page: PageModelType;

function find(id: string): ComponentInstance | undefined {
  const walk = (n: ComponentInstance): ComponentInstance | undefined => {
    if (n.id === id) return n;
    for (const c of n.children) {
      const hit = walk(c as ComponentInstance);
      if (hit) return hit;
    }
    return undefined;
  };
  return walk(page.appComponentTree as ComponentInstance);
}

function byLabel(label: string): ComponentInstance {
  const walk = (n: ComponentInstance): ComponentInstance | undefined => {
    if (n.label === label) return n;
    for (const c of n.children) {
      const hit = walk(c as ComponentInstance);
      if (hit) return hit;
    }
    return undefined;
  };
  const hit = walk(page.appComponentTree as ComponentInstance);
  if (!hit) throw new Error(`no node ${label}`);
  return hit;
}

beforeEach(() => {
  store = createRootStore();
  store.projectStore.createProject('Spoke');
  const project = store.projectStore.findProjectByTitle('Spoke')!;
  const home = project.createPage('Home');
  home.insertRegistryComponent('container', { kind: 'appTree' });
  store.editorUI.setCurrentProject(project);
  store.editorUI.setCurrentPage(home);
  const target = captureTarget('newPage', home, undefined);
  const breakpoints = deriveBreakpointKeys(target.breakpoints.map(({ label, minWidth }) => ({ label, minWidth })));
  const out = validateGeneration(
    {
      title: 'Spoke & Chain',
      nodes: [
        {
          type: 'section',
          label: 'Hero',
          props: { style: { padding: '96px 48px' } },
          children: [
            { type: 'h1', label: 'Headline', props: { children: 'Ride further', style: { fontSize: { desktop: '96px', mobile: '56px' } } } },
            { type: 'div', label: 'Card', children: [{ type: 'p', label: 'Copy', props: { children: 'Service in a day' } }] },
          ],
        },
      ],
    },
    { breakpoints },
  );
  if (!out.ok) throw new Error(out.errors.join('; '));
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { imageRequests, invalidImageQueries, ...result } = out.result;
  const applied = applyResult(project, target, {
    generationId: 'g1',
    model: 'claude-sonnet-5-5',
    ...result,
    images: { requested: 0, resolved: 0, fellBack: {}, credits: [] },
  });
  if (!applied.ok) throw new Error(applied.reason);
  page = project.getPage(applied.value.pageId)!;
  getHistoryStore()!.clear();
});

describe('serializeForReview', () => {
  it('keys responsive maps by breakpoint key, largest first, and keeps ids', () => {
    const bps = reviewBreakpoints(page);
    expect(bps.map((b) => b.key)).toEqual(['desktop', 'tablet', 'mobile']);
    const tree = serializeForReview(page, bps);
    const headline = byLabel('Headline');
    const hero = tree.children[0];
    const h1 = hero.children[0];
    expect(h1.id).toBe(headline.id);
    // The generator stores the largest breakpoint under its own key (the
    // legacy primary-id form the cascade still reads).
    expect(h1.props.style).toEqual({ fontSize: { desktop: '96px', mobile: '56px' } });
    expect(JSON.stringify(tree)).not.toContain(bps[2].id);
  });
});

describe('applyReviewOps', () => {
  it('applies style, text and removal as ONE history entry, desktop-first', () => {
    const headline = byLabel('Headline');
    const card = byLabel('Card');
    const cardId = card.id;
    const history = getHistoryStore()!;
    const ops: ReviewOp[] = [
      { op: 'update_style', nodeId: headline.id, breakpoint: null, property: 'fontSize', value: '80px', reason: 'smaller' },
      { op: 'update_style', nodeId: headline.id, breakpoint: 'mobile', property: 'fontSize', value: '44px', reason: 'phone' },
      { op: 'update_style', nodeId: headline.id, breakpoint: 'tablet', property: 'lineHeight', value: 1.05, reason: 'tight' },
      { op: 'update_text', nodeId: byLabel('Copy').id, text: 'Same-day service', reason: 'shorter' },
      { op: 'remove_node', nodeId: cardId, reason: 'decorative' },
    ];
    // The copy lives inside the card: removing the card after editing it is fine.
    const out = applyReviewOps(page, ops);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.applied).toHaveLength(5);
    expect(history.history.length).toBe(1);
    expect(history.history[0].actionName).toBe('AI review');
    expect(out.historyEntryId).toBe(history.history[0].id);

    const bps = reviewBreakpoints(page);
    const style = headline.props.style as Record<string, unknown>;
    expect(style.fontSize).toEqual({ base: '80px', [bps[2].id]: '44px' });
    expect(style.lineHeight).toEqual({ [bps[1].id]: 1.05 });
    expect(find(cardId)).toBeUndefined();

    history.undo();
    expect((headline.props.style as Record<string, unknown>).fontSize).toEqual({ [bps[0].id]: '96px', [bps[2].id]: '56px' });
    expect(find(cardId)).toBeDefined();
  });

  it('a null value removes an override so the breakpoint inherits again', () => {
    const headline = byLabel('Headline');
    const out = applyReviewOps(page, [
      { op: 'update_style', nodeId: headline.id, breakpoint: 'mobile', property: 'fontSize', value: null, reason: 'inherit' },
    ]);
    expect(out.ok).toBe(true);
    const bps = reviewBreakpoints(page);
    expect((headline.props.style as Record<string, unknown>).fontSize).toEqual({ [bps[0].id]: '96px' });
  });

  it('refuses operations that no longer fit the live page, applies the rest', () => {
    const headline = byLabel('Headline');
    const out = applyReviewOps(page, [
      { op: 'update_style', nodeId: 'deleted-meanwhile', breakpoint: null, property: 'color', value: 'red', reason: 'r' },
      { op: 'update_style', nodeId: headline.id, breakpoint: null, property: 'color', value: '#1a1a1a', reason: 'r' },
    ]);
    expect(out.ok && out.applied.length).toBe(1);
    expect(out.ok && out.rejected[0].reason).toMatch(/unknown node id/);
  });

  it('nothing valid: no history entry', () => {
    const out = applyReviewOps(page, [{ op: 'remove_node', nodeId: 'nope', reason: 'r' }]);
    expect(out).toMatchObject({ ok: true, applied: [], historyEntryId: null });
    expect(getHistoryStore()!.history.length).toBe(0);
  });

  it('fails soft: a write that throws reverts every earlier write and records nothing', () => {
    const headline = byLabel('Headline');
    const copy = byLabel('Copy');
    // Lets the test replace one action with a throwing stub (MST protects actions).
    unprotect(store);
    const spy = vi.spyOn(copy, 'setTextContent').mockImplementation(() => {
      throw new Error('boom');
    });
    const before = JSON.stringify(headline.props);
    const out = applyReviewOps(page, [
      { op: 'update_style', nodeId: headline.id, breakpoint: null, property: 'fontSize', value: '10px', reason: 'r' },
      { op: 'update_text', nodeId: copy.id, text: 'New', reason: 'r' },
    ]);
    spy.mockRestore();
    expect(out.ok).toBe(false);
    expect(!out.ok && out.reason).toMatch(/Nothing was changed: boom/);
    expect(JSON.stringify(headline.props)).toBe(before);
    expect(getHistoryStore()!.history.length).toBe(0);
    expect(getHistoryStore()!.batch).toBeUndefined();
  });

  it('refuses to run inside another gesture batch', () => {
    const history = getHistoryStore()!;
    history.startBatch('drag');
    const out = applyReviewOps(page, [
      { op: 'update_style', nodeId: byLabel('Headline').id, breakpoint: null, property: 'color', value: 'red', reason: 'r' },
    ]);
    history.cancelBatch();
    expect(out.ok).toBe(false);
  });
});

describe('undoReview', () => {
  it('undoes while the review is the last entry, refuses after a later edit', () => {
    const headline = byLabel('Headline');
    const out = applyReviewOps(page, [
      { op: 'update_style', nodeId: headline.id, breakpoint: null, property: 'color', value: '#222222', reason: 'r' },
    ]);
    if (!out.ok || !out.historyEntryId) throw new Error('not applied');
    headline.updateResponsiveStyle('opacity', 0.9);
    expect(undoReview(out.historyEntryId)).toMatchObject({ ok: false });
    getHistoryStore()!.undo(); // the later edit
    expect(undoReview(out.historyEntryId)).toEqual({ ok: true });
    expect((headline.props.style as Record<string, unknown>).color).toBeUndefined();
  });
});
