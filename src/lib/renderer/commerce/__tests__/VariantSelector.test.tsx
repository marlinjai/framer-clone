/* eslint-disable @typescript-eslint/no-explicit-any */
// VariantSelector behaviour. Dispatch wiring (data-component-kind -> renderer)
// is owned by a separate register spec and not present yet, so these tests
// render the component directly with a faithful `renderNode`
// (HeadlessComponentRenderer) and a CommerceDataSource provider, exactly like
// the ProductDetailRenderer suite. The canonical fixture is the Classic Tee
// (2 options: Size S/M, Color Red/Blue; 4 variants), so this is the spec's
// 2-option/4-variant case.
import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor, act, fireEvent } from '@testing-library/react';
import { onPatch } from 'mobx-state-tree';
import ComponentModel, { type ComponentInstance } from '@/models/ComponentModel';
import HeadlessComponentRenderer from '@/lib/renderer/HeadlessComponentRenderer';
import { CommerceDataSourceContext } from '@/lib/commerce/context';
import { InMemoryCommerceDataSource } from '@/lib/commerce/inMemoryCommerceDataSource';
import type { CommerceDataSource } from '@/lib/commerce/provider';
import type { ProductDTO, ProductVariantDTO } from '@/lib/commerce/types';
import {
  createScope,
  pushProductFrame,
  type BindingScope,
} from '@/lib/bindings/resolver/scope';
import type { RenderNode } from '@/lib/renderer/data/CollectionRenderer';
import type { DataStateMode } from '@/lib/renderer/data/resolveDataState';
import VariantSelector from '../VariantSelector';
import {
  advisoryAvailabilityText,
  LOW_STOCK_THRESHOLD,
} from '../VariantSelector';
import {
  isValueSelectable,
  resolveVariantFromSelection,
  useSelectedVariant,
} from '@/lib/commerce/selection';

const BP = 'bp';
const ALL_BP = [{ id: BP, minWidth: 0, label: 'BP' }];

// A variant-selector node whose children resolve {{variant.title}} and the
// advisory {{availability.availableQuantity}} of the SELECTED variant.
function makeSelectorNode() {
  return ComponentModel.create({
    id: 'vs-1',
    type: 'div',
    componentType: 'host',
    props: { 'data-component-kind': 'variant-selector' },
    bindings: {},
    children: [
      {
        id: 'vs-title',
        type: 'span',
        componentType: 'host',
        props: {},
        bindings: { children: { mode: 'read', expression: '{{variant.title}}' } },
      },
      {
        id: 'vs-avail',
        type: 'span',
        componentType: 'host',
        props: {},
        bindings: { children: { mode: 'read', expression: '{{availability.availableQuantity}}' } },
      },
    ],
  });
}

const renderNode: RenderNode = (node: ComponentInstance, childScope: BindingScope) => (
  <HeadlessComponentRenderer
    component={node}
    breakpointId={BP}
    allBreakpoints={ALL_BP}
    primaryId={BP}
    scope={childScope}
  />
);

function renderSelector(opts: {
  product: ProductDTO;
  ds: CommerceDataSource;
  node?: ComponentInstance;
  renderNodeOverride?: RenderNode;
  mode?: DataStateMode;
}) {
  const { product, ds, node = makeSelectorNode(), renderNodeOverride, mode = 'preview' } = opts;
  const scope = pushProductFrame(createScope(), product);
  return {
    node,
    ...render(
      <CommerceDataSourceContext.Provider value={ds}>
        <VariantSelector
          node={node}
          scope={scope}
          renderNode={renderNodeOverride ?? renderNode}
          hostType="div"
          hostProps={{ 'data-component-id': `${BP}-vs-1`, 'data-inner-component-id': 'vs-1' }}
          mode={mode}
        />
      </CommerceDataSourceContext.Provider>,
    ),
  };
}

// --- hand-built DTO fixtures for the pure matrix walk -----------------------

