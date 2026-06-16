/* eslint-disable @typescript-eslint/no-explicit-any */
// RecordViewRenderer: the runtime for a BOUND `recordView` data component.
//
// Resolves a SINGLE row: the source collection id comes from the node's
// `record` read-binding; the row id is resolved from `{{page.params.id}}`
// against the active scope (the dynamic-route param). It then fetches that
// one row via `useDataSource().getRow`, pushes a single row frame, and
// renders ALL of the node's children against it so descendants resolve
// `{{row.field}}` to this record's values.
//
// A missing/unresolved id, a missing collection binding, or a `getRow` that
// returns null (non-existent record) ALL hit the empty/error path. Errors
// surface; they are never rendered as a silent success.
//
// The loading / empty / error / content decision is routed through the shared
// pure `resolveDataState` helper. In editor mode an ERROR shows an inline chip
// with the real message; in preview/headless mode an ERROR renders nothing for
// the slot (no broken layout, no throw during SSR/static emit).
'use client';
import React from 'react';
import { observer } from 'mobx-react-lite';
import type { ComponentInstance } from '@/models/ComponentModel';
import type { ReadBinding } from '@/lib/bindings/types';
import type { BindingScope } from '@/lib/bindings/resolver/scope';
import { lookup, pushRowFrame } from '@/lib/bindings/resolver/scope';
import { useDataSource } from '@/lib/bindings/dataSource/context';
import type { Row } from '@/lib/bindings/dataSource/types';
import { resolveCollectionId, type RenderNode } from './CollectionRenderer';
import { resolveDataState, type DataStateMode } from './resolveDataState';

const NOTE_STYLE: React.CSSProperties = {
  color: '#9ca3af',
  fontSize: '12px',
  fontFamily: 'Inter, sans-serif',
  pointerEvents: 'none',
  userSelect: 'none',
};

// Editor-only error chip: visually distinct, carrying the REAL error message
// (the contract: errors surface, never swallow).
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
  | { status: 'ready'; row: Row }
  | { status: 'empty' }
  | { status: 'error'; message: string };

export interface RecordViewRendererProps {
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

const RecordViewRenderer = observer(
  ({ node, scope, renderNode, hostType, hostProps, mode = 'preview' }: RecordViewRendererProps) => {
    const dataSource = useDataSource();

    const collectionId = resolveCollectionId(node.bindings?.record as ReadBinding | undefined, scope);
    // Row id from the dynamic-route param: {{page.params.id}}.
    const rawId = lookup(scope, ['page', 'params', 'id']);
    const rowId = typeof rawId === 'string' && rawId.length > 0 ? rawId : null;

    const [state, setState] = React.useState<FetchState>({ status: 'loading' });

    React.useEffect(() => {
      if (!collectionId || !rowId) return;
      let active = true;
      const load = () => {
        dataSource
          .getRow(collectionId, rowId)
          .then((row) => {
            if (!active) return;
            setState(row ? { status: 'ready', row } : { status: 'empty' });
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
      const unsubscribe = dataSource.subscribe(collectionId, undefined, load);
      return () => {
        active = false;
        unsubscribe();
      };
    }, [dataSource, collectionId, rowId]);

    const wrapperProps = { ...hostProps };
    delete (wrapperProps as any).children;

    const note = (text: string, style: React.CSSProperties = NOTE_STYLE) =>
      React.createElement(
        hostType as any,
        wrapperProps,
        React.createElement('span', { style }, text),
      );

    // Configuration guards (not fetch states, so outside resolveDataState).
    if (!collectionId) return note('Record view: no record source bound');
    // No id in scope (e.g. editor canvas with no selected record): empty path.
    if (!rowId) return note('Record view: no record selected');

    // Route the loading/empty/error/content decision through the shared helper.
    // A resolved record is one row; a non-existent record is the empty array.
    const directive = resolveDataState({
      isLoading: state.status === 'loading',
      rows:
        state.status === 'ready'
          ? [state.row]
          : state.status === 'empty'
            ? []
            : null,
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
        ? note(`Failed to load record: ${directive.message}`, ERROR_CHIP_STYLE)
        : React.createElement(hostType as any, wrapperProps);
    }

    if (directive.kind === 'empty') {
      return note(stringProp(node.props as Record<string, unknown> | undefined, 'emptyContent', 'Record not found'));
    }

    // CONTENT: a resolved record. (Guarded for type narrowing; kind 'content'
    // implies a ready row.)
    if (state.status !== 'ready') return React.createElement(hostType as any, wrapperProps);

    const rowScope = pushRowFrame(scope, state.row);
    const children = node.children.map((child: ComponentInstance) => (
      <React.Fragment key={child.id}>{renderNode(child, rowScope)}</React.Fragment>
    ));

    return React.createElement(hostType as any, wrapperProps, children);
  },
);

RecordViewRenderer.displayName = 'RecordViewRenderer';
export default RecordViewRenderer;
