// ShopControlContent on the canvas and in the Preview: the surface hands it a new
// `drawn` element on every render, so its fallback of missing required parts is
// kept by what the control holds (missingShopPartsKey), not by that element; and
// the node there is a live instance changed in place, so a part taken out of it
// still brings the fallback back.
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import type { ComponentInstance } from '@/models/ComponentModel';
import * as parts from '@/lib/commerce/parts';
import { missingShopPartsKey, normalizeShopControl, shopPartRoleOf, type ShopTreeNode } from '@/lib/commerce/parts';
import { ShopControlContent } from '../ShopControlContent';

vi.mock('@/lib/commerce/parts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/commerce/parts')>();
  return { ...actual, missingShopParts: vi.fn(actual.missingShopParts) };
});

afterEach(() => {
  cleanup();
  vi.mocked(parts.missingShopParts).mockClear();
});

const control = (): ShopTreeNode => normalizeShopControl({ id: 'c', type: 'div', props: { 'data-component-kind': 'cart-view' } }, 'en', 'node');

function draw(node: ShopTreeNode) {
  // A fresh element each time, as the canvas renders it.
  return <ShopControlContent node={node as unknown as ComponentInstance} kind="cart-view" locale="en" drawn={<span data-drawn="" />} />;
}

describe('the fallback of missing parts', () => {
  it('is built once across renders with a new drawn element, and again when a part leaves the control', () => {
    const node = control();
    const { rerender } = render(draw(node));
    rerender(draw(node));
    rerender(draw(node));
    expect(parts.missingShopParts).toHaveBeenCalledTimes(1);

    // The node changed in place, as a live instance is: the empty message deleted.
    node.children = node.children!.filter((child) => shopPartRoleOf(child.props) !== 'cart.empty');
    rerender(draw(node));
    expect(parts.missingShopParts).toHaveBeenCalledTimes(2);
    // The fallback now holds a default copy of the part it lacks.
    const fallback = vi.mocked(parts.missingShopParts).mock.results[1].value as ShopTreeNode[];
    expect(fallback.map((part) => shopPartRoleOf(part.props))).toEqual(['cart.empty']);
    rerender(draw(node));
    expect(parts.missingShopParts).toHaveBeenCalledTimes(2);
  });

  it('keys on the id, the kind and the roles held, whatever their order or the other props', () => {
    const node = control();
    const reordered = { ...node, props: { ...node.props, style: { color: 'red' } }, children: [...(node.children ?? [])].reverse() };
    expect(missingShopPartsKey(reordered, 'cart-view')).toBe(missingShopPartsKey(node, 'cart-view'));
    const lacking = { ...node, children: node.children!.slice(1) };
    expect(missingShopPartsKey(lacking, 'cart-view')).not.toBe(missingShopPartsKey(node, 'cart-view'));
    expect(missingShopPartsKey({ ...node, id: 'other' }, 'cart-view')).not.toBe(missingShopPartsKey(node, 'cart-view'));
  });
});
