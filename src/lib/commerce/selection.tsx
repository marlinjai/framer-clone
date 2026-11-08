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
  /** The last pick, when it cleared earlier choices no variant combines with it (to say so); else null. */
  cleared?: ClearedChoices | null;
  /**
   * Whether the selected variant's price is known: 'loading' while it is read,
   * 'missing' when it failed or the variant has none. An add to cart does not add a
   * variant without a known price. Absent where no selector reads prices.
   */
  price?: 'loading' | 'ready' | 'missing';
}

/** A pick and the earlier choices it cleared (optionId and valueId each). */
export interface ClearedChoices {
  pick: { optionId: string; valueId: string };
  cleared: { optionId: string; valueId: string }[];
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
 * Read the active SelectionState if one is provided, returning null when rendered
 * OUTSIDE a SelectedVariantContext.Provider instead of throwing.
 *
 * The published storefront renderer mounts the interactive islands on a
 * 'preview' surface whose contract is to DEGRADE GRACEFULLY: an island must
 * never throw and take the whole server-rendered page down (a 500). An
 * add-to-cart that is not nested inside a VariantSelector (a misconfigured tree),
 * or one whose VariantSelector ancestor has not yet resolved a product server
 * side, therefore reads `null` here and renders its disabled no-selection state,
 * exactly as an in-context empty selection already does. The throwing
 * `useSelectedVariant` stays available for callers that genuinely want to fail
 * loudly.
 */
export function useOptionalSelectedVariant(): SelectionState | null {
  return useContext(SelectedVariantContext);
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

/** Whether a variant carries every picked value of `probe`. */
function variantMatches(variant: ProductVariantDTO, probe: Record<string, string>): boolean {
  return Object.entries(probe).every(([axisId, axisValueId]) => {
    const coordinate = variant.optionValues.find((c) => c.optionId === axisId);
    return coordinate != null && coordinate.valueId === axisValueId;
  });
}

/**
 * Is `valueId` on `optionId` a choice a visitor can make? It is when any variant
 * carries it, whatever the other axes hold: picking it clears the choices on the
 * other axes that no variant combines with it (selectValue), so a visitor is never
 * locked out of a value by an earlier pick (variants S-Red and L-Blue: after S and
 * Red, L and Blue stay pressable). Only a value no variant has is greyed out.
 * Pure and React-free.
 */
export function isValueSelectable(variants: ProductVariantDTO[], optionId: string, valueId: string): boolean {
  return variants.some((variant) => variantMatches(variant, { [optionId]: valueId }));
}

/**
 * The selection after a visitor picks `valueId` on `optionId`: the pick, plus each
 * earlier choice on another axis that some variant still combines with it (kept in
 * the product's option order), the others cleared. Pure and React-free.
 */
export function selectValue(
  options: readonly { id: string }[],
  variants: ProductVariantDTO[],
  selection: Record<string, string>,
  optionId: string,
  valueId: string,
): Record<string, string> {
  // A value no variant has is no choice: the selection stays as it was.
  if (!isValueSelectable(variants, optionId, valueId)) return selection;
  const next: Record<string, string> = { [optionId]: valueId };
  const axes = [...options.map((option) => option.id), ...Object.keys(selection)];
  for (const axisId of axes) {
    if (axisId === optionId || !(axisId in selection) || axisId in next) continue;
    const probe = { ...next, [axisId]: selection[axisId] };
    if (variants.some((variant) => variantMatches(variant, probe))) next[axisId] = selection[axisId];
  }
  return next;
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
  const [state, setState] = useState<{ selection: Record<string, string>; cleared: ClearedChoices | null }>({ selection: {}, cleared: null });
  const { selection, cleared } = state;

  // A pick that no variant combines with an earlier choice clears that choice
  // (selectValue), and the clearing is kept so the selector can say so.
  const setOptionValue = useCallback(
    (optionId: string, valueId: string) => {
      setState((prev) => {
        const next = selectValue(product.options, variants, prev.selection, optionId, valueId);
        if (next === prev.selection) return prev;
        // In the product's option order, so the sentence names them as the page lists them.
        const order = product.options.map((option) => option.id);
        const gone = Object.entries(prev.selection)
          .filter(([axisId]) => axisId !== optionId && !(axisId in next))
          .sort(([a], [b]) => order.indexOf(a) - order.indexOf(b))
          .map(([axisId, axisValueId]) => ({ optionId: axisId, valueId: axisValueId }));
        return { selection: next, cleared: gone.length > 0 ? { pick: { optionId, valueId }, cleared: gone } : null };
      });
    },
    [product.options, variants],
  );

  const variant = useMemo(
    () => resolveVariantFromSelection(product, variants, selection),
    [product, variants, selection],
  );

  return useMemo(
    () => ({ selection, variant, setOptionValue, cleared }),
    [selection, variant, setOptionValue, cleared],
  );
}
