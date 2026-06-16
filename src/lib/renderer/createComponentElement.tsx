/* eslint-disable @typescript-eslint/no-explicit-any */
// Shared HOST / FUNCTION / void-tag dispatch used by both renderers.
//
// Editor and headless renderers build their own `finalProps` (the editor adds
// event handlers; headless does not) but the actual emit step is identical:
// void tags must not receive children, host elements forward children,
// function components are looked up in the runtime registry.
//
// Identity attributes (`data-component-id`, `data-inner-component-id`) are
// injected here so every renderer (editor, headless preview, future static
// HTML emitter) ships the same DOM identifiers. Lumitra Studio cross-domain
// matching, drag resolution, and selection overlays all key off these.
import React from 'react';
import { ComponentInstance } from '@/models/ComponentModel';
import { isVoidTag } from '@/lib/drag';
import type { BindingScope } from '@/lib/bindings/resolver/scope';
import { createScope } from '@/lib/bindings/resolver/scope';
import CollectionRenderer, {
  type RenderNode,
} from '@/lib/renderer/data/CollectionRenderer';
import RecordViewRenderer from '@/lib/renderer/data/RecordViewRenderer';
import TableViewRenderer from '@/lib/renderer/data/TableViewRenderer';

export interface CreateComponentElementOptions {
  // When present, the dispatch attaches `data-component-id` and
  // `data-inner-component-id` to the emitted element. FUNCTION components
  // receive these as props and must spread them onto their root element to
  // make the attributes visible in the DOM (an unwritten contract for entries
  // in `window.__componentRegistry`).
  identity?: { breakpointId: string; componentId: string };

  // Binding scope active for this node. Threaded by both host renderers so
  // BOUND data components (Collection / RecordView) can resolve their source
  // and push row frames. Defaults to an empty scope when omitted.
  scope?: BindingScope;

  // Recursion callback into the active host renderer (editor vs headless).
  // The data renderers use it to render the per-row template against a
  // row-scoped binding chain, which keeps editor and headless output
  // identical. Required for data-component dispatch; ordinary nodes ignore it.
  renderNode?: RenderNode;

  // Rendering surface for the data renderers' error split: 'editor' surfaces
  // an inline error chip with the real message, 'preview' (preview/headless/
  // static emit) renders nothing for an errored slot. Defaults to 'preview'
  // (the safe SSR/published-site behavior).
  mode?: 'editor' | 'preview';
}

export function createComponentElement(
  component: ComponentInstance,
  finalProps: Record<string, unknown>,
  children: React.ReactNode[],
  rawTextChildren?: React.ReactNode,
  options?: CreateComponentElementOptions,
): React.ReactNode {
  const identity = options?.identity;
  const propsWithIdentity: Record<string, unknown> = identity
    ? {
        ...finalProps,
        'data-component-id': `${identity.breakpointId}-${identity.componentId}`,
        'data-inner-component-id': identity.componentId,
      }
    : finalProps;

  if (component.isHostElement) {
    if (isVoidTag(component.type as string)) {
      const props = { ...propsWithIdentity };
      if ('children' in props) delete (props as any).children;
      return React.createElement(component.type as any, props);
    }

    // Data-component dispatch. Registry entries with `dataComponentKind`
    // carry a `data-component-kind` HTML attribute on their default props; we
    // use it here as the dispatch marker.
    const dataKind = propsWithIdentity['data-component-kind'] as
      | 'collection'
      | 'record-view'
      | 'table-view'
      | undefined;

    // BOUND data nodes dispatch to the real data renderers, which own their
    // own (per-row) children construction and ignore the generic `children`
    // built by the host renderer. `table-view` now routes to TableViewRenderer
    // (slice2-tableview-renderer): the host wrapper carries identity attrs and
    // container styling while the read-only TableView renders inside it.
    if (dataKind && component.hasBindings) {
      const scope = options?.scope ?? createScope();
      const renderNode = options?.renderNode;
      const mode = options?.mode ?? 'preview';
      if (renderNode && dataKind === 'collection') {
        return (
          <CollectionRenderer
            node={component}
            scope={scope}
            renderNode={renderNode}
            hostType={component.type as string}
            hostProps={propsWithIdentity}
            mode={mode}
          />
        );
      }
      if (renderNode && dataKind === 'record-view') {
        return (
          <RecordViewRenderer
            node={component}
            scope={scope}
            renderNode={renderNode}
            hostType={component.type as string}
            hostProps={propsWithIdentity}
            mode={mode}
          />
        );
      }
      if (dataKind === 'table-view') {
        const wrapperProps = { ...propsWithIdentity };
        delete (wrapperProps as any).children;
        return React.createElement(
          component.type as any,
          wrapperProps,
          <TableViewRenderer node={component} scope={scope} />,
        );
      }
    }

    // Unbound data node: render a dashed-box label (the Wave 1 stub) so
    // designers see immediately that the node exists and needs configuration.
    if (dataKind && !component.hasBindings && children.length === 0) {
      const label =
        dataKind === 'collection'
          ? 'Collection'
          : dataKind === 'record-view'
            ? 'Record view'
            : 'Table view';
      const placeholder = React.createElement(
        'span',
        {
          style: {
            color: '#9ca3af',
            fontSize: '12px',
            fontFamily: 'Inter, sans-serif',
            pointerEvents: 'none',
            userSelect: 'none',
          },
        },
        `${label} (no binding)`,
      );
      return React.createElement(component.type as any, propsWithIdentity, placeholder);
    }

    const content: React.ReactNode = children.length ? children : rawTextChildren;
    return React.createElement(component.type as any, propsWithIdentity, content);
  }

  const Impl = (window as any).__componentRegistry?.[component.type];
  if (Impl) {
    return <Impl {...propsWithIdentity}>{children}</Impl>;
  }

  return null;
}
