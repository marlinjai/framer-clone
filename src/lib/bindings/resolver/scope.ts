// Binding scope chain for the read-binding resolver runtime.
//
// This module is PURE and React-free (no React import anywhere under
// src/lib/bindings/resolver/*) so the static-publish path can evaluate
// bindings in Node at build time. Frames are immutable: every push*
// returns a NEW BindingScope so a scope value doubles as a stable
// snapshot key for memoization (see applyBindings.ts).
//
// The CORE CMS frames (row, collection, page) and the Track C commerce frames
// (pushProductFrame / pushVariantFrame / pushAvailabilityFrame) all live here.
// The commerce frames resolve against the typed commerce DTOs through the SAME
// scope chain and lookup machinery: there is no separate resolver.

import type { Collection, Row } from '@/lib/bindings/dataSource/types';
import type {
  AvailabilityDTO,
  PriceDTO,
  ProductDTO,
  ProductVariantDTO,
} from '@/lib/commerce/types';

/** A row frame exposes a single fetched Row. `{{title}}` and `{{row.title}}`
 *  resolve a column value against `row.values`. */
export interface RowFrame {
  kind: 'row';
  row: Row;
}

/** A collection frame exposes Collection metadata. `{{collection.name}}`
 *  resolves a field against the Collection object directly. */
export interface CollectionFrame {
  kind: 'collection';
  collection: Collection;
}

/** A page frame exposes route params (and any other page-level data).
 *  `{{page.params.id}}` resolves against this frame. */
export interface PageFrame {
  kind: 'page';
  params: Record<string, string>;
}

/** A product frame exposes a single ProductDTO. `{{product.title}}` resolves a
 *  field against the ProductDTO object directly. */
export interface ProductFrame {
  kind: 'product';
  product: ProductDTO;
}

/** A variant frame exposes a single ProductVariantDTO with its optional PriceDTO
 *  folded in. `{{variant.sku}}` resolves against the variant; `{{variant.price.*}}`
 *  (e.g. `{{variant.price.amountCents}}`) resolves against the folded price.
 *  There is NO standalone `price.*` root: price is ALWAYS reached through the
 *  variant frame. */
export interface VariantFrame {
  kind: 'variant';
  variant: ProductVariantDTO;
  price?: PriceDTO;
}

/** An availability frame exposes a single AvailabilityDTO. ADVISORY / read-only:
 *  `{{availability.availableQuantity}}` is display-only and is NEVER permission to
 *  sell. Track B stays server-authoritative for stock and writes. */
export interface AvailabilityFrame {
  kind: 'availability';
  availability: AvailabilityDTO;
}

export type BindingFrame =
  | RowFrame
  | CollectionFrame
  | PageFrame
  | ProductFrame
  | VariantFrame
  | AvailabilityFrame;

/** A scope is an ordered stack of frames. Later frames are INNERMOST: a
 *  single-segment expression and a `{{row.*}}` lookup resolve against the
 *  innermost frame of the matching kind. */
export interface BindingScope {
  frames: BindingFrame[];
}

/** An empty scope. Callers build up frames with the push* helpers (or by
 *  constructing frame literals directly for the page frame). */
export function createScope(frames: BindingFrame[] = []): BindingScope {
  return { frames };
}

/** Push a row frame, returning a NEW immutable scope. */
export function pushRowFrame(scope: BindingScope, row: Row): BindingScope {
  return { frames: [...scope.frames, { kind: 'row', row }] };
}

/** Push a collection frame, returning a NEW immutable scope. */
export function pushCollectionFrame(
  scope: BindingScope,
  collection: Collection,
): BindingScope {
  return { frames: [...scope.frames, { kind: 'collection', collection }] };
}

/** Push a page frame, returning a NEW immutable scope. Page params drive
 *  `{{page.params.*}}` resolution. (Not a commerce frame.) */
export function pushPageFrame(
  scope: BindingScope,
  params: Record<string, string>,
): BindingScope {
  return { frames: [...scope.frames, { kind: 'page', params }] };
}

/** Push a product frame, returning a NEW immutable scope. Drives
 *  `{{product.*}}` resolution. */