function twoByFourProduct(): { product: ProductDTO; variants: ProductVariantDTO[] } {
  const product: ProductDTO = {
    id: 'p',
    handle: 'p',
    title: 'P',
    description: null,
    options: [
      {
        id: 'o_size',
        productId: 'p',
        title: 'Size',
        values: [
          { id: 's', optionId: 'o_size', label: 'S' },
          { id: 'm', optionId: 'o_size', label: 'M' },
        ],
      },
      {
        id: 'o_color',
        productId: 'p',
        title: 'Color',
        values: [
          { id: 'red', optionId: 'o_color', label: 'Red' },
          { id: 'blue', optionId: 'o_color', label: 'Blue' },
        ],
      },
    ],
    variantIds: ['v_s_red', 'v_s_blue', 'v_m_red', 'v_m_blue'],
  };
  const mk = (id: string, size: string, color: string): ProductVariantDTO => ({
    id,
    productId: 'p',
    title: id,
    optionValues: [
      { optionId: 'o_size', valueId: size, label: size },
      { optionId: 'o_color', valueId: color, label: color },
    ],
  });
  return {
    product,
    variants: [
      mk('v_s_red', 's', 'red'),
      mk('v_s_blue', 's', 'blue'),
      mk('v_m_red', 'm', 'red'),
      mk('v_m_blue', 'm', 'blue'),
    ],
  };
}

// A fake CommerceDataSource over a fixed variant set, so tests can craft a
// matrix with a MISSING combination (unselectable) and controlled availability.
function makeFakeDS(
  variants: ProductVariantDTO[],
  availabilityByVariant: Record<string, number>,
): CommerceDataSource {
  return {
    listProducts: async () => ({ products: [], total: 0 }),
    getProduct: async () => null,
    getProductByHandle: async () => null,
    listVariants: async () => variants,
    getVariant: async (id: string) => variants.find((v) => v.id === id) ?? null,
    getPrices: async () => [],
    getAvailability: async (variantId: string) => {
      const qty = availabilityByVariant[variantId];
      if (qty === undefined) {
        throw new Error(`fake getAvailability: no record for "${variantId}"`);
      }
      return { variantId, locationId: 'all', availableQuantity: qty, stale: false };
    },
    subscribe: () => () => {},
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (window as any).__componentRegistry;
});

describe('resolveVariantFromSelection (matrix walk)', () => {
  it('resolves the single variant whose coordinates match the selection on every axis', () => {
    const { product, variants } = twoByFourProduct();
    const resolved = resolveVariantFromSelection(product, variants, {
      o_size: 'm',
      o_color: 'red',
    });
    expect(resolved?.id).toBe('v_m_red');
  });

  it('returns null for an incomplete selection (not every axis picked)', () => {
    const { product, variants } = twoByFourProduct();
    expect(resolveVariantFromSelection(product, variants, { o_size: 'm' })).toBeNull();
  });

  it('returns null for a combination that matches no variant (unselectable combo)', () => {
    const { product, variants } = twoByFourProduct();
    // Drop the m/blue variant: that combination now resolves to nothing.
    const without = variants.filter((v) => v.id !== 'v_m_blue');
    expect(
      resolveVariantFromSelection(product, without, { o_size: 'm', o_color: 'blue' }),
    ).toBeNull();
  });
});

describe('isValueSelectable', () => {
  it('greys out a value whose combination with the rest of the selection has no variant', () => {
    const { variants } = twoByFourProduct();
    const without = variants.filter((v) => v.id !== 'v_m_blue');
    // With Size = M picked, Blue is unselectable (no M/Blue variant exists)...
    expect(isValueSelectable(without, { o_size: 'm' }, 'o_color', 'blue')).toBe(false);
    // ...while Red stays selectable (M/Red exists).
    expect(isValueSelectable(without, { o_size: 'm' }, 'o_color', 'red')).toBe(true);
  });
});

describe('advisoryAvailabilityText (advisory only, never permission to sell)', () => {
  it('maps quantity to the three advisory bands', () => {
    expect(advisoryAvailabilityText(0)).toBe('Out of stock');
    expect(advisoryAvailabilityText(LOW_STOCK_THRESHOLD)).toBe(`Only ${LOW_STOCK_THRESHOLD} left`);
    expect(advisoryAvailabilityText(LOW_STOCK_THRESHOLD + 100)).toBe('In stock');
  });
});

