/* eslint-disable @typescript-eslint/no-explicit-any */
// Shared HOST / FUNCTION / void-tag dispatch used by both renderers.
//
// Editor and headless renderers build their own `finalProps` (the editor adds
// data-* IDs and event handlers; headless does not) but the actual emit step
// is identical: void tags must not receive children, host elements forward
// children, function components are looked up in the runtime registry.
import React from 'react';
import { ComponentInstance } from '@/models/ComponentModel';
import { isVoidTag } from '@/lib/drag';

export function createComponentElement(
  component: ComponentInstance,
  finalProps: Record<string, unknown>,
  children: React.ReactNode[],
  rawTextChildren?: React.ReactNode,
): React.ReactNode {
  if (component.isHostElement) {
    if (isVoidTag(component.type as string)) {
      const props = { ...finalProps };
      if ('children' in props) delete (props as any).children;
      return React.createElement(component.type as any, props);
    }
    const content: React.ReactNode = children.length ? children : rawTextChildren;
    return React.createElement(component.type as any, finalProps, content);
  }

  const Impl = (window as any).__componentRegistry?.[component.type];
  if (Impl) {
    return <Impl {...finalProps}>{children}</Impl>;
  }

  return null;
}
