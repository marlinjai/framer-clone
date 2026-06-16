/* eslint-disable @typescript-eslint/no-explicit-any */
// CollectionRenderer: the runtime for a BOUND `collection` data component.
//
// Reads the node's `collection` read-binding to learn which collection to
// fetch, calls `useDataSource().listRows(collectionId, query)`, and repeats
// the node's FIRST child (children[0]) once per returned row, each instance
// rendered against a scope with a row frame pushed on top. This is the
// Events->gallery "repeating component" shape: one template, N data rows.
//
// The renderer OWNS its children construction (it never uses the generic
// `children.map` output the host renderers build for ordinary nodes) so that
// each repeat gets its own `{{row.*}}` scope. It renders the host wrapper
// element itself so identity attributes and the container styling survive.
//
// The loading / empty / error / content decision is routed through the shared
// pure `resolveDataState` helper so the "errors surface, never swallow"
// contract is defined once. In editor mode an ERROR shows an inline chip with
// the real message; in preview/headless mode an ERROR renders nothing for the
// slot (no broken layout, no throw during SSR/static emit). Errors (a failed
// `listRows`, a missing/unresolved collection binding) ALWAYS surface to the
// error/empty path, never silently render as success.
'use client';
import React from 'react';
import { observer } from 'mobx-react-lite';
import type { ComponentInstance } from '@/models/ComponentModel';
import type { ReadBinding } from '@/lib/bindings/types';
import type { BindingScope } from '@/lib/bindings/resolver/scope';
import { pushRowFrame } from '@/lib/bindings/resolver/scope';
import {
  evaluateExpression,
  parseExpression,
} from '@/lib/bindings/resolver/expression';
import { useDataSource } from '@/lib/bindings/dataSource/context';
import type { Query, Row } from '@/lib/bindings/dataSource/types';
import { resolveDataState, type DataStateMode } from './resolveDataState';

/** Render a single component node against a scope. Supplied by whichever host
 *  renderer (editor `ComponentRenderer` / `HeadlessComponentRenderer`) is
 *  driving this subtree, so the data renderers stay renderer-agnostic and the
 *  editor + headless paths produce identical output. */
export type RenderNode = (
  node: ComponentInstance,
  scope: BindingScope,
) => React.ReactNode;

/**
 * Resolve the source collection id from a slot's read-binding.
 *
 * The `collection` (Collection) and `record` (RecordView) slots store the
 * source collection id in their binding `expression`. We support two shapes:
 *  - a literal id (e.g. `col_events`), used as-is, and
 *  - a `{{...}}` template that resolves to an id string against the scope
 *    (e.g. a future relation-sourced collection).
 * Returns `null` when there is no usable read-binding or the resolved value
 * is not a non-empty string, which callers MUST treat as the error/empty
 * path (never as success).
 */
export function resolveCollectionId(
  binding: ReadBinding | undefined,
  scope: BindingScope,
): string | null {
  if (!binding || binding.mode !== 'read') return null;
  const raw = typeof binding.expression === 'string' ? binding.expression.trim() : '';
  if (!raw) return null;

  const parsed = parseExpression(raw);
  if (parsed) {
    const resolved = evaluateExpression(parsed, scope);
    return typeof resolved === 'string' && resolved.length > 0 ? resolved : null;
  }
  return raw;
}

const NOTE_STYLE: React.CSSProperties = {
  color: '#9ca3af',
  fontSize: '12px',
  fontFamily: 'Inter, sans-serif',
  pointerEvents: 'none',
  userSelect: 'none',
};

// Editor-only error chip: visually distinct so a designer sees the failure,
// carrying the REAL error message (the contract: errors surface, never swallow).
const ERROR_CHIP_STYLE: React.CSSProperties = {
  display: 'inline-block',
  color: '#b91c1c',
  background: '#fef2f2',
  border: '1px solid #fecaca',
  borderRadius: '4px',
  padding: '2px 6px',
  fontSize: '12px',
  fontFamily: 'Inter, sans-serif',
  pointerEvents: 'none',
  userSelect: 'none',
};

/** Read a string-valued node prop (e.g. loadingContent / emptyContent),
 *  falling back to `fallback` when absent or not a non-empty string. */
