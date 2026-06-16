/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';
import React from 'react';
import { observer } from 'mobx-react-lite';
import { ComponentInstance } from '../models/ComponentModel';
import { EditorTool } from '../stores/EditorUIStore';
import { useStore } from '@/hooks/useStore';
import { useDragSource } from '@/lib/drag';
import { createComponentElement } from '@/lib/renderer/createComponentElement';
import { applyBindings } from '@/lib/bindings/resolver/applyBindings';
import { createScope, type BindingScope } from '@/lib/bindings/resolver/scope';

interface ComponentRendererProps {
  component: ComponentInstance;
  breakpointId: string;
  allBreakpoints: { id: string; minWidth: number; label?: string }[];
  primaryId: string;
  // Active binding scope. Threaded from the page root (and through data
  // renderers, which push a row frame per row) so descendants resolve
  // `{{row.field}}` / `{{page.params.*}}`. Defaults to an empty scope.
  scope?: BindingScope;
}

const ComponentRenderer = observer(({ component, breakpointId, allBreakpoints, primaryId, scope }: ComponentRendererProps) => {
  const activeScope = scope ?? createScope();
  const { editorUI } = useStore();
  const editRef = React.useRef<HTMLElement | null>(null);

  // Autofocus + select-all when entering edit mode so the user can immediately
  // type to replace the placeholder text.
  const editingId = editorUI.editingComponent?.id;
  React.useEffect(() => {
    if (editingId !== component.id) return;
    const el = editRef.current;
    if (!el) return;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }, [editingId, component.id]);

  // Only non-root tree components can be moved. The root of the app tree must
  // stay put. Text-editing suppresses drag until the user exits edit mode.
  const canMove = component.hasParent;
  const isEditing = editorUI.editingComponent?.id === component.id;

  // Hook must be called unconditionally. Pass null source when the component
  // is not movable; useDragSource returns a no-op handler in that case.
  const { onPointerDown } = useDragSource(
    canMove && !isEditing ? { kind: 'moveNode', nodeId: component.id } : null,
    component,
  );

  // LayersPanel eye toggle writes to canvasVisible; honour it here so hidden
  // tree children disappear from the viewport. Floating elements and viewport
  // nodes get the same treatment via GroundWrapper's `visible` prop.
  if (!component.canvasVisible) return null;

  const { attributes, style } = component.getResolvedProps(breakpointId, allBreakpoints, primaryId);

  // Apply read bindings against the active scope. Feed style in alongside the
  // attributes so dot-path slots (e.g. `style.color`) resolve, then split it
  // back out. Unbound nodes pass through unchanged.
  const { resolvedProps } = applyBindings(component, { ...attributes, style }, activeScope);
  const { style: boundStyle, ...resolvedAttributes } = resolvedProps as Record<string, any>;
  const effectiveStyle = (boundStyle ?? {}) as Record<string, any>;

  // In the editor, always allow pointer events so components can be selected.
  const editorStyle = Object.keys(effectiveStyle).length ? { ...effectiveStyle, pointerEvents: 'auto' as const } : undefined;

  // Text-editing eligibility: a single string-valued `children` and no nested
  // components. Anything with child components renders its own subtree and
  // isn't safe to turn contenteditable (we'd lose the children).
  const rawChildren = (resolvedAttributes as any).children;
  const isTextEditable =
    component.children.length === 0 && typeof rawChildren === 'string';

  // `data-component-id` and `data-inner-component-id` are emitted centrally
  // by `createComponentElement` (see the `identity` option below) so the
  // editor, headless preview, and static HTML paths share one source of
  // truth.
  const finalProps: Record<string, unknown> = {
    ...resolvedAttributes,
    style: editorStyle,
    onClick: (e: React.MouseEvent) => {
      e.stopPropagation();
      if (editorUI.selectedTool === EditorTool.SELECT) {
        editorUI.selectComponent(component, breakpointId || undefined);
      }
      (resolvedAttributes as any)?.onClick?.(e);
    },
    onDoubleClick: (e: React.MouseEvent) => {
      if (!isTextEditable) return;
      if (editorUI.selectedTool !== EditorTool.SELECT) return;
      e.stopPropagation();
      e.preventDefault();
      editorUI.selectComponent(component, breakpointId || undefined);
      editorUI.beginTextEdit(component);
    },
  };

  if (isEditing && isTextEditable) {
    // contenteditable host element. Commits on blur; Enter commits, ESC cancels.
    finalProps.contentEditable = 'true';
    finalProps.suppressContentEditableWarning = true;
    finalProps.ref = editRef;
    finalProps.style = { ...editorStyle, cursor: 'text', outline: '2px solid #3b82f6' };
    const initialText = rawChildren as string;
    finalProps.onBlur = (e: React.FocusEvent<HTMLElement>) => {
      const next = e.currentTarget.textContent ?? '';
      if (next !== initialText) {
        component.setTextContent(next);
      }
      editorUI.endTextEdit();
    };
    finalProps.onKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        (e.currentTarget as HTMLElement).blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        // Revert the DOM text before blurring so onBlur doesn't commit the
        // in-progress edit.
        e.currentTarget.textContent = initialText;
        (e.currentTarget as HTMLElement).blur();
      }
    };
    // Remove the upstream onClick handler during editing so clicks inside the
    // textbox don't re-trigger selection.
    finalProps.onClick = (e: React.MouseEvent) => e.stopPropagation();
    finalProps.onMouseDown = (e: React.MouseEvent) => e.stopPropagation();
  } else if (canMove) {
    // Attach the unified drag manager's pointer handler. Click is not
    // suppressed: below the threshold, the gesture never engages and the
    // native click event still fires to handle selection.
    finalProps.onPointerDown = onPointerDown;
  }

  const renderNode = (node: ComponentInstance, childScope: BindingScope) => (
    <ComponentRenderer
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

  const element = createComponentElement(
    component,
    finalProps,
    children,
    (resolvedAttributes as any).children,
    {
      identity: { breakpointId, componentId: component.id },
      scope: activeScope,
      renderNode,
      // Editor surface: data renderers surface an inline error chip with the
      // real message (errors must be visible to the designer).
      mode: 'editor',
    },
  );

  // The editor surfaces unknown component types as a visible placeholder so
  // designers immediately see something is misconfigured. The headless
  // renderer just returns null for the same case (silent in preview).
  if (element === null && !component.isHostElement) {
    return (
      <div style={{ border: '1px dashed orange', padding: 8, fontSize: 12, color: '#92400e' }}>
        Unknown component: {component.type}
        {children}
      </div>
    );
  }
  return element;
});

export default ComponentRenderer;