export function pushProductFrame(
  scope: BindingScope,
  product: ProductDTO,
): BindingScope {
  return { frames: [...scope.frames, { kind: 'product', product }] };
}

/** Push a variant frame, returning a NEW immutable scope. The optional `price`
 *  is folded into the same frame so `{{variant.price.*}}` resolves against it.
 *  There is NO standalone price frame: price is ALWAYS reached via the variant. */
export function pushVariantFrame(
  scope: BindingScope,
  variant: ProductVariantDTO,
  price?: PriceDTO,
): BindingScope {
  return { frames: [...scope.frames, { kind: 'variant', variant, price }] };
}

/** Push an availability frame, returning a NEW immutable scope. ADVISORY only:
 *  the resolved `{{availability.*}}` value is display-only and is NEVER
 *  permission to sell (Track B stays server-authoritative for stock/writes). */
export function pushAvailabilityFrame(
  scope: BindingScope,
  availability: AvailabilityDTO,
): BindingScope {
  return {
    frames: [...scope.frames, { kind: 'availability', availability }],
  };
}

/** Find the innermost frame of a given kind, or undefined. */
function findFrame<K extends BindingFrame['kind']>(
  scope: BindingScope,
  kind: K,
): Extract<BindingFrame, { kind: K }> | undefined {
  for (let i = scope.frames.length - 1; i >= 0; i--) {
    const frame = scope.frames[i];
    if (frame.kind === kind) {
      return frame as Extract<BindingFrame, { kind: K }>;
    }
  }
  return undefined;
}

/** Walk a dotted path into a plain object. Returns undefined (NEVER throws)
 *  the moment any segment is missing or the cursor is not an object. */
function getNested(root: unknown, segments: string[]): unknown {
  let cursor: unknown = root;
  for (const segment of segments) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/**
 * Resolve a dotted path against the scope chain. NEVER throws; returns
 * `undefined` on any miss.
 *
 * - `['row', ...rest]`      -> innermost row frame, `rest` against row.values
 * - `['collection', ...]`   -> innermost collection frame, rest against it
 * - `['page', ...]`         -> innermost page frame, rest against it
 * - `['product', ...]`      -> innermost product frame, rest against the product
 * - `['variant', ...]`      -> innermost variant frame, rest against the variant;
 *   `['variant', 'price', ...]` resolves against the folded price (NO standalone
 *   `price.*` root)
 * - `['availability', ...]` -> innermost availability frame, rest against it
 *   (advisory / display-only)
 * - anything else (e.g. `['title']`) -> innermost row frame, whole path
 *   against row.values (single-segment sugar)
 */
export function lookup(scope: BindingScope, path: string[]): unknown {
  if (path.length === 0) return undefined;
  const [head, ...rest] = path;

  if (head === 'row') {
    const frame = findFrame(scope, 'row');
    return frame ? getNested(frame.row.values, rest) : undefined;
  }
  if (head === 'collection') {
    const frame = findFrame(scope, 'collection');
    return frame ? getNested(frame.collection, rest) : undefined;
  }
  if (head === 'page') {
    const frame = findFrame(scope, 'page');
    return frame ? getNested(frame, rest) : undefined;
  }
  if (head === 'product') {
    const frame = findFrame(scope, 'product');
    return frame ? getNested(frame.product, rest) : undefined;
  }
  if (head === 'variant') {
    const frame = findFrame(scope, 'variant');
    if (!frame) return undefined;
    // `variant.price.*` resolves against the folded price (which may be
    // undefined -> getNested returns undefined, never throws). Every other
    // `variant.*` path resolves against the variant DTO directly.
    if (rest[0] === 'price') return getNested(frame.price, rest.slice(1));
    return getNested(frame.variant, rest);
  }
  if (head === 'availability') {
    const frame = findFrame(scope, 'availability');
    return frame ? getNested(frame.availability, rest) : undefined;
  }

  // Single-segment / unqualified path: resolve against the innermost row's
  // column values. `{{title}}` === `{{row.title}}` when a row frame exists.
  const frame = findFrame(scope, 'row');
  return frame ? getNested(frame.row.values, path) : undefined;
}
