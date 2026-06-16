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
// State handling is a MINIMAL inline placeholder until the shared
// loading/empty/error helper lands in `slice2-data-loading-empty-error-states`.
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

const NOTE_STYLE: React.CSSProperties = {
  color: '#9ca3af',
  fontSize: '12px',
  fontFamily: 'Inter, sans-serif',
  pointerEvents: 'none',
  userSelect: 'none',
};

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
}

const RecordViewRenderer = observer(
  ({ node, scope, renderNode, hostType, hostProps }: RecordViewRendererProps) => {
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

    const note = (text: string) =>
      React.createElement(
        hostType as any,
        wrapperProps,
        React.createElement('span', { style: NOTE_STYLE }, text),
      );

    if (!collectionId) return note('Record view: no record source bound');
    // No id in scope (e.g. editor canvas with no selected record): empty path.
    if (!rowId) return note('Record view: no record selected');
    if (state.status === 'loading') return note('Loading...');
    if (state.status === 'error') return note(`Failed to load record: ${state.message}`);
    if (state.status === 'empty') return note('Record not found');

    const rowScope = pushRowFrame(scope, state.row);
    const children = node.children.map((child: ComponentInstance) => (
      <React.Fragment key={child.id}>{renderNode(child, rowScope)}</React.Fragment>
    ));

    return React.createElement(hostType as any, wrapperProps, children);
  },
);

RecordViewRenderer.displayName = 'RecordViewRenderer';
export default RecordViewRenderer;
