// src/components/ResponsivePageRenderer.tsx
// Renders all canvas nodes using Framer-style unified approach.
//
// Drag behavior is owned entirely by the unified DragManager:
//   - Viewport and floating wrappers attach `onPointerDown` via useDragSource;
//     DragManager decides if the gesture engages (past threshold), updates
//     canvasX/Y live during drag, and on release either reparents into a
//     tree target or commits the new floating coords.
//   - Drop targets inside viewports and floating subtrees are discovered via
//     `data-viewport-id` / `data-floating-root-id` / `data-inner-component-id`,
//     which the resolver walks up to find.
//
// No HTML5 drag handlers, no elementFromPoint-in-render, no per-viewport
// hover highlight state. The DropIndicatorLayer (mounted in EditorApp)
// paints the single shared indicator each frame.
'use client';
import React from 'react';
import { observer } from 'mobx-react-lite';
import { isAlive } from 'mobx-state-tree';
import type { ComponentInstance } from '@/models/ComponentModel';
import type { PageModelType } from '@/models/PageModel';
import type { SiteTheme } from '@/lib/site/theme';
import ComponentRenderer from './ComponentRenderer';
import PageFontFaces from '@/lib/fonts/PageFontFaces';
import { CanvasRuleStyles, type CanvasRuleStylesProps } from '@/lib/rules/CanvasRuleStyles';
import { FLOATING_ROOT, VIEWPORT_ROOT } from '@/lib/rules/surfaces';
import { PageBaseStyles } from '@/lib/site/PageBaseStyles';
import { SurfaceThemeStyles } from '@/lib/site/SurfaceThemeStyles';
import { surfaceFrameAttributes } from '@/lib/site/surfaceTheme';
import type { SurfaceNode } from '@/lib/rules/surfaceSheet';
import GroundWrapper from './GroundWrapper';
import { useStore } from '@/hooks/useStore';
import { useDragSource } from '@/lib/drag';
import {
  viewportFrameContentStyle,
  viewportFrameLabel,
} from '@/lib/canvas/viewportFrame';
import {
  createScope,
  pushInputFrame,
  pushPageFrame,
  type BindingScope,
} from '@/lib/bindings/resolver/scope';
import { defaultValuesAt } from '@/lib/components/frameInputs';
import { useProductPageParams } from '@/lib/commerce/productPreview';
import { surfaceBehaviour, type PreviewValues } from '@/lib/behaviour/surfaceBehaviour';
import type { BehaviourProgram } from '@/lib/behaviour/program';
import { useSurfaceRuntime } from '@/lib/behaviour/useSurfaceRuntime';
import { startInteractFrame } from '@/lib/canvas/interactShim';
import { pageForSitePath } from '@/lib/site/sitePath';
import { SurfaceDomContext, useStableSurfaceDom } from '@/lib/behaviour/surfaceDom';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';

// Parse a CSS length into pixels for GroundWrapper sizing. Accepts a raw
// number or a `<n>px` string. Anything else (e.g. '100%', 'auto',
// 'fit-content') returns `undefined` so callers can fall back. GroundWrapper
// needs concrete pixel dimensions because it's position: fixed and transforms
// to track the cursor; percentage widths would resolve against the window.
function parsePxDim(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const match = value.match(/^(-?\d+(?:\.\d+)?)px$/);
    if (match) return parseFloat(match[1]);
  }
  return undefined;
}

// Fallback canvas size for floating elements whose style uses fluid units
// (`100%`, `auto`, etc.). Chosen to match the previous Container default so
// a floating Container with the new fluid styles still appears as a
// reasonable box on empty canvas. User resize writes back concrete px via
// updateResponsiveStyle, so this is only the initial-mount default.
const FLOATING_FALLBACK_WIDTH = 240;
const FLOATING_FALLBACK_HEIGHT = 160;

// The frame's size when the viewport node holds none, here and in the rule sheet.
const FRAME_FALLBACK_WIDTH = 400;
const FRAME_FALLBACK_HEIGHT = 600;

