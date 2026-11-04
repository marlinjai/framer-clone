// Nothing a visitor presses goes inside a part a visitor presses (a choice of the
// variant selector, the add to cart's button): a button, a link, a field or a shop
// control is refused there, from the palette and by a move, with the notice; a
// plain node (a swatch) and a move beside the part stay possible.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import { createRootStore, type RootStoreType } from '@/stores/RootStore';
import type { ComponentInstance } from '@/models/ComponentModel';
import type { PageModelType } from '@/models/PageModel';
import { INTERACTIVE_SHOP_PART_MESSAGE, SHOP_PART_ATTR } from '@/lib/commerce/parts';

let store: RootStoreType;

vi.mock('@/hooks/useStore', () => ({
  useStore: () => store,
}));

let page: PageModelType;
let root: ComponentInstance;
let selector: ComponentInstance;

function part(role: string, within: ComponentInstance = selector): ComponentInstance | undefined {
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
  store.projectStore.createProject('Variant guards');
  const project = store.projectStore.findProjectByTitle('Variant guards')!;
  page = project.findPageBySlug('')!;
  store.editorUI.setCurrentProject(project);
  store.editorUI.setCurrentPage(page);
  root = page.appComponentTree as ComponentInstance;
  selector = page.insertRegistryComponent('variantSelector', { kind: 'parent', parentId: root.id })!;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('inside a choice', () => {
  it.each(['button', 'link', 'addToCart'])('refuses a %s from the palette, with the notice', (entry) => {
    const choice = part('variant.value')!;
    const before = choice.children.length;
    expect(page.insertRegistryComponent(entry, { kind: 'parent', parentId: choice.id })).toBeUndefined();
    expect(store.editorUI.editorNotice).toEqual({ kind: 'refused', message: INTERACTIVE_SHOP_PART_MESSAGE });
    expect(page.findComponent(choice.id)!.children.length).toBe(before);
  });

  it('refuses a box holding a link moved into it, and lets the box go beside the choice', () => {
    const box = page.insertRegistryComponent('container', { kind: 'parent', parentId: root.id })!;
    page.insertRegistryComponent('link', { kind: 'parent', parentId: box.id });
    const choice = part('variant.value')!;
    expect(page.moveTreeComponent(box.id, { kind: 'parent', parentId: choice.id })).toBeUndefined();
    expect(store.editorUI.editorNotice).toEqual({ kind: 'refused', message: INTERACTIVE_SHOP_PART_MESSAGE });
    expect(page.moveTreeComponent(box.id, { kind: 'parent', parentId: part('variant.option')!.id })).toBeDefined();
  });

  it('takes a plain node, such as a swatch', () => {
    expect(page.insertRegistryComponent('text', { kind: 'parent', parentId: part('variant.value')!.id })).toBeDefined();
  });
});

describe('inside the add to cart button', () => {
  it('refuses a button, also inside its label, and takes plain text', () => {
    const addToCart = page.insertRegistryComponent('addToCart', { kind: 'parent', parentId: root.id })!;
    const button = part('addToCart.button', addToCart)!;
    expect(page.insertRegistryComponent('button', { kind: 'parent', parentId: button.id })).toBeUndefined();
    expect(page.insertRegistryComponent('button', { kind: 'parent', parentId: part('addToCart.button-label', addToCart)!.id })).toBeUndefined();
    expect(store.editorUI.editorNotice).toEqual({ kind: 'refused', message: INTERACTIVE_SHOP_PART_MESSAGE });
  });
});

describe('a shop control inside the selector, beside its parts', () => {
  it('is still welcome: the add to cart belongs inside the selector', () => {
    expect(page.insertRegistryComponent('addToCart', { kind: 'parent', parentId: selector.id })).toBeDefined();
  });
});