describe('VariantSelector rendering', () => {
  it('renders one control per option and re-resolves the variant frame on selection (2-option/4-variant)', async () => {
    const ds = new InMemoryCommerceDataSource();
    const product = await ds.getProduct('prod_tee');
    expect(product).not.toBeNull();
    const { container } = renderSelector({ product: product!, ds });

    // One control group per option axis.
    await waitFor(() => {
      expect(container.querySelectorAll('[data-variant-option]').length).toBe(2);
    });
    // Wait for the variant matrix to load (buttons become enabled).
    await waitFor(() => {
      const small = container.querySelector('button[data-variant-value="ov_size_s"]') as HTMLButtonElement;
      expect(small?.disabled).toBe(false);
    });

    // Descendant {{variant.*}} starts unresolved (no selection yet).
    const title = () => container.querySelector('span[data-inner-component-id="vs-title"]');
    const avail = () => container.querySelector('span[data-inner-component-id="vs-avail"]');
    expect(title()?.textContent).toBe('');

    // Pick Small, then Red -> resolves var_s_red; descendants re-resolve.
    act(() => {
      fireEvent.click(container.querySelector('button[data-variant-value="ov_size_s"]')!);
    });
    act(() => {
      fireEvent.click(container.querySelector('button[data-variant-value="ov_color_red"]')!);
    });
    await waitFor(() => {
      expect(title()?.textContent).toBe('Small / Red');
    });
    // Aggregated advisory availability for var_s_red: (12-2) + (30-0) = 40.
    await waitFor(() => {
      expect(avail()?.textContent).toBe('40');
    });

    // Change Size to Medium -> re-resolves to var_m_red; frames re-push.
    act(() => {
      fireEvent.click(container.querySelector('button[data-variant-value="ov_size_m"]')!);
    });
    await waitFor(() => {
      expect(title()?.textContent).toBe('Medium / Red');
    });
    // var_m_red availability: (0-0) + (20-4) = 16.
    await waitFor(() => {
      expect(avail()?.textContent).toBe('16');
    });
  });

  it('disables an unselectable combination (no matching variant)', async () => {
    const { product, variants } = twoByFourProduct();
    const without = variants.filter((v) => v.id !== 'v_m_blue');
    const ds = makeFakeDS(without, { v_s_red: 9, v_s_blue: 9, v_m_red: 9 });
    const { container } = renderSelector({ product, ds });

    await waitFor(() => {
      const blue = container.querySelector('button[data-variant-value="blue"]') as HTMLButtonElement;
      expect(blue?.disabled).toBe(false);
    });

    // Pick Size = M. Now Blue has no matching variant: it greys out.
    act(() => {
      fireEvent.click(container.querySelector('button[data-variant-value="m"]')!);
    });
    await waitFor(() => {
      const blue = container.querySelector('button[data-variant-value="blue"]') as HTMLButtonElement;
      expect(blue.disabled).toBe(true);
    });
    const red = container.querySelector('button[data-variant-value="red"]') as HTMLButtonElement;
    expect(red.disabled).toBe(false);
  });

  it('shows advisory low-stock text for the selected variant', async () => {
    const { product, variants } = twoByFourProduct();
    const ds = makeFakeDS(variants, { v_s_red: 3, v_s_blue: 9, v_m_red: 9, v_m_blue: 9 });
    const { container } = renderSelector({ product, ds });

    await waitFor(() => {
      const small = container.querySelector('button[data-variant-value="s"]') as HTMLButtonElement;
      expect(small?.disabled).toBe(false);
    });
    act(() => {
      fireEvent.click(container.querySelector('button[data-variant-value="s"]')!);
    });
    act(() => {
      fireEvent.click(container.querySelector('button[data-variant-value="red"]')!);
    });
    await waitFor(() => {
      const text = container.querySelector('[data-variant-availability="ready"]');
      expect(text?.textContent).toBe('Only 3 left');
    });
  });

  it('surfaces an availability fetch error (never swallowed into a silent "in stock")', async () => {
    const { product, variants } = twoByFourProduct();
    // No availability record for v_s_red -> getAvailability throws.
    const ds = makeFakeDS(variants, { v_s_blue: 9, v_m_red: 9, v_m_blue: 9 });
    const { container } = renderSelector({ product, ds, mode: 'editor' });

    await waitFor(() => {
      const small = container.querySelector('button[data-variant-value="s"]') as HTMLButtonElement;
      expect(small?.disabled).toBe(false);
    });
    act(() => {
      fireEvent.click(container.querySelector('button[data-variant-value="s"]')!);
    });
    act(() => {
      fireEvent.click(container.querySelector('button[data-variant-value="red"]')!);
    });
    await waitFor(() => {
      const err = container.querySelector('[data-variant-availability="error"]');
      expect(err?.textContent).toContain('Availability check failed');
    });
  });

  it('exposes the selection through useSelectedVariant() for the add-to-cart spec', async () => {
    const { product, variants } = twoByFourProduct();
    const ds = makeFakeDS(variants, { v_s_red: 9, v_s_blue: 9, v_m_red: 9, v_m_blue: 9 });

    // A consumer that reads the selection via the hook (stands in for the next
    // spec's add-to-cart control). Rendered through a custom renderNode so it
    // sits inside VariantSelector's SelectedVariantContext.Provider.
    const Consumer = () => {
      const { variant } = useSelectedVariant();
      return <span data-testid="consumer">{variant ? variant.title : 'none'}</span>;
    };
    const consumerRenderNode: RenderNode = () => <Consumer />;

    const { container } = renderSelector({ product, ds, renderNodeOverride: consumerRenderNode });

    await waitFor(() => {
      expect(container.querySelector('[data-testid="consumer"]')?.textContent).toBe('none');
    });
    await waitFor(() => {
      const small = container.querySelector('button[data-variant-value="s"]') as HTMLButtonElement;
      expect(small?.disabled).toBe(false);
    });
    act(() => {
      fireEvent.click(container.querySelector('button[data-variant-value="s"]')!);
    });
    act(() => {
      fireEvent.click(container.querySelector('button[data-variant-value="blue"]')!);
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="consumer"]')?.textContent).toBe('v_s_blue');
    });
  });

  it('NEVER triggers an MST write or a server write on selection (client-only state)', async () => {
    const ds = new InMemoryCommerceDataSource();
    const product = await ds.getProduct('prod_tee');
    const mutateSpy = vi.spyOn(ds, '_mutate');
    const fetchSpy = vi.spyOn(globalThis, 'fetch' as any).mockResolvedValue({} as any);

    const { node, container } = renderSelector({ product: product!, ds });

    // Watch the MST node for ANY patch (a write to the design tree).
    const patches: unknown[] = [];
    const dispose = onPatch(node as any, (patch) => patches.push(patch));

    await waitFor(() => {
      const small = container.querySelector('button[data-variant-value="ov_size_s"]') as HTMLButtonElement;
      expect(small?.disabled).toBe(false);
    });
    act(() => {
      fireEvent.click(container.querySelector('button[data-variant-value="ov_size_s"]')!);
    });
    act(() => {
      fireEvent.click(container.querySelector('button[data-variant-value="ov_color_blue"]')!);
    });
    await waitFor(() => {
      const title = container.querySelector('span[data-inner-component-id="vs-title"]');
      expect(title?.textContent).toBe('Small / Blue');
    });

    dispose();
    // Selection is ephemeral React state: no MST patch, no fixture mutation, no
    // network write of any kind.
    expect(patches).toEqual([]);
    expect(mutateSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('source contracts (the no-sell-permission comment carries through)', () => {
  it('VariantSelector and selection both document advisory-only / reserve-at-checkout', () => {
    const selectorSrc = readFileSync(
      path.resolve(__dirname, '../VariantSelector.tsx'),
      'utf8',
    );
    const selectionSrc = readFileSync(
      path.resolve(__dirname, '../../../commerce/selection.tsx'),
      'utf8',
    );
    expect(selectorSrc).toMatch(/reserve-at-checkout/);
    expect(selectorSrc).toMatch(/NOT permission to sell/i);
    expect(selectionSrc).toMatch(/reserve-at-checkout/);
  });
});
