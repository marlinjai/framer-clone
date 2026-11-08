/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';
import React from 'react';
import { haptic } from '@/lib/haptics';
import { lastPointerIsTouch } from '@/hooks/useEditorGestureGuard';
import { computed } from 'mobx';
import { observer } from 'mobx-react-lite';
import { getSnapshot, isAlive } from 'mobx-state-tree';
import { ComponentInstance } from '../models/ComponentModel';
import { EditorTool } from '../stores/EditorUIStore';
import { useStore } from '@/hooks/useStore';
import { getUndoManager } from '@/stores/RootStore';
import { DATA_PLACEMENT_ROOT, useDragSource } from '@/lib/drag';
import { createComponentElement, RunLinksContext } from '@/lib/renderer/createComponentElement';
import { applyBindings } from '@/lib/bindings/resolver/applyBindings';
import { createScope, pushInputFrame, type BindingScope } from '@/lib/bindings/resolver/scope';
import { definitionBreakpointFor } from '@/lib/components/breakpoints';
import { bindingsAllowed, mergeStyle, pathId, placementInstance } from '@/lib/components/expand';
import { editorInputWarnings, inputValuesAt, placementStyleAt } from '@/lib/components/frameInputs';
import type { InputDefinition } from '@/lib/components/inputs';
import { COMPONENT_LIMITS, isPlacementType, type PlacementProps } from '@/lib/components/placement';
import { extractBreakpoints } from '@/lib/renderer/server/componentSnapshot';
import { EDITING_TEXT_STYLE, startInlineTextEdit } from '@/lib/canvas/inlineTextEdit';
import { INLINE_FORMAT_KEYS, applyInlineFormat, beginRunEdit, normaliseEditedText, runAtPoint } from '@/lib/canvas/inlineFormat';
import { registerOpenDraft } from '@/lib/projects/openDrafts';
import { isTextBound } from '@/lib/renderer/textContent';
import { isTextNodeType } from '@/lib/renderer/textNode';
import { childrenWithRepeats } from '@/lib/renderer/repeatChildren';
import { SurfaceDomContext, withSurfaceDom } from '@/lib/behaviour/surfaceDom';
import { ShopRepeatCopyContext } from '@/lib/commerce/shopRuntime';
import { DraftSections, useDraftHook } from '@/components/ai/PageGenDraftLayer';

interface ComponentRendererProps {
  component: ComponentInstance;
  breakpointId: string;
  allBreakpoints: { id: string; minWidth: number; label?: string }[];
  // Active binding scope. Threaded from the page root (and through data
  // renderers, which push a row frame per row) so descendants resolve
  // `{{row.field}}` / `{{page.params.*}}`. Defaults to an empty scope.
  scope?: BindingScope;
  // An ancestor is locked in the Layers panel: this node is locked too.
  lockedByAncestor?: boolean;
}

/**
 * What a definition's tree needs from around it. `breakpointId` inside is the
 * definition's own, D(P), so the frame the page shows is carried apart: it names the
 * identity attributes and maps a nested placement straight to the page. A context,
 * because a data renderer's `renderNode` callback passes only a node and a scope.
 */
interface PlacementHost {
  frameId: string;
  /** Infinity for a floating placement, which reads as the largest breakpoint. */
  frameMinWidth: number;
  /** The breakpoints of the page, which every placement maps to, however deep. */
  pageBreakpoints: readonly { id: string; minWidth: number }[];
  /** The definitions on the way down. */
  stack: readonly string[];
  /** The expanded id of the placement, as expand.ts builds it. */
  path: string;
  inputs: readonly InputDefinition[];
}

const PlacementHostContext = React.createContext<PlacementHost | null>(null);

type EditorUI = ReturnType<typeof useStore>['editorUI'];

