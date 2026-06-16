/* eslint-disable @typescript-eslint/no-explicit-any */
// Pure render path for a component subtree.
//
// Used by both the editor (wrapped with selection/drag chrome inside
// `src/components/ComponentRenderer.tsx`) and the preview surface (mounted
// directly via HeadlessPageRenderer). Carries zero editor coupling: no store
// reads, no event handlers, no contenteditable. Just resolves responsive
// props, walks children, and emits React elements via the registry /
// intrinsic HTML tag.
//
// Identity (`data-component-id`, `data-inner-component-id`) is attached
// inside the shared `createComponentElement` dispatch so the headless
// preview and any future static HTML emitter ship the same DOM identifiers
// the editor uses for selection, drag-resolve, and cross-viewport
// highlighting.
'use client';
import React from 'react';
import { observer } from 'mobx-react-lite';
import { ComponentInstance } from '@/models/ComponentModel';
import { createComponentElement } from './createComponentElement';
import { applyBindings } from '@/lib/bindings/resolver/applyBindings';
import { createScope, type BindingScope } from '@/lib/bindings/resolver/scope';

export interface HeadlessComponentRendererProps {
  component: ComponentInstance;
  breakpointId: string;
  allBreakpoints: { id: string; minWidth: number; label?: string }[];
  primaryId: string;
  // Active binding scope (mirrors the editor `ComponentRenderer`). Threaded so
  // descendants resolve `{{row.field}}` / `{{page.params.*}}` and so the
  // editor + headless paths produce identical output. Defaults to empty.
  scope?: BindingScope;
}

const HeadlessComponentRenderer = observer(({
  component,
  breakpointId,
  allBreakpoints,
  primaryId,
  scope,
}: HeadlessComponentRendererProps) => {
  // Honor LayersPanel visibility toggle in preview too: if the user hid the
  // node in the editor, it's hidden in preview as well.
  if (!component.canvasVisible) return null;

  const activeScope = scope ?? createScope();

  const { attributes, style } = component.getResolvedProps(
    breakpointId,
    allBreakpoints,
    primaryId,
  );

  // Apply read bindings against the active scope. Style is fed in alongside
  // attributes so `style.*` slots resolve, then split back out.
  const { resolvedProps } = applyBindings(component, { ...attributes, style }, activeScope);
  const { style: boundStyle, ...resolvedAttributes } = resolvedProps as Record<string, unknown>;
  const effectiveStyle = (boundStyle ?? {}) as Record<string, unknown>;

  const finalProps: Record<string, unknown> = {
    ...resolvedAttributes,
    style: Object.keys(effectiveStyle).length ? effectiveStyle : undefined,
  };

  const renderNode = (node: ComponentInstance, childScope: BindingScope) => (
    <HeadlessComponentRenderer
      component={node}
      breakpointId={breakpointId}
      allBreakpoints={allBreakpoints}
      primaryId={primaryId}
      scope={childScope}
    />
  );

  const children = component.children.map((ch: ComponentInstance) => (
    <React.Fragment key={ch.id}>{renderNode(ch, activeScope)}</React.Fragment>
  ));

  return createComponentElement(component, finalProps, children, (resolvedAttributes as any).children, {
    identity: { breakpointId, componentId: component.id },
    scope: activeScope,
    renderNode,
  });
});

HeadlessComponentRenderer.displayName = 'HeadlessComponentRenderer';
export default HeadlessComponentRenderer;
