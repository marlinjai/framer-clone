// resolveDataState: the single source of truth for how a data-bound
// component maps a fetch state to a render directive.
//
// PURE and React-free by contract: no JSX, no hooks, no store reads, no
// imports of React. Input goes in, a directive comes out. This is what lets
// the "errors surface, never swallow" contract be verified once (in the unit
// test) and then reused by every data renderer (CollectionRenderer,
// RecordViewRenderer, and the TableView renderer when it lands), plus the
// Track C storefront renderers later. The JSX / error-chip rendering lives in
// the renderer .tsx files that CALL this helper, never here.
//
// Mode split (the reason this helper distinguishes editor vs preview):
//  - editor: an ERROR carries the REAL message so the designer sees what
//    actually went wrong (an inline error chip). The message is NEVER
//    swallowed.
//  - preview (preview surface / headless / static emit): an ERROR carries no
//    message; the renderer renders nothing for that slot. The errored slot
//    leaves no broken layout and the render never throws during SSR / static
//    emit. The error path is still EXERCISED (kind is 'error'), just rendered
//    as empty rather than as a published-site error string.
import type { Row } from '@/lib/bindings/dataSource/types';

export type DataStateMode = 'editor' | 'preview';

export interface ResolveDataStateInput {
  /** True while the fetch is in flight. */
  isLoading: boolean;
  /**
   * The resolved rows, or null when not yet resolved. An empty array means a
   * successful fetch that returned no rows (the EMPTY directive). For a
   * single-record renderer, pass `[row]` for a hit and `[]` for not-found.
   */
  rows: Row[] | null;
  /** A real fetch / resolution error, or null when there is none. */
  error: Error | null;
  /** Which surface is rendering: 'editor' or 'preview' (preview/headless/static). */
  mode: DataStateMode;
}

export interface DataStateDirective {
  kind: 'loading' | 'empty' | 'error' | 'content';
  /**
   * Carried ONLY for an ERROR in editor mode: the real error message, for the
   * inline error chip. Omitted for a preview-mode error (renderer renders
   * nothing) and for every non-error directive.
   */
  message?: string;
}

/**
 * Map a fetch state to a render directive.
 *
 * Precedence (highest first), chosen so a real error can never be swallowed
 * behind a loading or empty state:
 *  1. ERROR    when `error` is non-null.
 *  2. LOADING  when `isLoading` is true.
 *  3. EMPTY    when `rows` is null or has length 0.
 *  4. CONTENT  otherwise (rows present and non-empty).
 *
 * The renderer maps the directive to UI:
 *  - LOADING  -> props.loadingContent or a minimal "Loading...".
 *  - EMPTY    -> props.emptyContent or a fallback ("No items" / "Not found").
 *  - CONTENT  -> the rows.
 *  - ERROR    -> editor: an inline chip with `message`; preview: nothing.
 */
export function resolveDataState(input: ResolveDataStateInput): DataStateDirective {
  const { isLoading, rows, error, mode } = input;

  if (error) {
    // Surface in editor, stay silent (but still ERROR) in preview/headless.
    return mode === 'editor'
      ? { kind: 'error', message: error.message }
      : { kind: 'error' };
  }

  if (isLoading) {
    return { kind: 'loading' };
  }

  if (rows === null || rows.length === 0) {
    return { kind: 'empty' };
  }

  return { kind: 'content' };
}