function stringProp(
  props: Record<string, unknown> | undefined,
  key: string,
  fallback: string,
): string {
  const raw = props?.[key];
  return typeof raw === 'string' && raw.length > 0 ? raw : fallback;
}

type FetchState =
  | { status: 'loading' }
  | { status: 'ready'; rows: Row[] }
  | { status: 'error'; message: string };

export interface CollectionRendererProps {
  node: ComponentInstance;
  scope: BindingScope;
  renderNode: RenderNode;
  /** Host tag for the container wrapper (e.g. `div`). */
  hostType: string;
  /** Already-resolved wrapper props (identity attrs + style + marker). */
  hostProps: Record<string, unknown>;
  /** Rendering surface: editor surfaces error chips, preview renders nothing. */
  mode?: DataStateMode;
}

const CollectionRenderer = observer(
  ({ node, scope, renderNode, hostType, hostProps, mode = 'preview' }: CollectionRendererProps) => {
    const dataSource = useDataSource();

    const collectionId = resolveCollectionId(node.bindings?.collection as ReadBinding | undefined, scope);
    // Structured filter/sort/limit live as a Query object on props.query (NOT
    // a template expression). Read the raw structured value off the node.
    const query = (node.props as any)?.query as Query | undefined;
    // Stable dependency key so the effect refetches when the query changes by
    // value (the object identity churns on every MST snapshot).
    const queryKey = query ? JSON.stringify(query) : '';

    const [state, setState] = React.useState<FetchState>({ status: 'loading' });

    React.useEffect(() => {
      if (!collectionId) return;
      let active = true;
      const load = () => {
        dataSource
          .listRows(collectionId, query)
          .then((page) => {
            if (active) setState({ status: 'ready', rows: page.rows });
          })
          .catch((err: unknown) => {
            if (active) {
              setState({
                status: 'error',
                message: err instanceof Error ? err.message : String(err),
              });
            }
          });
      };
      load();
      // Polling reactivity: re-fetch whenever the provider signals a change.
      const unsubscribe = dataSource.subscribe(collectionId, query, load);
      return () => {
        active = false;
        unsubscribe();
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [dataSource, collectionId, queryKey]);

    const wrapperProps = { ...hostProps };
    delete (wrapperProps as any).children;

    const note = (text: string, style: React.CSSProperties = NOTE_STYLE) =>
      React.createElement(
        hostType as any,
        wrapperProps,
        React.createElement('span', { style }, text),
      );

    // Unresolved / missing collection binding: surface the error path, never
    // a silent empty success. (This is a configuration guard, not a fetch
    // state, so it stays outside resolveDataState.)
    if (!collectionId) {
      return note('Collection: no source collection bound');
    }

    // Route the loading/empty/error/content decision through the shared helper.
    const directive = resolveDataState({
      isLoading: state.status === 'loading',
      rows: state.status === 'ready' ? state.rows : null,
      error: state.status === 'error' ? new Error(state.message) : null,
      mode,
    });

    if (directive.kind === 'loading') {
      return note(stringProp(node.props as Record<string, unknown> | undefined, 'loadingContent', 'Loading...'));
    }

    if (directive.kind === 'error') {
      // Editor: an inline chip carrying the real message. Preview/headless:
      // render nothing for the slot (empty wrapper, no broken layout, no throw).
      return directive.message
        ? note(`Failed to load collection: ${directive.message}`, ERROR_CHIP_STYLE)
        : React.createElement(hostType as any, wrapperProps);
    }

    if (directive.kind === 'empty') {
      return note(stringProp(node.props as Record<string, unknown> | undefined, 'emptyContent', 'No items'));
    }

    // CONTENT: rows present and non-empty.
    const rows = state.status === 'ready' ? state.rows : [];
    const template = node.children.length > 0 ? node.children[0] : null;

    if (!template) {
      // Bound and populated but nothing to repeat: surface a configuration
      // note rather than rendering an empty success.
      return note('Collection: add a child to use as the row template');
    }

    const items = rows.map((row) => {
      const rowScope = pushRowFrame(scope, row);
      return <React.Fragment key={row.id}>{renderNode(template, rowScope)}</React.Fragment>;
    });

    return React.createElement(hostType as any, wrapperProps, items);
  },
);

CollectionRenderer.displayName = 'CollectionRenderer';
export default CollectionRenderer;
