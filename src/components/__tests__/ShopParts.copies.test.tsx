// Copies of a repeated shop part on the canvas (the shortage lines): every copy
// keeps the node's style hook, so its rules reach copy two and later, and only the
// first keeps the selection identity.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { createRootStore, type RootStoreType } from '@/stores/RootStore';
import type { ComponentInstance } from '@/models/ComponentModel';
import ComponentRenderer from '../ComponentRenderer';
import EditorCommerceProvider from '../EditorCommerceProvider';
import { SHOP_PART_ATTR } from '@/lib/commerce/parts';

let store: RootStoreType;

vi.mock('@/hooks/useStore', () => ({
  useStore: () => store,
}));

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  store = createRootStore();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('repeated shop part copies', () => {
  it('all keep the style hook, and only the first the selection identity', () => {
    store.projectStore.createProject('Copies');
    const project = store.projectStore.findProjectByTitle('Copies')!;
    const page = project.findPageBySlug('')!;
    store.editorUI.setCurrentProject(project);
    store.editorUI.setCurrentPage(page);
    const root = page.appComponentTree as ComponentInstance;
    const checkout = page.insertRegistryComponent('checkoutButton', { kind: 'parent', parentId: root.id })!;
    const breakpoints = page.sortedViewportNodes.map((v) => ({ id: v.breakpointId!, minWidth: v.breakpointMinWidth ?? 0 }));
    render(
      <EditorCommerceProvider>
        <ComponentRenderer component={root} breakpointId={breakpoints[0].id} allBreakpoints={breakpoints.slice(0, 1)} />
      </EditorCommerceProvider>,
    );
    act(() => store.editorUI.setShopPreviewState(checkout.id, 'shortage'));
    const lines = [...document.querySelectorAll<HTMLElement>(`[${SHOP_PART_ATTR}="checkout.shortage-line"]`)];
    expect(lines).toHaveLength(2);
    const hook = lines[0].getAttribute('data-component-id');
    expect(hook).toBeTruthy();
    expect(lines.map((line) => line.getAttribute('data-component-id'))).toEqual([hook, hook]);
    expect(lines.map((line) => line.hasAttribute('data-inner-component-id'))).toEqual([true, false]);
  });
});
