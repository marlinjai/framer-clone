// The variant selector on the canvas: it arrives with its parts in the site
// language, the canvas previews each state with a sample product (a choice made,
// nothing chosen, loading the options, checking, few left, out of stock, a choice
// no variant has, no stock limit, a failed check, a product with nothing to sell,
// no product), the option and choice templates are drawn per sample option and
// value with no selection id drawn twice, a child of the designer's bound to the
// variant reads the sample choice, and a hidden part selected switches state.
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
let selector: ComponentInstance;
let breakpoints: { id: string; minWidth: number }[];

function part(role: string): ComponentInstance {
  const walk = (node: ComponentInstance): ComponentInstance | undefined => {
    if (node.props?.[SHOP_PART_ATTR] === role) return node;
    for (const child of node.children as ComponentInstance[]) {
      const found = walk(child);
      if (found) return found;
    }
    return undefined;
  };
  const found = walk(selector);
  if (!found) throw new Error(`no part ${role}`);
  return found;
}

const copies = (role: string) => [...document.querySelectorAll<HTMLElement>(`[${SHOP_PART_ATTR}="${role}"]`)];

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  store = createRootStore();
  store.projectStore.createProject('Variant parts');
  const project = store.projectStore.findProjectByTitle('Variant parts')!;
  project.updateSiteSettings({ ...project.siteSettings, language: 'de' });
  const page = project.findPageBySlug('')!;
  store.editorUI.setCurrentProject(project);
  store.editorUI.setCurrentPage(page);
  root = page.appComponentTree as ComponentInstance;
  selector = page.insertRegistryComponent('variantSelector', { kind: 'parent', parentId: root.id })!;
  breakpoints = page.sortedViewportNodes.map((v) => ({ id: v.breakpointId!, minWidth: v.breakpointMinWidth ?? 0 }));
  store.editorUI.clearSelection();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderCanvas() {
  return render(
    <EditorCommerceProvider>
      <ShopPreviewBar />
      <ComponentRenderer component={root} breakpointId={breakpoints[0].id} allBreakpoints={breakpoints.slice(0, 1)} />
    </EditorCommerceProvider>,
  );
}

describe('the variant selector on the canvas', () => {
  it('arrives with named parts in the site language', () => {
    expect(part('variant.value').label).toBe('Choice (repeated per value)');
    expect(part('variant.in-stock').props.children).toBe('Auf Lager');
  });

  it('draws the sample options and choices, one selected, and says in stock', () => {
    renderCanvas();
    expect(copies('variant.option-label').map((el) => el.textContent)).toEqual(['Größe', 'Farbe']);
    const choices = copies('variant.value');
    expect(choices.map((el) => el.textContent)).toEqual(['S', 'M', 'L', 'Rot', 'Blau']);
    expect(choices.filter((el) => el.getAttribute('aria-checked') === 'true').map((el) => el.textContent)).toEqual(['M', 'Rot']);
    expect(copies('variant.in-stock')[0]?.textContent).toBe('Auf Lager');
    expect(copies('variant.no-product')).toHaveLength(0);
  });

  it('previews nothing chosen, checking, few left, out of stock, no limit, a failed check and no product', () => {
    renderCanvas();
    const show = (state: string) => act(() => store.editorUI.setShopPreviewState(selector.id, state));
    show('nothing-chosen');
    expect(copies('variant.value').some((el) => el.getAttribute('aria-checked') === 'true')).toBe(false);
    show('checking');
    expect(copies('variant.checking')[0]?.textContent).toBe('Verfügbarkeit wird geprüft...');
    show('low-stock');
    expect(copies('variant.low-stock')[0]?.textContent).toBe('Nur noch 3 verfügbar');
    show('out-of-stock');
    expect(copies('variant.out-of-stock')[0]?.textContent).toBe('Nicht vorrätig');
    // Out of stock greys out no choice: a page never does for stock alone.
    expect(copies('variant.value').some((el) => (el as HTMLButtonElement).disabled)).toBe(false);
    show('choice-unavailable');
    expect((copies('variant.value')[2] as HTMLButtonElement).disabled).toBe(true);
    show('loading-options');
    expect(copies('variant.loading')[0]?.textContent).toBe('Optionen werden geladen...');
    expect(copies('variant.value')).toHaveLength(0);
    show('price-error');
    expect(copies('variant.price-error')[0]?.textContent).toBe('Der Preis dieser Auswahl kann gerade nicht geladen werden, daher kann sie noch nicht in den Warenkorb.');
    show('choice-cleared');
    expect(copies('variant.cleared')[0]?.textContent).toBe('Farbe zurückgesetzt: keine Variante hat Größe L in Rot.');
    show('not-available');
    expect(copies('variant.unavailable')[0]?.textContent).toBe('Dieses Produkt ist gerade nicht erhältlich.');
    expect(copies('variant.value')).toHaveLength(0);
    show('available');
    expect(copies('variant.available')[0]?.textContent).toBe('Verfügbar');
    show('error');
    expect(copies('variant.availability-error')[0]?.textContent).toMatch(/Verfügbarkeit kann gerade nicht geprüft werden/);
    show('no-product');
    expect(copies('variant.no-product')[0]?.textContent).toBe('Variantenauswahl: hier ist kein Produkt');
    expect(copies('variant.value')).toHaveLength(0);
  });

  it('draws every selection id once, however many copies of the option and choice templates', () => {
    // A swatch inside the choice template: drawn in every choice of every option.
    const swatch = store.editorUI.currentPage!.insertRegistryComponent('text', { kind: 'parent', parentId: part('variant.value').id })!;
    renderCanvas();
    expect(document.querySelectorAll(`[data-inner-component-id="${swatch.id}"]`)).toHaveLength(1);
    const ids = [...document.querySelectorAll('[data-inner-component-id]')].map((el) => el.getAttribute('data-inner-component-id'));
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    // The first choice of the second option is a later copy: it carries no id.
    const secondOption = copies('variant.option')[1];
    expect(secondOption.querySelector('[data-inner-component-id]')).toBeNull();
  });

  it('gives a child of the designer’s bound to the variant the sample choice', () => {
    const page = store.editorUI.currentPage!;
    const title = page.insertRegistryComponent('text', { kind: 'parent', parentId: selector.id })!;
    title.setBinding('children', { mode: 'read', expression: '{{variant.title}}' });
    renderCanvas();
    expect(document.querySelector(`[data-inner-component-id="${title.id}"]`)?.textContent).toBe('M / Rot');
  });

  it('switches to a state that shows a part selected while hidden, and keeps its required parts', () => {
    renderCanvas();
    act(() => store.editorUI.setShopPreviewState(selector.id, 'no-product'));
    act(() => store.editorUI.selectComponent(part('variant.value')));
    expect(store.editorUI.shopPreviewStates[selector.id]).toBe('in-stock');
    expect(canDeleteLayer(part('variant.value'))).toBe(false);
  });
});
