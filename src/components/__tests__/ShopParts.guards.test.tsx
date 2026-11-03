// The editor's guards around shop parts: a part moved out of its control or
// duplicated becomes a plain node with a fresh id (and the page still saves,
// reloads and selects), the generator cannot replace a required part, the panel
// says why a part's text is fixed, and the buyer fields are labelled.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { getSnapshot } from 'mobx-state-tree';
import { createRootStore, type RootStoreType } from '@/stores/RootStore';
import { openProject } from '@/stores/openProject';
import type { ComponentInstance } from '@/models/ComponentModel';
import type { PageModelType } from '@/models/PageModel';
import ComponentRenderer from '../ComponentRenderer';
import EditorCommerceProvider from '../EditorCommerceProvider';
import { ShopPartNote } from '../sidebars/right/sections/ShopPartNote';
import { MISPLACED_SHOP_PART_MESSAGE, REQUIRED_SHOP_PART_MESSAGE, SHOP_PART_ATTR, pageWithShopParts } from '@/lib/commerce/parts';

let store: RootStoreType;

vi.mock('@/hooks/useStore', () => ({
  useStore: () => store,
}));

let page: PageModelType;
let root: ComponentInstance;
let checkout: ComponentInstance;

function part(role: string, within: ComponentInstance = checkout): ComponentInstance | undefined {
  if (within.props?.[SHOP_PART_ATTR] === role) return within;
  for (const child of within.children as ComponentInstance[]) {
    const found = part(role, child);
    if (found) return found;
  }
  return undefined;
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  store = createRootStore();
  store.projectStore.createProject('Shop guards');
  const project = store.projectStore.findProjectByTitle('Shop guards')!;
  page = project.findPageBySlug('')!;
  store.editorUI.setCurrentProject(project);
  store.editorUI.setCurrentPage(page);
  root = page.appComponentTree as ComponentInstance;
  checkout = page.insertRegistryComponent('checkoutButton', { kind: 'parent', parentId: root.id })!;
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('a part moved out of its control', () => {
  it('lands as a plain node with a fresh id, and the page saves, reloads and selects', () => {
    const pay = part('checkout.pay')!;
    const oldId = pay.id;
    const moved = page.moveTreeComponent(oldId, { kind: 'parent', parentId: root.id })!;
    expect(moved.id).not.toBe(oldId);
    expect(moved.props[SHOP_PART_ATTR]).toBeUndefined();
    expect((moved.children as ComponentInstance[]).every((child) => child.props[SHOP_PART_ATTR] === undefined)).toBe(true);
    expect(page.findComponent(oldId)).toBeUndefined();

    // Save and reload: the load path puts the pay button back, under its own id.
    const project = store.editorUI.currentProject!;
    const saved = JSON.parse(JSON.stringify(getSnapshot(project)));
    saved.pages[page.id] = pageWithShopParts(saved.pages[page.id], 'en');
    const fresh = createRootStore();
    const opened = openProject(fresh, saved, page.id, 1);
    const reloadedPage = opened.page!;
    const back = reloadedPage.findComponent(oldId)!;
    expect(back.props[SHOP_PART_ATTR]).toBe('checkout.pay');
    expect(reloadedPage.findComponent(moved.id)!.props[SHOP_PART_ATTR]).toBeUndefined();
    fresh.editorUI.selectComponent(back);
    expect(fresh.editorUI.selectedComponent?.id).toBe(oldId);
  });

  it('keeps its role while it moves within its own place in its control', () => {
    const pay = part('checkout.pay')!;
    const actions = part('checkout.actions')!;
    const moved = page.moveTreeComponent(pay.id, { kind: 'parent', parentId: actions.id, index: 0 })!;
    expect(moved.id).toBe(pay.id);
    expect(moved.props[SHOP_PART_ATTR]).toBe('checkout.pay');
  });

  it('is refused, with a notice, when it would leave its place inside its own control', () => {
    const pay = part('checkout.pay')!;
    const parentBefore = pay.parentId;
    expect(page.moveTreeComponent(pay.id, { kind: 'parent', parentId: checkout.id })).toBeUndefined();
    expect(page.findComponent(pay.id)?.parentId).toBe(parentBefore);
    expect(store.editorUI.editorNotice).toEqual({ kind: 'refused', message: MISPLACED_SHOP_PART_MESSAGE });
    // The demo notice cannot go under the confirmation either.
    const badge = part('checkout.demo-badge')!;
    expect(page.moveTreeComponent(badge.id, { kind: 'parent', parentId: part('checkout.confirmation')!.id })).toBeUndefined();
  });
});

describe('duplicating', () => {
  it('copies a part as a plain node, and a whole control with its parts', () => {
    const copy = page.duplicateComponent(part('checkout.pay')!.id)!;
    expect(copy.props[SHOP_PART_ATTR]).toBeUndefined();
    const controlCopy = page.duplicateComponent(checkout.id)!;
    expect(part('checkout.pay', controlCopy)).toBeDefined();
  });
});

describe('the generator', () => {
  it('cannot replace a required part', () => {
    const pay = part('checkout.pay')!;
    const outcome = page.applyGeneratedNodes('replace', pay.id, [{ id: 'gen', type: 'div', componentType: 'host', props: {} } as never], 'g1');
    expect(outcome).toEqual({ ok: false, reason: REQUIRED_SHOP_PART_MESSAGE });
    expect(page.findComponent(pay.id)).toBeDefined();
  });
});

describe('the panel', () => {
  it('says why the pay wording is fixed', () => {
    const { getByTestId } = render(<ShopPartNote component={part('checkout.pay-label')!} />);
    expect(getByTestId('shop-part-note').textContent).toMatch(/Zahlungspflichtig bestellen/);
  });
});

describe('the buyer fields on the canvas', () => {
  it('tie each input to its label text', () => {
    const breakpoints = page.sortedViewportNodes.map((v) => ({ id: v.breakpointId!, minWidth: v.breakpointMinWidth ?? 0 }));
    render(
      <EditorCommerceProvider>
        <ComponentRenderer component={root} breakpointId={breakpoints[0].id} allBreakpoints={breakpoints} />
      </EditorCommerceProvider>,
    );
    act(() => store.editorUI.setShopPreviewState(checkout.id, 'payment'));
    const input = document.querySelector<HTMLInputElement>('input[data-checkout-buyer-field="email"]')!;
    const labelText = document.getElementById(input.getAttribute('aria-labelledby')!)!;
    expect(labelText.textContent).toBe('Email');
    const label = labelText.closest('label')!;
    expect(label.htmlFor).toBe(input.id);
  });
});
