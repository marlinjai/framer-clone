// A checkout on the canvas (designable shop controls): it arrives with its parts
// as nodes in the site language, every part selects like any node, the canvas
// shows the state picked in the ShopPreviewBar with sample data and never greys
// the design, a hidden part selected from Layers switches the state, and a
// required part cannot be deleted.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { createRootStore, type RootStoreType } from '@/stores/RootStore';
import type { ComponentInstance } from '@/models/ComponentModel';
import ComponentRenderer from '../ComponentRenderer';
import EditorCommerceProvider from '../EditorCommerceProvider';
import ShopPreviewBar from '../ShopPreviewBar';
import { REQUIRED_SHOP_PART_MESSAGE, SHOP_PART_ATTR } from '@/lib/commerce/parts';
import { canDeleteLayer } from '@/lib/layers/layerActions';
import { layerIconOf } from '../sidebars/layerIcon';
import { Info } from 'lucide-react';

let store: RootStoreType;

vi.mock('@/hooks/useStore', () => ({
  useStore: () => store,
}));

let root: ComponentInstance;
let checkout: ComponentInstance;
let breakpoints: { id: string; minWidth: number }[];

/** The part of the checkout with this role. */
function part(role: string): ComponentInstance {
  const walk = (node: ComponentInstance): ComponentInstance | undefined => {
    if (node.props?.[SHOP_PART_ATTR] === role) return node;
    for (const child of node.children as ComponentInstance[]) {
      const found = walk(child);
      if (found) return found;
    }
    return undefined;
  };
  const found = walk(checkout);
  if (!found) throw new Error(`no part ${role}`);
  return found;
}

const el = (c: ComponentInstance) => document.querySelector<HTMLElement>(`[data-inner-component-id="${c.id}"]`);

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  store = createRootStore();
  const { projectStore, editorUI } = store;
  projectStore.createProject('Shop parts');
  const project = projectStore.findProjectByTitle('Shop parts')!;
  project.updateSiteSettings({ ...project.siteSettings, language: 'de' });
  const page = project.findPageBySlug('')!;
  editorUI.setCurrentProject(project);
  editorUI.setCurrentPage(page);
  root = page.appComponentTree as ComponentInstance;
  checkout = page.insertRegistryComponent('checkoutButton', { kind: 'parent', parentId: root.id })!;
  breakpoints = page.sortedViewportNodes.map((v) => ({ id: v.breakpointId!, minWidth: v.breakpointMinWidth ?? 0 }));
  editorUI.clearSelection();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

function renderCanvas() {
  return render(
    <EditorCommerceProvider>
      <ShopPreviewBar />
      <ComponentRenderer component={root} breakpointId={breakpoints[0].id} allBreakpoints={breakpoints} />
    </EditorCommerceProvider>,
  );
}

describe('inserting a checkout', () => {
  it('brings its parts as named nodes in the site language, with no label prop left', () => {
    expect(checkout.props.label).toBeUndefined();
    expect(part('checkout.button').label).toBe('Checkout button');
    expect(part('checkout.button-label').props.children).toBe('Zur Kasse');
    expect(part('checkout.field-text.city').props.children).toBe('Ort');
    expect(layerIconOf(part('checkout.demo-badge'))).toBe(Info);
  });
});

describe('the checkout on the canvas', () => {
  it('shows the designed button, enabled, and nothing of the other steps', () => {
    renderCanvas();
    const button = el(part('checkout.button'))!;
    expect(button.tagName).toBe('BUTTON');
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(button.textContent).toBe('Zur Kasse');
    expect(el(part('checkout.payment'))).toBeNull();
    // The old unavailable message is gone from the design.
    expect(document.body.textContent).not.toMatch(/not available in the editor/i);
  });

  it('selects a part with a click, like any node', () => {
    renderCanvas();
    fireEvent.click(el(part('checkout.button-label'))!);
    expect(store.editorUI.selectedComponent?.id).toBe(part('checkout.button-label').id);
  });

  it('shows the picked state with sample data: the payment step, then the empty cart', () => {
    renderCanvas();
    act(() => store.editorUI.setShopPreviewState(checkout.id, 'payment'));
    expect(el(part('checkout.button'))).toBeNull();
    expect(el(part('checkout.total'))?.textContent).toBe('Zu zahlen: 49,90 EUR');
    expect(el(part('checkout.pay-label'))?.textContent).toBe('Zahlungspflichtig bestellen (49,90 EUR)');
    expect(el(part('checkout.demo-badge'))?.textContent).toBe('Demo-Zahlung. Es wird kein echtes Geld abgebucht.');
    const input = el(part('checkout.input.email')) as HTMLInputElement;
    expect(input.type).toBe('email');
    expect(input.readOnly).toBe(true);
    expect(el(part('checkout.pay-loading'))).toBeNull();

    act(() => store.editorUI.setShopPreviewState(checkout.id, 'empty'));
    expect((el(part('checkout.button')) as HTMLButtonElement).disabled).toBe(true);
  });

  it('switches to a state that shows a part selected while hidden', () => {
    renderCanvas();
    expect(el(part('checkout.pay'))).toBeNull();
    act(() => store.editorUI.selectComponent(part('checkout.pay')));
    expect(store.editorUI.shopPreviewStates[checkout.id]).toBe('payment');
    expect(el(part('checkout.pay'))).not.toBeNull();
    const picker = document.querySelector<HTMLSelectElement>('[data-shop-preview-bar] select')!;
    expect(picker.value).toBe('payment');
    expect(document.querySelector('[data-shop-preview-bar]')?.textContent).toMatch(/published site only/);
  });

  it('offers no bar when nothing of a shop control is selected', () => {
    renderCanvas();
    expect(document.querySelector('[data-shop-preview-bar]')).toBeNull();
  });
});

describe('deleting', () => {
  it('refuses a required part and says why, and deletes the whole control', () => {
    const page = store.editorUI.currentPage!;
    const pay = part('checkout.pay');
    expect(canDeleteLayer(pay)).toBe(false);
    expect(page.deleteComponent(pay.id)).toBe(false);
    expect(store.editorUI.editorNotice?.message).toBe(REQUIRED_SHOP_PART_MESSAGE);
    expect(page.findComponent(pay.id)).toBeDefined();
    // The optional demo decline toggle can go.
    expect(canDeleteLayer(part('checkout.decline'))).toBe(true);
    expect(page.deleteComponent(part('checkout.decline').id)).toBe(true);
    expect(canDeleteLayer(checkout)).toBe(true);
    expect(page.deleteComponent(checkout.id)).toBe(true);
  });
});