const CANVAS_ROOTS = [VIEWPORT_ROOT, FLOATING_ROOT];

/**
 * A frame's content in Interact. The canvas takes text selection away (`select-none` on
 * the ground), which would leave a field's text and a paragraph unselectable, so the page
 * gets it back. Touch is Canvas.tsx's: the ground drops `touch-action: none` in Interact.
 */
const INTERACT_CONTENT_STYLE: React.CSSProperties = { userSelect: 'text', WebkitUserSelect: 'text' };

// Apart from ResponsivePageRenderer, so an edit redraws these and not every frame:
// both read the page's expansion, which changes with any node.
const PageFonts = observer(({ page, theme }: { page: PageModelType; theme: SiteTheme }) => <PageFontFaces roots={page.canvasFontRoots} theme={theme} />);

/**
 * The page's behaviour on the canvas: the pass over the expansion. In Select a preview
 * stands for first values; in Interact the page runs from its real first values.
 */
function useCanvasBehaviour(page: PageModelType) {
  const { editorUI } = useStore();
  const { root, floating } = page.expansion;
  const preview = editorUI.interactOn ? NO_PREVIEW : editorUI.previewState;
  return { root: surfaceBehaviour(root, preview), floating: floating.map((element: ComponentNode) => surfaceBehaviour(element, preview)) };
}

const NO_PREVIEW: PreviewValues = {};

/**
 * The page running in one frame, in the Interact tool: the runtime with the program of the
 * frame's tree, the page root's or a floating element's, and the frame's own handling of
 * ids, links and forms (src/lib/canvas/interactShim.ts). Apart from the frame, so an edit
 * restarts this and draws nothing else again. Each frame holds its own state.
 */
const InteractFrame = observer(({ frame, floatingId }: { frame: React.RefObject<HTMLDivElement | null>; floatingId?: string }) => {
  const { editorUI } = useStore();
  const page = editorUI.currentPage;
  const live = editorUI.interactOn && !!page;
  let program: BehaviourProgram | null = null;
  if (live && page) {
    const { root, floating } = page.expansion;
    const tree = floatingId === undefined ? root : floating.find((element: ComponentNode) => element.id === floatingId);
    program = tree ? surfaceBehaviour(tree).program : null;
  }
  useSurfaceRuntime(frame, program, 'canvas', live);
  React.useEffect(() => {
    const element = frame.current;
    if (!element || !live) return;
    const stop = startInteractFrame(element, {
      sitePath: (path) => followSitePath(editorUI, path),
      refused: (message) => editorUI.setEditorNotice({ kind: 'refused', message }),
    });
    return () => {
      stop();
      // The frame clips and has no scroller, but focus moving to an element below its
      // edge scrolls it all the same. Leaving puts the page back at its top.
      element.scrollTop = 0;
      element.scrollLeft = 0;
    };
  }, [frame, live, editorUI]);
  return null;
});

/** A link to a path of the site, followed in Interact: the editor opens that page, still in Interact. */
function followSitePath(editorUI: ReturnType<typeof useStore>['editorUI'], path: string): void {
  const project = editorUI.currentProject;
  const target = project ? pageForSitePath(project, path) : null;
  const page = target ? project?.getPage(target.pageId) : undefined;
  if (!target || !page) {
    editorUI.setEditorNotice({ kind: 'refused', message: `This site has no page at ${path}.` });
    return;
  }
  if (target.product) editorUI.setPreviewProductHandle(target.handle);
  editorUI.setCurrentPage(page);
}

// The expanded page, so a rule inside a definition shows on each placement of it, after
// the behaviour pass, so a rule reading page state shows at the state previewed.
const PageRuleStyles = observer(({ page, ...sheet }: { page: PageModelType } & Pick<CanvasRuleStylesProps, 'frames' | 'breakpoints'>) => {
  const { root, floating } = useCanvasBehaviour(page);
  return (
    <CanvasRuleStyles
      {...sheet}
      tree={root.root as SurfaceNode}
      definitionTree={page.isDefinitionPage}
      floating={floating.map(applied => applied.root) as SurfaceNode[]}
      problems={[...root.problems, ...floating.flatMap(applied => applied.problems)]}
    />
  );
});

