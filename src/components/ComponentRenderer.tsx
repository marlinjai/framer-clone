/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';
import React from 'react';
import { observer } from 'mobx-react-lite';
import { ComponentInstance } from '../models/ComponentModel';
import { EditorTool } from '../stores/EditorUIStore';
import { useStore } from '@/hooks/useStore';
import { useDragSource } from '@/lib/drag';
import { createComponentElement } from '@/lib/renderer/createComponentElement';

interface ComponentRendererProps {
  component: ComponentInstance;
  breakpointId: string;
  allBreakpoints: { id: string; minWidth: number; label?: string }[];
  primaryId: string;
}

const ComponentRenderer = observer(({ component, breakpointId, allBreakpoints, primaryId }: ComponentRendererProps) => {
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

  // In the editor, always allow pointer events so components can be selected.
  const editorStyle = Object.keys(style).length ? { ...style, pointerEvents: 'auto' as const } : undefined;

  // Text-editing eligibility: a single string-valued `children` and no nested
  // components. Anything with child components renders its own subtree and
  // isn't safe to turn contenteditable (we'd lose the children).
  const rawChildren = (attributes as any).children;
  const isTextEditable =
    component.children.length === 0 && typeof rawChildren === 'string';

  // `data-component-id` and `data-inner-component-id` are emitted centrally
  // by `createComponentElement` (see the `identity` option below) so the
  // editor, headless preview, and static HTML paths share one source of
  // truth.
  const finalProps: Record<string, unknown> = {
    ...attributes,
    style: editorStyle,
    onClick: (e: React.MouseEvent) => {
      e.stopPropagation();
      if (editorUI.selectedTool === EditorTool.SELECT) {
        editorUI.selectComponent(component, breakpointId || undefined);
      }
      (attributes as any)?.onClick?.(e);
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

  const children = component.children.map((ch: ComponentInstance) =>
    <ComponentRenderer
      key={ch.id}
      component={ch}
      breakpointId={breakpointId}
      allBreakpoints={allBreakpoints}
      primaryId={primaryId}
    />
  );

  const element = createComponentElement(
    component,
    finalProps,
    children,
    (attributes as any).children,
    { identity: { breakpointId, componentId: component.id } },
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
