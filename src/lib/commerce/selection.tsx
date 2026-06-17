// Client-only variant selection state for the storefront VariantSelector.
//
// This is EPHEMERAL UI state: which option value the visitor has picked on each
// option axis, and the single variant that selection resolves to. It is React
// state in a small context, NEVER written to MST and NEVER sent to the server.
// A visitor toggling Size or Color is not a stock fact or a money fact, so it
// has no place in the persisted design tree or in any commerce mutation. The
// CommerceDataSource seam is read-only by design (no write/reserve method
// exists), and reserve-at-checkout is the SOLE authority on whether stock can
// actually be taken: nothing selected here is permission to sell.
//
// The matrix walk (`resolveVariantFromSelection`) is a pure, React-free
// composite-coordinate match of the per-option selection against each
// `ProductVariantDTO.optionValues`, so it is unit-testable on its own.
'use client';

import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ProductDTO, ProductVariantDTO } from './types';

/**
 * The selection a visitor has made plus the variant it resolves to. `selection`
 * maps an optionId to the chosen valueId (one entry per picked axis). `variant`
 * is the single variant whose option coordinates match the selection on every
 * axis, or null when the selection is incomplete or matches no variant.
 *
 * All of this is client-only: `setOptionValue` updates React state and nothing
 * else. It is NEVER an MST write and NEVER a server write.
 */
export interface SelectionState {
  /** optionId -> selected valueId (ephemeral client-only UI state). */
  selection: Record<string, string>;
  /** The variant resolved from the current selection, or null. */
  variant: ProductVariantDTO | null;
  /** Pick a value for one option axis. Pure client state mutation. */
  setOptionValue(optionId: string, valueId: string): void;
}

/**
 * Context carrying the active SelectionState so descendants (notably the
 * next spec's add-to-cart control) can read the current selection. Defaults to
 * null so `useSelectedVariant` can fail loudly when used outside a provider.
 */
export const SelectedVariantContext = createContext<SelectionState | null>(null);
SelectedVariantContext.displayName = 'SelectedVariantContext';

/**
 * Read the active SelectionState. Throws when used outside a
 * SelectedVariantContext.Provider: we would rather fail loudly than silently
 * resolve a null selection. The add-to-cart spec calls this to read the chosen
 * variant.
 */
export function useSelectedVariant(): SelectionState {
  const ctx = useContext(SelectedVariantContext);
  if (!ctx) {
    throw new Error(
      'useSelectedVariant must be used within a SelectedVariantContext.Provider. ' +
        'Render it inside a VariantSelector.',
    );
  }
  return ctx;
}

/**
 * The matrix walk: resolve the single variant that matches `selection` on every
 * option axis of `product`.
 *
 * A variant matches only when:
 *  - every option axis of the product has a selected value, AND
 *  - for every axis, the variant carries an option coordinate whose valueId
 *    equals the selected value.
 *
 * Returns null for an incomplete selection (not every axis picked yet) or when
 * the chosen combination has no variant (an unselectable combo). Pure and
 * React-free: no I/O, no state, no MST.
 */
export function resolveVariantFromSelection(
  product: ProductDTO,
  variants: ProductVariantDTO[],
  selection: Record<string, string>,
): ProductVariantDTO | null {
  const optionIds = product.options.map((option) => option.id);
  // An incomplete selection resolves to no variant (cannot add an ambiguous
  // product to a cart).
  if (optionIds.some((optionId) => !selection[optionId])) return null;

  return (
    variants.find((variant) =>
      optionIds.every((optionId) => {
        const coordinate = variant.optionValues.find((c) => c.optionId === optionId);
        return coordinate != null && coordinate.valueId === selection[optionId];
      }),
    ) ?? null
  );
}

/**
 * Is picking `valueId` on `optionId` a selectable choice given the rest of the
 * current selection? It is selectable only when at least one variant matches
 * the OTHER already-picked axes AND carries this value on this axis. A value
 * with no matching variant is an unselectable combo and the control greys it
 * out. Pure and React-free.
 */
export function isValueSelectable(
  variants: ProductVariantDTO[],
  selection: Record<string, string>,
  optionId: string,
  valueId: string,
): boolean {
  const probe: Record<string, string> = { ...selection, [optionId]: valueId };
  return variants.some((variant) =>
    Object.entries(probe).every(([axisId, axisValueId]) => {
      const coordinate = variant.optionValues.find((c) => c.optionId === axisId);
      return coordinate != null && coordinate.valueId === axisValueId;
    }),
  );
}

/**
 * Hook that owns the client-only selection state for one product and resolves
 * the matching variant. Selection lives in React state (NOT MST, NOT the
 * server); `setOptionValue` only ever updates that state. Returns a stable
 * SelectionState suitable to feed straight into SelectedVariantContext.Provider.
 */
export function useVariantSelection(
  product: ProductDTO,
  variants: ProductVariantDTO[],
): SelectionState {
  const [selection, setSelection] = useState<Record<string, string>>({});

  const setOptionValue = useCallback((optionId: string, valueId: string) => {
    setSelection((prev) => ({ ...prev, [optionId]: valueId }));
  }, []);

  const variant = useMemo(
    () => resolveVariantFromSelection(product, variants, selection),
    [product, variants, selection],
  );

  return useMemo(
    () => ({ selection, variant, setOptionValue }),
    [selection, variant, setOptionValue],
  );
}
