// The add to cart and the cart on the canvas: they arrive with their parts in
// the site language, the canvas previews each state with sample lines (empty,
// loading, low stock, an item no longer sold, an item that failed; sold out and
// checking for the add to cart), the line template is drawn once per sample line,
// a part selected while hidden switches the state, and required parts stay.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { createRootStore, type RootStoreType } from '@/stores/RootStore';
import type { ComponentInstance } from '@/models/ComponentModel';
import ComponentRenderer from '../ComponentRenderer';
import EditorCommerceProvider from '../EditorCommerceProvider';
import ShopPreviewBar from '../ShopPreviewBar';
import { SHOP_PART_ATTR } from '@/lib/commerce/parts';
import { canDeleteLayer } from '@/lib/layers/layerActions';

let store: RootStoreType;

vi.mock('@/hooks/useStore', () => ({
  useStore: () => store,
}));

let root: ComponentInstance;
let cart: ComponentInstance;
let addToCart: ComponentInstance;
let breakpoints: { id: string; minWidth: number }[];

function part(within: ComponentInstance, role: string): ComponentInstance {
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

const all = (c: ComponentInstance) => [...document.querySelectorAll<HTMLElement>(`[data-shop-part]`)].filter((el) => el.getAttribute(SHOP_PART_ATTR) === c.props[SHOP_PART_ATTR]);
const el = (c: ComponentInstance) => document.querySelector<HTMLElement>(`[data-inner-component-id="${c.id}"]`);

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  store = createRootStore();
  store.projectStore.createProject('Cart parts');
  const project = store.projectStore.findProjectByTitle('Cart parts')!;
  project.updateSiteSettings({ ...project.siteSettings, language: 'de' });
  const page = project.findPageBySlug('')!;
  store.editorUI.setCurrentProject(project);
  store.editorUI.setCurrentPage(page);
  root = page.appComponentTree as ComponentInstance;
  cart = page.insertRegistryComponent('cartView', { kind: 'parent', parentId: root.id })!;
  addToCart = page.insertRegistryComponent('addToCart', { kind: 'parent', parentId: root.id })!;
  breakpoints = page.sortedViewportNodes.map((v) => ({ id: v.breakpointId!, minWidth: v.breakpointMinWidth ?? 0 }));
  store.editorUI.clearSelection();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

function renderCanvas() {
  // One frame is enough: every frame draws the same nodes.
  return render(
    <EditorCommerceProvider>
      <ShopPreviewBar />
      <ComponentRenderer component={root} breakpointId={breakpoints[0].id} allBreakpoints={breakpoints.slice(0, 1)} />
    </EditorCommerceProvider>,
  );
}

describe('the cart on the canvas', () => {
  it('arrives with named parts in the site language and no old props', () => {
    expect(cart.props.emptyContent).toBeUndefined();
    expect(part(cart, 'cart.line').label).toBe('Line (repeated per item)');
    expect(part(cart, 'cart.empty').props.children).toBe('Ihr Warenkorb ist leer');
  });

  it('draws two sample lines, each with its own name, and the subtotal', () => {
    renderCanvas();
    const titles = all(part(cart, 'cart.line-title')).map((node) => node.textContent);
    expect(titles).toEqual(['Klassisches T-Shirt, S / Rot', 'Emaille-Becher']);
    expect(el(part(cart, 'cart.subtotal'))?.textContent).toMatch(/^Zwischensumme \(geschätzt\): 64,90/);
    expect(el(part(cart, 'cart.empty'))).toBeNull();
    expect(all(part(cart, 'cart.line-qty-input'))[0]).toHaveProperty('readOnly', true);
  });

  it('previews the empty, loading, low stock, no longer sold and failed states', () => {
    renderCanvas();
    act(() => store.editorUI.setShopPreviewState(cart.id, 'empty'));
    expect(el(part(cart, 'cart.empty'))?.textContent).toBe('Ihr Warenkorb ist leer');
    act(() => store.editorUI.setShopPreviewState(cart.id, 'loading'));
    expect(all(part(cart, 'cart.line-loading'))).toHaveLength(2);
    act(() => store.editorUI.setShopPreviewState(cart.id, 'low-stock'));
    expect(all(part(cart, 'cart.line-warning'))[0]?.textContent).toBe('Nur noch 1 als verfügbar angegeben (Schätzung).');
    act(() => store.editorUI.setShopPreviewState(cart.id, 'unavailable'));
    expect(all(part(cart, 'cart.line-unavailable'))).toHaveLength(1);
    act(() => store.editorUI.setShopPreviewState(cart.id, 'error'));
    expect(all(part(cart, 'cart.line-error'))[0]?.textContent).toBe('Dieser Artikel kann gerade nicht geladen werden.');
  });

  it('switches to a state that shows a part selected while hidden', () => {
    renderCanvas();
    act(() => store.editorUI.setShopPreviewState(cart.id, 'empty'));
    act(() => store.editorUI.selectComponent(part(cart, 'cart.line-warning')));
    expect(store.editorUI.shopPreviewStates[cart.id]).toBe('low-stock');
  });

  it('keeps its required parts', () => {
    expect(canDeleteLayer(part(cart, 'cart.line-remove'))).toBe(false);
    expect(canDeleteLayer(cart)).toBe(true);
  });
});

describe('the add to cart on the canvas', () => {
  it('shows the label, enabled, then previews sold out, checking and the failed check', () => {
    renderCanvas();
    const button = () => el(part(addToCart, 'addToCart.button')) as HTMLButtonElement;
    expect(button().textContent).toBe('In den Warenkorb');
    expect(button().disabled).toBe(false);
    act(() => store.editorUI.setShopPreviewState(addToCart.id, 'sold-out'));
    expect(button().textContent).toBe('Ausverkauft');
    expect(button().disabled).toBe(true);
    act(() => store.editorUI.setShopPreviewState(addToCart.id, 'checking'));
    expect(button().getAttribute('aria-busy')).toBe('true');
    act(() => store.editorUI.setShopPreviewState(addToCart.id, 'error'));
    expect(el(part(addToCart, 'addToCart.error'))?.textContent).toMatch(/Verfügbarkeit kann gerade nicht geprüft werden/);
  });
});
