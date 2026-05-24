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

export interface CreateComponentElementOptions {
  // When present, the dispatch attaches `data-component-id` and
  // `data-inner-component-id` to the emitted element. FUNCTION components
  // receive these as props and must spread them onto their root element to
  // make the attributes visible in the DOM (an unwritten contract for entries
  // in `window.__componentRegistry`).
  identity?: { breakpointId: string; componentId: string };
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

    // Data-component placeholder branch (Wave 1 stub). Registry entries with
    // `dataComponentKind` carry a `data-component-kind` HTML attribute on
    // their default props; we use it here as the dispatch marker. When the
    // component is unbound (no source collection / record yet) and has no
    // hand-authored children, render a dashed-box label so designers see
    // immediately that the node exists and needs configuration. Wave 2 swaps
    // this branch for the real renderer in
    // `data-bindings-read-only-data-components`.
    const dataKind = propsWithIdentity['data-component-kind'] as
      | 'collection'
      | 'record-view'
      | 'table-view'
      | undefined;
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