/** A click on the canvas: `node` takes the selection, a locked one lets it bubble to its nearest unlocked ancestor. */
function selectFromClick(e: React.MouseEvent, editorUI: EditorUI, node: ComponentInstance, frameId: string, isLocked: boolean): void {
  // A link on the canvas selects, it never navigates the editor away.
  if ((e.currentTarget as HTMLElement).closest('a[href]')) e.preventDefault();
  if (isLocked) return;
  e.stopPropagation();
  if (editorUI.selectedTool !== EditorTool.SELECT) return;
  // Shift+click adds the node to the selection or takes it out.
  if (e.shiftKey) {
    editorUI.toggleInSelection(node, frameId || undefined);
    return;
  }
  // A finger that selects something new gets a light haptic tick
  // (src/lib/haptics.ts); this click is inside the user's gesture.
  const isNew = editorUI.selectedComponent?.id !== node.id;
  editorUI.selectComponent(node, frameId || undefined);
  if (isNew && lastPointerIsTouch()) haptic();
}

interface NodeRendererProps extends ComponentRendererProps {
  // Set on the root of a definition drawn for a placement. The placement is what the
  // canvas selects, moves and names; the root only supplies the element.
  placement?: ComponentInstance;
  // The placement's own style on this frame, as plain values.
  placementStyle?: Record<string, unknown>;
}

