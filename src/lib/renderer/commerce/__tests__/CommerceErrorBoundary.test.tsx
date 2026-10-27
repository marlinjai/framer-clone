// A commerce control that fails to render on the canvas shows a message in its
// own place; the blocks around it keep rendering. Before, one throw (an
// add-to-cart without a cart) blanked the whole editor.
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import ComponentModel from '@/models/ComponentModel';
import HeadlessComponentRenderer from '@/lib/renderer/HeadlessComponentRenderer';
import { CommerceDataSourceContext } from '@/lib/commerce/context';
import { InMemoryCommerceDataSource } from '@/lib/commerce/inMemoryCommerceDataSource';
import { CartProvider } from '@/lib/commerce/cart';

const BP = 'bp';
const ALL_BP = [{ id: BP, minWidth: 0, label: 'BP' }];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function makeTree() {
  return ComponentModel.create({
    id: 'root',
    type: 'div',
    componentType: 'host',
    props: {},
    children: [
      { id: 'title', type: 'h1', componentType: 'host', props: { children: 'Ring sizing' } },
      { id: 'atc', type: 'div', componentType: 'host', props: { 'data-component-kind': 'add-to-cart' } },
    ],
  });
}

function renderTree(withCart: boolean) {
  const tree = <HeadlessComponentRenderer component={makeTree()} breakpointId={BP} allBreakpoints={ALL_BP} />;
  return render(
    <CommerceDataSourceContext.Provider value={new InMemoryCommerceDataSource()}>
      {withCart ? <CartProvider>{tree}</CartProvider> : tree}
    </CommerceDataSourceContext.Provider>,
  );
}

describe('commerce controls on the canvas', () => {
  it('a failing control shows a message in its place and the rest of the page still renders', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { container } = renderTree(false);
    expect(screen.getByRole('heading', { name: 'Ring sizing' })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('This part of the shop could not be loaded.');
    const failed = container.querySelector('[data-island-error="add-to-cart"]');
    // The message keeps the node's identity, so the canvas can still select it.
    expect(failed?.getAttribute('data-component-id')).toBe(`${BP}-atc`);
    expect(logged.mock.calls.some((call) => String(call[0]).includes('the add-to-cart control failed to render'))).toBe(true);
  });

  it('a working control renders normally inside its boundary', () => {
    const { container } = renderTree(true);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(container.querySelector('[data-island-error]')).toBeNull();
  });
});
