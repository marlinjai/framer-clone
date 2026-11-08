// The cart's line parts in the editor (docs/plans/2026-11-02-designable-shop-controls.md,
// slice 2): a line part cannot leave its line (the editor says why), a duplicated
// line part is a plain node, undo takes the copy back, and on the canvas the
// second sample line never repeats a selection identity, on the line or on any
// node inside it.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { createRootStore, getHistoryStore, type RootStoreType } from '@/stores/RootStore';
import type { ComponentInstance } from '@/models/ComponentModel';
import type { PageModelType } from '@/models/PageModel';
import ComponentRenderer from '../ComponentRenderer';
import EditorCommerceProvider from '../EditorCommerceProvider';
import { MISPLACED_SHOP_PART_MESSAGE, SHOP_PART_ATTR } from '@/lib/commerce/parts';

let store: RootStoreType;

vi.mock('@/hooks/useStore', () => ({
  useStore: () => store,
}));

let page: PageModelType;
let root: ComponentInstance;
let cart: ComponentInstance;

function part(role: string, within: ComponentInstance = cart): ComponentInstance {
  const walk = (node: ComponentInstance): ComponentInstance | undefined => {
    if (node.props?.[SHOP_PART_ATTR] === role) return node;
    for (const child of node.children as ComponentInstance[]) {
      const found = walk(child);
      if (found) return found;
    }
    return undefined;
  };
  const found = walk(within);
  if (!found) throw new Error(`no part ${role}`);
  return found;
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  store = createRootStore();
  store.projectStore.createProject('Cart editor');
  const project = store.projectStore.findProjectByTitle('Cart editor')!;
  page = project.findPageBySlug('')!;
  store.editorUI.setCurrentProject(project);
  store.editorUI.setCurrentPage(page);
  root = page.appComponentTree as ComponentInstance;
  cart = page.insertRegistryComponent('cartView', { kind: 'parent', parentId: root.id })!;
  store.editorUI.clearSelection();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('a cart line part', () => {
  it('cannot move out of its line, into the lines or the control, and the editor says why', () => {
    const title = part('cart.line-title');
    const line = part('cart.line');
    for (const target of [part('cart.lines'), cart]) {
      expect(page.moveTreeComponent(title.id, { kind: 'parent', parentId: target.id })).toBeUndefined();
      expect(store.editorUI.editorNotice).toEqual({ kind: 'refused', message: MISPLACED_SHOP_PART_MESSAGE });
      expect(page.findComponent(title.id)?.parentId).toBe(line.id);
    }
    // Among its siblings in the line it moves.
    expect(page.moveTreeComponent(title.id, { kind: 'parent', parentId: line.id, index: 2 })).toBeDefined();
    expect(page.findComponent(title.id)?.props[SHOP_PART_ATTR]).toBe('cart.line-title');
  });

  it('duplicated, is a plain node beside it, and undo takes the copy back', () => {
    const line = part('cart.line');
    const remove = part('cart.line-remove');
    const before = (line.children as ComponentInstance[]).map((child) => child.id);
    const copy = page.duplicateComponent(remove.id)!;
    expect(copy).toBeDefined();
    expect(copy.id).not.toBe(remove.id);
    expect(copy.props[SHOP_PART_ATTR]).toBeUndefined();
    expect(page.findComponent(line.id)!.children).toHaveLength(before.length + 1);
    // The original keeps its role, so the line still has exactly one remove button.
    expect(page.findComponent(remove.id)!.props[SHOP_PART_ATTR]).toBe('cart.line-remove');

    const history = getHistoryStore()!;
    expect(history.canUndo).toBe(true);
    act(() => history.undo());
    expect(page.findComponent(copy.id)).toBeUndefined();
    expect((page.findComponent(line.id)!.children as ComponentInstance[]).map((child) => child.id)).toEqual(before);
    expect(page.findComponent(remove.id)!.props[SHOP_PART_ATTR]).toBe('cart.line-remove');
  });
});

describe('the subtotal on the canvas', () => {
  it('previews the placeholder while loading and says it is partial while a line is not counted', () => {
    const breakpoints = page.sortedViewportNodes.map((v) => ({ id: v.breakpointId!, minWidth: v.breakpointMinWidth ?? 0 }));
    render(
      <EditorCommerceProvider>
        <ComponentRenderer component={root} breakpointId={breakpoints[0].id} allBreakpoints={breakpoints.slice(0, 1)} />
      </EditorCommerceProvider>,
    );
    const text = (role: string) => document.querySelector(`[data-inner-component-id="${part(role).id}"]`)?.textContent;
    const estimate = 'Estimate only. The final total is calculated at checkout.';
    expect(text('cart.subtotal-note')).toBe(estimate);
    act(() => store.editorUI.setShopPreviewState(cart.id, 'loading'));
    expect(text('cart.subtotal')).toBe('Estimated subtotal: -');
    expect(text('cart.subtotal-note')).toBe(`${estimate} Items still loading or not available are not counted.`);
    act(() => store.editorUI.setShopPreviewState(cart.id, 'unavailable'));
    expect(text('cart.subtotal')).toMatch(/^Estimated subtotal: .*50[.,]00/);
    expect(text('cart.subtotal-note')).toBe(`${estimate} Items still loading or not available are not counted.`);
  });
});

describe('the sample lines on the canvas', () => {
  it('carry each selection identity once: the second line and every node in it keep the style hook only', () => {
    // A wrapper of the designer's inside the line, around the price.
    const line = part('cart.line');
    const box = page.insertRegistryComponent('container', { kind: 'parent', parentId: line.id })!;
    const breakpoints = page.sortedViewportNodes.map((v) => ({ id: v.breakpointId!, minWidth: v.breakpointMinWidth ?? 0 }));
    render(
      <EditorCommerceProvider>
        <ComponentRenderer component={root} breakpointId={breakpoints[0].id} allBreakpoints={breakpoints.slice(0, 1)} />
      </EditorCommerceProvider>,
    );
    const lines = document.querySelectorAll(`[${SHOP_PART_ATTR}="cart.line"]`);
    expect(lines).toHaveLength(2);
    for (const node of [line, part('cart.line-title'), part('cart.line-qty-input'), part('cart.line-remove'), page.findComponent(box.id)!]) {
      expect(document.querySelectorAll(`[data-inner-component-id="${node.id}"]`)).toHaveLength(1);
      // The style hook reaches both copies, so the node's states and rules do.
      expect(document.querySelectorAll(`[data-component-id="${breakpoints[0].id}-${node.id}"]`)).toHaveLength(2);
    }
    // The selection identity sits in the first line.
    expect(lines[0].querySelector(`[data-inner-component-id="${part('cart.line-title').id}"]`)).not.toBeNull();
    expect(lines[1].querySelector('[data-inner-component-id]')).toBeNull();
  });
});