const NodeRenderer = observer(({ component, breakpointId, allBreakpoints, scope, lockedByAncestor = false, placement, placementStyle }: NodeRendererProps) => {
  const activeScope = scope ?? createScope();
  const { editorUI } = useStore();
  const host = React.useContext(PlacementHostContext);
  // Inside a link or a button, formatted text holds no links (createComponentElement).
  const runLinksAllowed = React.useContext(RunLinksContext);
  const surfaceDom = React.useContext(SurfaceDomContext);
  // Inside a later copy of a repeated shop part, only the first copy is selectable.
  const inRepeatCopy = React.useContext(ShopRepeatCopyContext);
  const frameId = host?.frameId ?? breakpointId;
  const owner = placement ?? component;
  const editRef = React.useRef<HTMLElement | null>(null);

  // Focus + select-all when entering edit mode, as a fallback only: the
  // gesture that starts editing (double-click here, double-tap in Canvas)
  // focuses the element itself, synchronously, because iOS opens the
  // keyboard only for a focus inside the gesture (src/lib/canvas/
  // inlineTextEdit.ts). When the element already has focus this leaves the
  // caret where the gesture put it.
  //
  // Only the copy in the frame where editing began becomes the text box. Every
  // breakpoint frame renders the same node; if each copy turned editable and
  // took focus, the second focus would blur the first, whose blur ends the
  // edit, so a double-click (or double-tap) never entered editing on a page
  // with more than one frame. A floating element has one copy and no frame.
  const editFrame = editorUI.selectedViewportNode?.breakpointId;
  const isEditingCopy =
    editorUI.editingComponent?.id === component.id && (!editFrame || !frameId || editFrame === frameId);
  const editingId = isEditingCopy ? component.id : undefined;
  React.useEffect(() => {
    if (editingId !== component.id) return;
    const el = editRef.current;
    if (!el || document.activeElement === el) return;
    startInlineTextEdit(el, 'all');
  }, [editingId, component.id]);

  // The text being typed is not in the project until blur or Enter: it counts
  // as unsaved work for the unload warning, and Cmd+S (or leaving the page)
  // commits it the way Enter does, so the save carries it (src/lib/projects/openDrafts.ts).
  // The box going away mid-edit (the editor closed by browser Back) writes the
  // text straight into the node: there is no blur then.
  const draftText = React.useRef<{ initial: string; read: (el: HTMLElement) => string } | null>(null);
  React.useEffect(() => {
    if (editingId !== component.id) return;
    // The element of this edit, held for the unmount (the ref is cleared by then).
    const el = editRef.current;
    const typed = () => {
      const draft = draftText.current;
      return el && draft ? draft.read(el) : undefined;
    };
    const isDirty = () => {
      const text = typed();
      return text !== undefined && text !== draftText.current?.initial;
    };
    const writeDirectly = () => {
      const text = typed();
      // Only while this edit is still open: a blur, Enter or Escape has already
      // committed or reverted it and ended the edit.
      if (editorUI.editingComponent?.id !== component.id) return;
      if (text !== undefined && isDirty() && isAlive(component)) component.setTextContent(text);
    };
    const unregister = registerOpenDraft({
      isDirty,
      // Cmd+S on the page: as Enter does (blur commits, one undo step, the edit
      // ends). A hidden tab or a page on its way out: write the text and leave
      // the edit open, the person is in the middle of it.
      commit: (how) => (how === 'end' && el && el.isConnected && document.activeElement === el ? el.blur() : writeDirectly()),
    });
    return () => {
      unregister();
      if (el && !el.isConnected) writeDirectly();
    };
  }, [editingId, component, editorUI]);

  // Only non-root tree components can be moved. The root of the app tree must
  // stay put. Text-editing suppresses drag until the user exits edit mode. A
  // text node has no element to press on: it moves from its Layers row.
  const canMove = owner.hasParent && !isTextNodeType(component.type);
  const isEditing = isEditingCopy;
  // Locked in the Layers panel (itself or an ancestor): not selectable or
  // draggable on the canvas. Pointer events pass through to the nearest
  // unlocked ancestor, which takes the click (src/lib/layers/layerActions.ts).
  const isLocked = lockedByAncestor || !!owner.canvasLocked;

  // Hook must be called unconditionally. Pass null source when the component
  // is not movable; useDragSource returns a no-op handler in that case.
  const { onPointerDown } = useDragSource(
    canMove && !isEditing && !isLocked ? { kind: 'moveNode', nodeId: owner.id } : null,
    owner,
  );
  // A running generation's draft meets this node (src/components/ai/PageGenDraftLayer.tsx):
  // never inside a placement's definition, which a generation does not target.
  const draftHook = useDraftHook(component.id, !!host || !!placement);

  // LayersPanel eye toggle writes to canvasVisible; honour it here so hidden
  // tree children disappear from the viewport. Floating elements and viewport
  // nodes get the same treatment via GroundWrapper's `visible` prop.
  if (!component.canvasVisible || !owner.canvasVisible) return null;

  // Replaced by a generation that is still being written: its draft sections
  // stand where this node will go, until the result replaces it for real.
  if (draftHook === 'replace') {
    return <DraftSections breakpointId={breakpointId} allBreakpoints={allBreakpoints} scope={activeScope} />;
  }

  // What makes an element a text box, for an element and for a text node's span.
  // Commits on blur; Enter commits, ESC cancels.
  const textBoxProps = (initialText: string, readText: (el: HTMLElement) => string) => {
    draftText.current = { initial: initialText, read: readText };
    return {
      onBlur: (e: React.FocusEvent<HTMLElement>) => {
        // The edit moved on: a format wrote this text in its own action.
        if (editorUI.editingComponent?.id !== component.id) return;
        const next = readText(e.currentTarget);
        if (next !== initialText) {
          component.setTextContent(next);
        }
        editorUI.endTextEdit();
      },
      onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => {
        e.stopPropagation();
        if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
          const key = e.key.toLowerCase();
          const format = Object.hasOwn(INLINE_FORMAT_KEYS, key) ? INLINE_FORMAT_KEYS[key] : undefined;
          if (format) {
            // Also keeps the browser's own bold from writing markup in here.
            e.preventDefault();
            applyInlineFormat(editorUI, format);
            return;
          }
          // Nothing typed in this box: the step to undo is the page's, such as the
          // format that opened it. The box has no undo of its own to offer.
          if (key === 'z' && readText(e.currentTarget) === initialText) {
            e.preventDefault();
            editorUI.endTextEdit();
            getUndoManager()?.undo();
            return;
          }
        }
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
      },
      // Remove the upstream onClick handler during editing so clicks inside the
      // textbox don't re-trigger selection.
      onClick: (e: React.MouseEvent) => e.stopPropagation(),
      onMouseDown: (e: React.MouseEvent) => e.stopPropagation(),
    };
  };

  // A text node has no element, so while it is edited it gets a span of its own
  // and nothing else in the element is editable (src/lib/canvas/inlineFormat.ts).
  // pre-wrap keeps the spaces at its edges, which separate it from its neighbours.
  if (isTextNodeType(component.type) && isEditingCopy) {
    const initialText = String(component.props?.children ?? '');
    return (
      <span
        ref={editRef}
        contentEditable="true"
        suppressContentEditableWarning
        data-inner-component-id={component.id}
        style={{ ...EDITING_TEXT_STYLE, whiteSpace: 'pre-wrap' }}
        {...textBoxProps(initialText, el => normaliseEditedText(el.textContent ?? ''))}
        // The element around it would start a drag or take the double-click.
        onPointerDown={e => e.stopPropagation()}
        onDoubleClick={e => e.stopPropagation()}
      >
        {initialText}
      </span>
    );
  }

  const { attributes, style } = component.getResolvedProps(breakpointId, allBreakpoints);

  // Apply read bindings against the active scope. Feed style in alongside the
  // attributes so dot-path slots (e.g. `style.color`) resolve, then split it
  // back out. Unbound nodes pass through unchanged.
  // A placement's style lands before the bindings, as on the published page. An input
  // binding the published page refuses for its type is refused here too.
  const allowed = host ? { bindings: bindingsAllowed(component.bindings, host.inputs, editorInputWarnings) } : component;
  const merged = placementStyle ? mergeStyle(style, placementStyle) : style;
  const { resolvedProps } = applyBindings(allowed, { ...attributes, style: merged }, activeScope);
  const { style: boundStyle, ...boundAttributes } = resolvedProps as Record<string, any>;
  // Page state as Select shows it: the behaviour pass's attributes on this node, under
  // the id the expansion gives it, which inside a placement is its path.
  const expandedId = placement ? host?.path : host ? pathId(host.path, component.id) : component.id;
  const shown = withSurfaceDom(boundAttributes, (boundStyle ?? {}) as Record<string, any>, expandedId ? surfaceDom?.get(expandedId) : undefined, 'canvas');
  const resolvedAttributes = shown.attributes as Record<string, any>;
  const effectiveStyle = shown.style as Record<string, any>;

  // In the editor, always allow pointer events so components can be selected,
  // except locked ones, which the pointer must pass through.
  const editorStyle = isLocked
    ? { ...effectiveStyle, pointerEvents: 'none' as const }
    : Object.keys(effectiveStyle).length ? { ...effectiveStyle, pointerEvents: 'auto' as const } : undefined;

  // Text-editing eligibility: a single string-valued `children` and no nested
  // components. Anything with child components renders its own subtree and
  // isn't safe to turn contenteditable (the commit reads the element's whole
  // textContent, which would flatten them): its text nodes open one at a time,
  // and an element child of it edits inline as itself.
  // Text bound to data is the binding's: it shows as the binding in the
  // properties panel and is not typed over on the canvas.
  const rawChildren = (resolvedAttributes as any).children;
  // Inside a placement the panel holds the text.
  const isTextEditable =
    !host && component.children.length === 0 && typeof rawChildren === 'string' && !isTextBound(component);

  // `data-component-id` and `data-inner-component-id` are emitted centrally
  // by `createComponentElement` (see the `identity` option below) so the
  // editor, headless preview, and static HTML paths share one source of
  // truth.
  const finalProps: Record<string, unknown> = {
    ...resolvedAttributes,
    style: editorStyle,
    onClick: (e: React.MouseEvent) => {
      selectFromClick(e, editorUI, owner, frameId, isLocked);
      if (!isLocked) (resolvedAttributes as any)?.onClick?.(e);
    },
    onDoubleClick: (e: React.MouseEvent) => {
      if (isLocked || editorUI.selectedTool !== EditorTool.SELECT) return;
      if (placement) {
        e.stopPropagation();
        e.preventDefault();
        editorUI.enterComponent((placement.props as Partial<PlacementProps>).component ?? '', placement.id);
        return;
      }
      if (!isTextEditable) {
        // Mixed with elements: the text node under the pointer opens. A press
        // on an element child is that child's.
        const element = e.currentTarget as HTMLElement;
        if (e.target !== element) return;
        const run = runAtPoint(element, component, { x: e.clientX, y: e.clientY });
        if (!run) return;
        e.stopPropagation();
        e.preventDefault();
        beginRunEdit(editorUI, component, run, element, frameId || undefined, 'all');
        return;
      }
      e.stopPropagation();
      e.preventDefault();
      // Edit in this event, before the store hears of it: the element turns
      // editable, takes focus and selects its text now (a double-tap reaches
      // here inside its touchend, which is what lets iOS open the keyboard),
      // and the re-render below renders the same attributes on the same node.
      startInlineTextEdit(e.currentTarget as HTMLElement, 'all');
      editorUI.selectComponent(component, frameId || undefined);
      editorUI.beginTextEdit(component);
    },
  };

  if (isEditing && isTextEditable) {
    // contenteditable host element.
    finalProps.contentEditable = 'true';
    finalProps.suppressContentEditableWarning = true;
    finalProps.ref = (el: HTMLElement | null) => { editRef.current = el; };
    finalProps.style = { ...editorStyle, ...EDITING_TEXT_STYLE };
    Object.assign(finalProps, textBoxProps(rawChildren as string, el => el.textContent ?? ''));
  } else if (canMove) {
    // Attach the unified drag manager's pointer handler. Click is not
    // suppressed: below the threshold, the gesture never engages and the
    // native click event still fires to handle selection.
    finalProps.onPointerDown = onPointerDown;
  }

  // What is inside a placement is its definition's: one unit on the canvas.
  const renderNode = (node: ComponentInstance, childScope: BindingScope) => (
    <ComponentRenderer
      component={node}
      breakpointId={breakpointId}
      allBreakpoints={allBreakpoints}
      scope={childScope}
      lockedByAncestor={isLocked || !!host}
    />
  );

  // A child repeated for a list is drawn once per item (src/lib/components/repeat.ts), and once, empty, on the component's own canvas when there is none.
  const ownChildren = childrenWithRepeats(component.children, activeScope, renderNode, !host);
  // A generation being written into this node: its draft after the children
  // (insert) or in their place (the page root replaced).
  const draft = draftHook ? (
    <DraftSections key="pagegen-draft" breakpointId={breakpointId} allBreakpoints={allBreakpoints} scope={activeScope} />
  ) : null;
  const children = draftHook === 'replaceChildren' ? [draft] : draftHook === 'insert' ? [...ownChildren, draft] : ownChildren;

  if (placement) finalProps[DATA_PLACEMENT_ROOT] = `${frameId}-${component.id}`;

  const element = createComponentElement(
    component,
    finalProps,
    children,
    (resolvedAttributes as any).children,
    {
      identity: { breakpointId: frameId, componentId: owner.id, copy: inRepeatCopy },
      scope: activeScope,
      renderNode,
      // Editor surface: data renderers surface an inline error chip with the
      // real message (errors must be visible to the designer).
      mode: 'editor',
      runLinksAllowed,
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

/** A placement that cannot be drawn: it stays selectable and deletable, so restoring the definition restores it. */
const MissingPlacement = observer(({ component, breakpointId, lockedByAncestor = false }: ComponentRendererProps) => {
  const { editorUI } = useStore();
  const frameId = React.useContext(PlacementHostContext)?.frameId ?? breakpointId;
  const isLocked = lockedByAncestor || !!component.canvasLocked;
  const { onPointerDown } = useDragSource(component.hasParent && !isLocked ? { kind: 'moveNode', nodeId: component.id } : null, component);
  if (!component.canvasVisible) return null;
  return (
    <div
      data-component-id={`${frameId}-${component.id}`}
      data-inner-component-id={component.id}
      {...{ [DATA_PLACEMENT_ROOT]: `${frameId}-${component.id}` }}
      style={{ border: '1px dashed orange', padding: 8, fontSize: 12, color: '#92400e', pointerEvents: isLocked ? 'none' : 'auto' }}
      onClick={e => selectFromClick(e, editorUI, component, frameId, isLocked)}
      onPointerDown={onPointerDown}
    >
      Missing component
    </div>
  );
});

type DefinitionInstance = NonNullable<ReturnType<NonNullable<EditorUI['currentProject']>['components']['get']>>;

/**
 * A definition drawn for a placement: its live tree, so an edit reaches every
 * placement at once. Nothing is rewritten here: the tree resolves at D(P) against the
 * definition's breakpoints, and the frame's id only names the identity attributes.
 * The placement's own values are keyed on what holds it, which is what `breakpointId`
 * and `allBreakpoints` are at this point, and they resolve to plain values first.
 */
const DefinedPlacement = observer(({
  component,
  definition,
  path,
  breakpointId,
  allBreakpoints,
  scope,
  lockedByAncestor,
}: ComponentRendererProps & { definition: DefinitionInstance; path: string }) => {
  const outer = React.useContext(PlacementHostContext);
  const canvasNodes = getSnapshot(definition.page.canvasNodes);
  const breakpoints = React.useMemo(() => extractBreakpoints(canvasNodes), [canvasNodes]);
  const frameId = outer?.frameId ?? breakpointId;
  const frameMinWidth = outer?.frameMinWidth ?? allBreakpoints.find(b => b.id === breakpointId)?.minWidth ?? Infinity;
  const pageBreakpoints = outer?.pageBreakpoints ?? allBreakpoints;
  const stack = outer?.stack;
  const inputs = definition.inputs;
  const host = React.useMemo(
    () => ({ frameId, frameMinWidth, pageBreakpoints, stack: [...(stack ?? []), definition.id], path, inputs }),
    [frameId, frameMinWidth, pageBreakpoints, stack, definition.id, path, inputs],
  );

  const own = definitionBreakpointFor(frameMinWidth, breakpoints)?.id ?? '';
  const instance = placementInstance(component.props as Partial<PlacementProps>, component.bindings, inputs);
  const outerScope = scope ?? createScope();
  const values = inputValuesAt(
    instance,
    { id: breakpointId, breakpoints: allBreakpoints },
    { id: own, breakpoints },
    outerScope,
  );

  const root = definition.page.appComponentTree as ComponentInstance;
  const placementStyle = placementStyleAt(
    (component.props as Partial<PlacementProps>).style,
    (root.props as { style?: unknown }).style,
    { holder: allBreakpoints, definition: breakpoints, page: pageBreakpoints },
    frameId,
  );

  return (
    <PlacementHostContext.Provider value={host}>
      <NodeRenderer
        component={root}
        breakpointId={own}
        allBreakpoints={breakpoints}
        scope={pushInputFrame(outerScope, values)}
        lockedByAncestor={lockedByAncestor}
        placement={component}
        placementStyle={placementStyle}
      />
    </PlacementHostContext.Provider>
  );
});

const PlacementRenderer = observer((props: ComponentRendererProps) => {
  const { component } = props;
  const { editorUI } = useStore();
  const outer = React.useContext(PlacementHostContext);
  const id = (component.props as Partial<PlacementProps>).component;
  const definition = typeof id === 'string' ? editorUI.currentProject?.components.get(id) : undefined;
  const stack = outer?.stack ?? [];
  const path = outer ? pathId(outer.path, component.id) : component.id;
  const page = editorUI.currentPage;
  // The published path's own verdict: a budget or a definition it cannot render. A
  // computed, so a placement redraws when its verdict changes, not on every page edit.
  const refused = React.useMemo(() => computed(() => page?.expansion.missing.has(path) ?? false), [page, path]);
  // The stack holds for a tree this page does not hold, where no verdict reaches: a
  // stored cycle would otherwise be an endless render.
  const refusable = !definition || stack.includes(definition.id) || stack.length >= COMPONENT_LIMITS.nestingDepth;
  if (refusable || refused.get()) return <MissingPlacement {...props} />;
  return <DefinedPlacement {...props} definition={definition} path={path} />;
});

/** One node of the canvas. A placement draws its definition. */
const ComponentRenderer = observer((props: ComponentRendererProps) =>
  isPlacementType(props.component.type) ? <PlacementRenderer {...props} /> : <NodeRenderer {...props} />,
);

export default ComponentRenderer;