// Apart from ResponsivePageRenderer, so a change of state redraws the nodes it reaches.
const CanvasBehaviour = observer(({ page, children }: { page: PageModelType; children: React.ReactNode }) => {
  const { root, floating } = useCanvasBehaviour(page);
  const dom = useStableSurfaceDom([root.dom, ...floating.map(applied => applied.dom)]);
  return <SurfaceDomContext.Provider value={dom}>{children}</SurfaceDomContext.Provider>;
});

const ResponsivePageRenderer = observer(() => {
  const rootStore = useStore();
  const project = rootStore.editorUI.currentProject;
  const page = rootStore.editorUI.currentPage;
  const pageParams = useProductPageParams(page?.slug);
  if (!project || !page) return null;

  const { appComponentTree } = page;
  const viewportNodes = page.sortedViewportNodes;

  const breakpoints = viewportNodes.map(viewport => ({
    id: viewport.breakpointId!,
    minWidth: viewport.breakpointMinWidth!,
    label: viewport.label!,
  }));


  // Root binding scope: a page frame carrying route params. The editor canvas
  // has no concrete route, so a bound RecordView resolves `{{page.params.id}}`
  // to undefined and shows its empty state until preview/publish supplies real
  // params; only a product page gets a param, the product being previewed. The
  // product page path makes `{{product.href}}` resolve as on the published site.
  const rootScope: BindingScope = pushPageFrame(createScope(), pageParams, project.productPagePath);
  // A definition drawn on its own canvas shows its defaults, through the frame a
  // placement uses. Its maps are keyed on its own frames, so each frame reads its own.
  const inputs = page.definitionInputs;
  const scopeOf = (breakpointId: string): BindingScope =>
    inputs ? pushInputFrame(rootScope, defaultValuesAt(inputs, { id: breakpointId, breakpoints }, rootScope)) : rootScope;

  return (
    <>
      {/* The self-hosted web fonts the page uses (src/lib/fonts/registry.ts). */}
      <PageFonts page={page} theme={project.site.theme} />
      {/* The site's page base, as the published page has it. */}
      <PageBaseStyles base={project.site.pageBase} roots={CANVAS_ROOTS} />
      {/* The site's theme on each frame, after the base and before the rules, as published. */}
      <SurfaceThemeStyles theme={project.site.theme} base={project.site.pageBase} />
      {/* props.rules, for every frame. Here and not beside a node: see the component. */}
      <PageRuleStyles
        page={page}
        frames={viewportNodes.map(viewport => ({
          breakpointId: viewport.breakpointId!,
          width: viewport.viewportWidth ?? FRAME_FALLBACK_WIDTH,
          height: viewport.viewportHeight ?? FRAME_FALLBACK_HEIGHT,
        }))}
        breakpoints={breakpoints}
      />
      <CanvasBehaviour page={page}>
      {/* 1. Viewport frames */}
      {viewportNodes.map(viewport => (
        <ViewportFrame
          key={viewport.id}
          viewport={viewport}
          appComponentTree={appComponentTree}
          breakpoints={breakpoints}
          scope={scopeOf(viewport.breakpointId!)}
        />
      ))}

      {/* 2. Floating elements */}
      {page.floatingElements.map(element => (
        <FloatingElement
          key={element.id}
          element={element}
          breakpoints={breakpoints}
          scope={scopeOf('')}
        />
      ))}
      </CanvasBehaviour>
    </>
  );
});

// --- ViewportFrame -------------------------------------------------------

interface ViewportFrameProps {
  viewport: ComponentInstance;
  appComponentTree: ComponentInstance;
  breakpoints: { id: string; minWidth: number; label?: string }[];
  scope: BindingScope;
}

