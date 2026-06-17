/* eslint-disable @typescript-eslint/no-explicit-any */
// Editor/headless parity: both commerce renderers must produce IDENTICAL
// CONTENT output regardless of `mode` (the editor surface and the
// preview/headless surface differ ONLY in how an ERROR renders: an editor chip
// vs nothing). The success path must look the same in both modes, so a designer
// previews exactly what the published storefront ships.
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import ComponentModel, { type ComponentInstance } from '@/models/ComponentModel';
import HeadlessComponentRenderer from '@/lib/renderer/HeadlessComponentRenderer';
import { CommerceDataSourceContext } from '@/lib/commerce/context';
import { InMemoryCommerceDataSource } from '@/lib/commerce/inMemoryCommerceDataSource';
import {
  createScope,
  pushPageFrame,
  type BindingScope,
} from '@/lib/bindings/resolver/scope';
import type { RenderNode } from '@/lib/renderer/data/CollectionRenderer';
import type { DataStateMode } from '@/lib/renderer/data/resolveDataState';
import ProductListRenderer from '../ProductListRenderer';
import ProductDetailRenderer from '../ProductDetailRenderer';

const BP = 'bp';
const ALL_BP = [{ id: BP, minWidth: 0, label: 'BP' }];

const MULTI_SEED = {
  products: [
    { id: 'prod_a', handle: 'alpha', title: 'Alpha', description: null, taxClass: null },
    { id: 'prod_b', handle: 'beta', title: 'Beta', description: null, taxClass: null },
  ],
  options: [],
  optionValues: [],
  variants: [],
  variantOptions: [],
  prices: [],
  inventoryItems: [],
  inventoryLevels: [],
};

// A faithful recursion callback (plain local const, like
// HeadlessComponentRenderer's own renderNode).
const renderNode: RenderNode = (node: ComponentInstance, childScope: BindingScope) => (
  <HeadlessComponentRenderer
    component={node}
    breakpointId={BP}
    allBreakpoints={ALL_BP}
    primaryId={BP}
    scope={childScope}
  />
);

function makeListNode() {
  return ComponentModel.create({
    id: 'list-1',
    type: 'div',
    componentType: 'host',
    props: { 'data-component-kind': 'product-list' },
    bindings: { products: { mode: 'read', expression: 'products' } },
    children: [
      {
        id: 'tpl-card',
        type: 'span',
        componentType: 'host',
        props: {},
        bindings: { children: { mode: 'read', expression: '{{product.title}}' } },
      },
    ],
  });
}

function makeDetailNode() {
  return ComponentModel.create({
    id: 'detail-1',
    type: 'div',
    componentType: 'host',
    props: { 'data-component-kind': 'product-detail' },
    bindings: {},
    children: [
      {
        id: 'pd-title',
        type: 'h1',
        componentType: 'host',
        props: {},
        bindings: { children: { mode: 'read', expression: '{{product.title}}' } },
      },
      {
        id: 'pd-price',
        type: 'span',
        componentType: 'host',
        props: {},
        bindings: { children: { mode: 'read', expression: '{{variant.price.amountCents}}' } },
      },
    ],
  });
}

function renderListMode(mode: DataStateMode) {
  const ds = new InMemoryCommerceDataSource(MULTI_SEED as any);
  return render(
    <CommerceDataSourceContext.Provider value={ds}>
      <ProductListRenderer
        node={makeListNode()}
        scope={createScope()}
        renderNode={renderNode}
        hostType="div"
        hostProps={{ 'data-component-id': `${BP}-list-1`, 'data-inner-component-id': 'list-1' }}
        mode={mode}
      />
    </CommerceDataSourceContext.Provider>,
  );
}

function renderDetailMode(mode: DataStateMode) {
  const ds = new InMemoryCommerceDataSource();
  const scope = pushPageFrame(createScope(), { handle: 'classic-tee' });
  return render(
    <CommerceDataSourceContext.Provider value={ds}>
      <ProductDetailRenderer
        node={makeDetailNode()}
        scope={scope}
        renderNode={renderNode}
        hostType="div"
        hostProps={{ 'data-component-id': `${BP}-detail-1`, 'data-inner-component-id': 'detail-1' }}
        mode={mode}
      />
    </CommerceDataSourceContext.Provider>,
  );
}

afterEach(() => {
  cleanup();
  delete (window as any).__componentRegistry;
});

describe('commerce renderer editor/headless parity', () => {
  it('ProductListRenderer renders identical content in editor and preview modes', async () => {
    const editor = renderListMode('editor');
    await waitFor(() => {
      expect(
        editor.container.querySelectorAll('span[data-inner-component-id="tpl-card"]').length,
      ).toBe(2);
    });
    const editorHtml = editor.container.innerHTML;
    cleanup();

    const preview = renderListMode('preview');
    await waitFor(() => {
      expect(
        preview.container.querySelectorAll('span[data-inner-component-id="tpl-card"]').length,
      ).toBe(2);
    });
    expect(preview.container.innerHTML).toBe(editorHtml);
  });

  it('ProductDetailRenderer renders identical content in editor and preview modes', async () => {
    const editor = renderDetailMode('editor');
    await waitFor(() => {
      expect(
        editor.container.querySelector('h1[data-inner-component-id="pd-title"]')?.textContent,
      ).toBe('Classic Tee');
    });
    const editorHtml = editor.container.innerHTML;
    cleanup();

    const preview = renderDetailMode('preview');
    await waitFor(() => {
      expect(
        preview.container.querySelector('h1[data-inner-component-id="pd-title"]')?.textContent,
      ).toBe('Classic Tee');
    });
    expect(preview.container.innerHTML).toBe(editorHtml);
  });
});
