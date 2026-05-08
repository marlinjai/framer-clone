/* eslint-disable @typescript-eslint/no-explicit-any */
// Pure render path for a component subtree.
//
// Used by both the editor (wrapped with selection/drag chrome inside
// `src/components/ComponentRenderer.tsx`) and the preview surface (mounted
// directly via HeadlessPageRenderer). Carries zero editor coupling: no store
// reads, no event handlers, no `data-component-id` attributes, no
// contenteditable. Just resolves responsive props, walks children, and emits
// React elements via the registry / intrinsic HTML tag.
'use client';
import React from 'react';
import { observer } from 'mobx-react-lite';
import { ComponentInstance } from '@/models/ComponentModel';
import { createComponentElement } from './createComponentElement';

export interface HeadlessComponentRendererProps {
  component: ComponentInstance;
  breakpointId: string;
  allBreakpoints: { id: string; minWidth: number; label?: string }[];
  primaryId: string;
}

const HeadlessComponentRenderer = observer(({
  component,
  breakpointId,
  allBreakpoints,
  primaryId,
}: HeadlessComponentRendererProps) => {
  // Honor LayersPanel visibility toggle in preview too: if the user hid the
  // node in the editor, it's hidden in preview as well.
  if (!component.canvasVisible) return null;

  const { attributes, style } = component.getResolvedProps(
    breakpointId,
    allBreakpoints,
    primaryId,
  );

  const finalProps: Record<string, unknown> = {
    ...attributes,
    style: Object.keys(style).length ? style : undefined,
  };

  const children = component.children.map((ch: ComponentInstance) => (
    <HeadlessComponentRenderer
      key={ch.id}
      component={ch}
      breakpointId={breakpointId}
      allBreakpoints={allBreakpoints}
      primaryId={primaryId}
    />
  ));

  return createComponentElement(component, finalProps, children, (attributes as any).children);
});

HeadlessComponentRenderer.displayName = 'HeadlessComponentRenderer';
export default HeadlessComponentRenderer;