export const ViewportFrame = observer(({
  viewport,
  appComponentTree,
  breakpoints,
  scope,
}: ViewportFrameProps) => {
  const { editorUI } = useStore();
  // In Interact the frame is the page's: nothing on it selects or moves.
  const interact = editorUI.interactOn;
  const { onPointerDown } = useDragSource(
    interact ? null : { kind: 'moveNode', nodeId: viewport.id },
    viewport,
  );
  const frameRef = useRenderedFrameHeight(viewport);
  const contentRef = React.useRef<HTMLDivElement>(null);

  const width = viewport.viewportWidth ?? FRAME_FALLBACK_WIDTH;
  const minHeight = viewport.viewportHeight ?? FRAME_FALLBACK_HEIGHT;
  const label = viewportFrameLabel(width, minHeight, viewport.renderedViewportHeight);

  return (
    <GroundWrapper
      id={viewport.id}
      x={viewport.canvasX!}
      y={viewport.canvasY!}
      // The wrapper follows the frame: fixed width, height grows with content.
      width={width}
      height="auto"
      visible={viewport.canvasVisible}
      className={interact ? 'viewport-node' : 'viewport-node cursor-grab hover:cursor-grab'}
      onClick={interact ? undefined : (e) => {
        e.stopPropagation();
        editorUI.setSelectedViewportNode(viewport);
      }}
      onPointerDown={interact ? undefined : onPointerDown}
    >
      {/*
        Outer box: the frame's chrome (background, shadow, rounded corners),
        the drop / hit-test marker and the anchor for the label above it. It
        has no height of its own; it is exactly as tall as the clipping box
        below, which is at least viewportHeight and grows with the page.
      */}
      <div
        ref={frameRef}
        className="relative bg-white shadow-lg rounded-lg transition-shadow"
        style={{ width: `${width}px` }}
        data-viewport-id={viewport.id}
        data-breakpoint-id={viewport.breakpointId}
      >
        {/* Viewport label - clickable for viewport selection */}
        <div
          className="absolute -top-8 left-0 text-sm font-medium text-gray-600 cursor-pointer hover:bg-gray-100 rounded px-2 py-1 -mx-2 -my-1"
          onClick={interact ? undefined : (e) => {
            e.stopPropagation();
            editorUI.setSelectedViewportNode(viewport);
          }}
        >
          <div className="flex items-center gap-2 whitespace-nowrap">
            <div className="text-gray-600">{viewport.label}</div>
            <div className="px-2 py-0.5 bg-gray-200 rounded text-xs">
              {viewport.breakpointMinWidth}px
            </div>
            <div
              className="px-2 py-0.5 bg-brand/15 text-brand rounded text-xs"
              title={`Frame size on the canvas. Minimum height ${minHeight}px; the frame grows with the page content.`}
              data-testid="viewport-frame-size"
            >
              {label.size}
              {label.minNote && <span className="ml-1 opacity-70">({label.minNote})</span>}
            </div>
          </div>
        </div>

        {/*
          Clipping box for the page tree. See viewportFrameContentStyle: no
          inner scroller (the canvas owns the wheel, so one would be
          unreachable), grows with the content, and clips absolutely and
          fixed positioned descendants so nothing paints outside the frame.
        */}
        <div
          ref={contentRef}
          className={editorUI.frameDarkClass ? 'rounded-lg dark' : 'rounded-lg'}
          style={interact ? { ...viewportFrameContentStyle(minHeight), ...INTERACT_CONTENT_STYLE } : viewportFrameContentStyle(minHeight)}
          data-viewport-content-id={viewport.id}
          // The page box stands for the page: the theme's tokens, scheme and document
          // block land here, never on the frame's label or chrome (SurfaceThemeStyles).
          {...surfaceFrameAttributes('frame', editorUI.frameColorScheme)}
        >
          <InteractFrame frame={contentRef} />
          {appComponentTree && (
            <ComponentRenderer
              // A new run of Interact, or its end, draws the page afresh: nothing the page
              // changed natively, such as a `details` opened, outlives it.
              key={editorUI.interactEpoch}
              component={appComponentTree}
              breakpointId={viewport.breakpointId!}
              allBreakpoints={breakpoints}
              scope={scope}
            />
          )}
        </div>
      </div>
    </GroundWrapper>
  );
});

