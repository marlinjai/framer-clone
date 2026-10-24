/* eslint-disable @typescript-eslint/no-explicit-any */
// src/lib/renderer/forms/editorFormElement.tsx
//
// The form components on the editor canvas and in the preview: rendered
// statically, never submitting (published site essentials, decision 4).
//
//   - `form`:        a real <form> (the same tag the published page uses, so
//                    the canvas styles match) that swallows submit events and
//                    lets the browser validate nothing;
//   - `form-field`:  FormFieldView in 'editor' mode: the label, the control and
//                    an empty error line, the control unfocusable, so a click
//                    selects the field component;
//   - `form-submit`: a type="button" button showing the label.
//
// The field's spec comes from the enclosing form when there is one (so a
// repeated name shows the key the server will use), else from the field alone.

import React from 'react';
import { getParent, hasParent, isStateTreeNode } from 'mobx-state-tree';
import type { ComponentInstance } from '@/models/ComponentModel';
import {
  collectFormFields,
  formKindOf,
  readFieldAppearance,
  readFieldSpec,
  stripFormConfigProps,
  type FormKind,
} from '@/lib/forms/definition';
import { FormFieldView } from './FormFieldView';

const preventSubmit = (e: React.FormEvent) => e.preventDefault();

/** The enclosing form container of a canvas component, if any (walks the MST parents). */
function enclosingForm(component: ComponentInstance): any | null {
  // MST nodes only; a component's parent is the children array, its parent the component.
  let current: any = component;
  for (let i = 0; i < 128 && current && isStateTreeNode(current) && hasParent(current); i++) {
    current = getParent(current);
    if (current && !Array.isArray(current) && typeof current === 'object' && 'props' in current) {
      if (formKindOf(current.props) === 'form') return current;
    }
  }
  return null;
}

export function formKindOfComponent(component: ComponentInstance): FormKind | null {
  return formKindOf(component.props as Record<string, unknown>);
}

export function createEditorFormElement(
  kind: FormKind,
  component: ComponentInstance,
  props: Record<string, unknown>,
  children: React.ReactNode,
): React.ReactNode {
  const domProps = stripFormConfigProps(props);
  if (kind === 'form') {
    delete (domProps as any).children;
    return React.createElement('form', { ...domProps, noValidate: true, onSubmit: preventSubmit }, children);
  }
  if (kind === 'form-submit') {
    // The text the host renderer resolved (inline text editing writes it), else a default.
    const label = typeof children === 'string' || typeof children === 'number' ? children : 'Send';
    delete (domProps as any).children;
    return React.createElement('button', { ...domProps, type: 'button' }, label);
  }
  delete (domProps as any).children;
  const form = enclosingForm(component);
  const fromForm = form ? collectFormFields(form).find((f) => f.nodeId === component.id) : undefined;
  const field = fromForm ?? readFieldSpec(component as any, 0);
  return (
    <FormFieldView
      formId={form?.id ?? 'canvas'}
      field={field}
      appearance={readFieldAppearance(component.props as Record<string, unknown>)}
      wrapperProps={domProps}
      mode="editor"
    />
  );
}
