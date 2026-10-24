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
import { effectDomForBreakpoint, resolveEffects, storedEffectsOf } from '@/lib/effects/effects';
import { isStickyCta, STICKY_CTA_Z_INDEX } from '@/lib/stickyCta/stickyCta';

/**
 * The page's sticky call to action in the preview (src/lib/stickyCta): every
 * bar is skipped where it sits, and the page's first one is appended to the
 * end of the page root, sticky at the bottom of the preview frame, on the
 * smallest breakpoint only (the published page pins it there too, and hides
 * it on larger ones). Provided by HeadlessPageRenderer.
 */
export interface StickyCtaPreview {
  rootId: string;
  bar: ComponentInstance | null;
  /** True on the page's smallest breakpoint. */
  pinned: boolean;
}

export const StickyCtaPreviewContext = React.createContext<StickyCtaPreview | null>(null);

export interface HeadlessComponentRendererProps {
  component: ComponentInstance;
  breakpointId: string;
  allBreakpoints: { id: string; minWidth: number; label?: string }[];
  // Active binding scope (mirrors the editor `ComponentRenderer`). Threaded so
  // descendants resolve `{{row.field}}` / `{{page.params.*}}` and so the
  // editor + headless paths produce identical output. Defaults to empty.
  scope?: BindingScope;
  /** Set when rendering the hoisted sticky call to action (see StickyCtaPreviewContext). */
  hoisted?: boolean;
}

const HeadlessComponentRenderer = observer(({
  component,
  breakpointId,
  allBreakpoints,
  scope,
  hoisted = false,
}: HeadlessComponentRendererProps) => {
  const stickyPreview = React.useContext(StickyCtaPreviewContext);
  // A sticky bar is drawn once, at the end of the page root (below).
  if (isStickyCta(component.props) && !hoisted && stickyPreview) return null;

  // The Layers panel's eye (canvasVisible) is NOT honoured here: it hides a
  // layer on the editor canvas only, as in Framer. Preview shows what the
  // published page shows (the server renderer ignores the flag too); hiding
  // from visitors is the Visible switch in the Styles section (display:
  // none). See src/lib/layers/layerActions.ts.

  const activeScope = scope ?? createScope();

  const { attributes, style } = component.getResolvedProps(
    breakpointId,
    allBreakpoints,
  );

  // Apply read bindings against the active scope. Style is fed in alongside
  // attributes so `style.*` slots resolve, then split back out.
  const { resolvedProps } = applyBindings(component, { ...attributes, style }, activeScope);
  const { style: boundStyle, ...resolvedAttributes } = resolvedProps as Record<string, unknown>;
  const effectiveStyle = (boundStyle ?? {}) as Record<string, unknown>;

  // Effects play here as on the published page (src/lib/effects): this
  // surface renders one breakpoint, so the values resolve for it directly into
  // attributes and custom properties the runtime and its stylesheet read.
  const stored = storedEffectsOf(component.props);
  const fx = stored ? effectDomForBreakpoint(resolveEffects(stored, breakpointId, allBreakpoints)) : undefined;
  const styleWithFx = fx ? { ...effectiveStyle, ...fx.style } : effectiveStyle;

  const finalProps: Record<string, unknown> = {
    ...resolvedAttributes,
    ...(fx?.attributes ?? {}),
    style: Object.keys(styleWithFx).length ? styleWithFx : undefined,
  };

  const renderNode = (node: ComponentInstance, childScope: BindingScope) => (
    <HeadlessComponentRenderer
      component={node}
      breakpointId={breakpointId}
      allBreakpoints={allBreakpoints}
      scope={childScope}
    />
  );

  const children = component.children.map((ch: ComponentInstance) => (
    <React.Fragment key={ch.id}>{renderNode(ch, activeScope)}</React.Fragment>
  ));
  if (stickyPreview && stickyPreview.rootId === component.id && stickyPreview.bar && stickyPreview.pinned) {
    // The frame is the scroll container, so sticky (not fixed, which would
    // pin to the browser window) keeps the bar at the bottom of the frame.
    children.push(
      <div
        key="fc-sticky-cta"
        data-fc-sticky-cta-preview=""
        style={{ position: 'sticky', bottom: 0, zIndex: STICKY_CTA_Z_INDEX }}
      >
        <HeadlessComponentRenderer
          component={stickyPreview.bar}
          breakpointId={breakpointId}
          allBreakpoints={allBreakpoints}
          scope={activeScope}
          hoisted
        />
      </div>,
    );
  }

  return createComponentElement(component, finalProps, children, (resolvedAttributes as any).children, {
    identity: { breakpointId, componentId: component.id },
    scope: activeScope,
    renderNode,
    // Preview/headless/static-emit surface: data renderers render nothing for
    // an errored slot (no broken layout, no thrown render during SSR).
    mode: 'preview',
  });
});

HeadlessComponentRenderer.displayName = 'HeadlessComponentRenderer';
export default HeadlessComponentRenderer;