/**
 * Measures a viewport frame's rendered height and reports it to the model
 * (ComponentModel.renderedViewportHeight, volatile) so MobX-driven consumers
 * (the frame label, the HUD's frame selection overlay and resize handles) see
 * the frame's real height. Uses offsetHeight, which is layout px and ignores
 * the canvas zoom transform. Writing back is safe from loops: the measured
 * value only feeds overlays and the label, never the frame's own CSS height.
 */
function useRenderedFrameHeight(viewport: ComponentInstance) {
  const [el, setEl] = React.useState<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!el) return;
    // A deleted viewport node is destroyed before React unmounts its frame;
    // never write to a dead MobX-State-Tree node.
    const report = () => {
      if (isAlive(viewport)) viewport.setRenderedViewportHeight(el.offsetHeight);
    };
    report();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
  }, [el, viewport]);

  // Forget the measurement when the frame unmounts (page switch), so a stale
  // height never outlives its DOM.
  React.useEffect(() => () => {
    if (isAlive(viewport)) viewport.setRenderedViewportHeight(undefined);
  }, [viewport]);

  return setEl;
}

// --- FloatingElement -----------------------------------------------------

interface FloatingElementProps {
  element: ComponentInstance;
  breakpoints: { id: string; minWidth: number; label?: string }[];
  scope: BindingScope;
}

const FloatingElement = observer(({
  element,
  breakpoints,
  scope,
}: FloatingElementProps) => {
  const { editorUI } = useStore();
  const interact = editorUI.interactOn;
  const contentRef = React.useRef<HTMLDivElement>(null);
  // Locked floating elements are not dragged from the canvas (the Layers
  // panel still moves them), and in Interact nothing is.
  const { onPointerDown } = useDragSource(
    element.canvasLocked || interact ? null : { kind: 'moveNode', nodeId: element.id },
    element,
  );

  return (
    <GroundWrapper
      id={element.id}
      x={element.canvasX!}
      y={element.canvasY!}
      scale={element.canvasScale}
      rotation={element.canvasRotation}
      zIndex={element.canvasZIndex}
      width={parsePxDim(element.props?.style?.width) ?? FLOATING_FALLBACK_WIDTH}
      height={parsePxDim(element.props?.style?.height) ?? FLOATING_FALLBACK_HEIGHT}
      visible={element.canvasVisible}
      locked={element.canvasLocked && !interact}
      className={interact ? 'floating-element' : 'floating-element cursor-grab hover:cursor-grab'}
      onClick={interact ? undefined : (e) => {
        e.stopPropagation();
        if (e.shiftKey) editorUI.toggleInSelection(element);
        else editorUI.selectComponent(element);
      }}
      onPointerDown={interact ? undefined : onPointerDown}
    >
      {/*
        data-floating-root-id marks this subtree as a drop container. The
        resolver walks up from the pointer: if it hits a nested component's
        data-inner-component-id first, that's the drop target; otherwise it
        falls through to the floating root id.
      */}
      <div
        ref={contentRef}
        data-floating-root-id={element.id}
        style={interact ? { width: '100%', height: '100%', ...INTERACT_CONTENT_STYLE } : { width: '100%', height: '100%' }}
        // The tokens and the scheme, and never a page background (SurfaceThemeStyles).
        {...surfaceFrameAttributes('floating', editorUI.frameColorScheme)}
        className={editorUI.frameDarkClass ? 'dark' : undefined}
      >
        <InteractFrame frame={contentRef} floatingId={element.id} />
        <ComponentRenderer
          key={editorUI.interactEpoch}
          component={element}
          breakpointId=""
          allBreakpoints={breakpoints}
          scope={scope}
        />
      </div>
    </GroundWrapper>
  );
});

ResponsivePageRenderer.displayName = 'ResponsivePageRenderer';
ViewportFrame.displayName = 'ViewportFrame';
FloatingElement.displayName = 'FloatingElement';
export default ResponsivePageRenderer;
