// Binding scope chain for the read-binding resolver runtime.
//
// This module is PURE and React-free (no React import anywhere under
// src/lib/bindings/resolver/*) so the static-publish path can evaluate
// bindings in Node at build time. Frames are immutable: every push*
// returns a NEW BindingScope so a scope value doubles as a stable
// snapshot key for memoization (see applyBindings.ts).
//
// Only the CORE frames live here (row, collection, page). Commerce frames
// (pushProductFrame / pushVariantFrame / pushAvailabilityFrame) are added by
// the Track C commerce resolver spec, which EXTENDS this module later.

import type { Collection, Row } from '@/lib/bindings/dataSource/types';

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

export type BindingFrame = RowFrame | CollectionFrame | PageFrame;

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

  // Single-segment / unqualified path: resolve against the innermost row's
  // column values. `{{title}}` === `{{row.title}}` when a row frame exists.
  const frame = findFrame(scope, 'row');
  return frame ? getNested(frame.row.values, path) : undefined;
}
