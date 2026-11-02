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
import { createComponentElement, RunLinksContext } from './createComponentElement';
import { applyBindings } from '@/lib/bindings/resolver/applyBindings';
import { createScope, pushInputFrame, type BindingScope } from '@/lib/bindings/resolver/scope';
import { placementInstanceOf } from '@/lib/components/expand';
import { inputValuesAt } from '@/lib/components/frameInputs';
import { isPlacementType } from '@/lib/components/placement';
import type { PageExpansion } from '@/lib/components/pageExpansion';
import { detachedExpansion } from './detachedExpansion';
import { effectDomForBreakpoint, hoverPresetClass, resolveEffects, storedEffectsOf } from '@/lib/effects/effects';
import { isStickyCta } from '@/lib/stickyCta/stickyCta';
import { childrenWithRepeats } from './repeatChildren';
import { SurfaceDomContext, withSurfaceDom } from '@/lib/behaviour/surfaceDom';

/**
 * True inside HeadlessPageRenderer, which draws the page's sticky call to
 * action itself (src/lib/stickyCta): every bar is then skipped where it sits.
 */
export const StickyCtaPreviewContext = React.createContext(false);

/** The expansion of the page being previewed. A placement reads its own from it. */
export const PreviewExpansionContext = React.createContext<PageExpansion | null>(null);

export interface HeadlessComponentRendererProps {
  component: ComponentInstance;
  breakpointId: string;
  allBreakpoints: { id: string; minWidth: number; label?: string }[];
  // Active binding scope (mirrors the editor `ComponentRenderer`). Threaded so
  // descendants resolve `{{row.field}}` / `{{page.params.*}}` and so the
  // editor + headless paths produce identical output. Defaults to empty.
  scope?: BindingScope;
  /** Set when HeadlessPageRenderer draws the hoisted sticky call to action (see StickyCtaPreviewContext). */
  hoisted?: boolean;
}

const HeadlessComponentRenderer = observer(({
  component,
  breakpointId,
  allBreakpoints,
  scope,
  hoisted = false,
}: HeadlessComponentRendererProps) => {
  const pageDrawsStickyCta = React.useContext(StickyCtaPreviewContext);
  const expansion = React.useContext(PreviewExpansionContext);
  // Inside a link or a button, formatted text holds no links (createComponentElement).
  const runLinksAllowed = React.useContext(RunLinksContext);
  // What the behaviour pass wrote, so the runtime PreviewFrame starts finds the page it expects.
  const surfaceDom = React.useContext(SurfaceDomContext);

  // A placement draws what the published page compiles: its expansion as a detached
  // tree, so no third way of drawing a component appears. The live tree around it
  // stays, with its data from the polling provider.
  if (isPlacementType(component.type)) {
    const expanded = expansion?.placements.get(component.id);
    const tree = expanded ? detachedExpansion(expanded) : null;
    return tree ? (
      <HeadlessComponentRenderer component={tree} breakpointId={breakpointId} allBreakpoints={allBreakpoints} scope={scope} />
    ) : null;
  }

  // A sticky bar is drawn once, by the page renderer, after the page root.
  if (isStickyCta(component.props) && !hoisted && pageDrawsStickyCta) return null;

  // The Layers panel's eye (canvasVisible) is NOT honoured here: it hides a
  // layer on the editor canvas only, as in Framer. Preview shows what the
  // published page shows (the server renderer ignores the flag too); hiding
  // from visitors is the Visible switch in the Styles section (display:
  // none). See src/lib/layers/layerActions.ts.

  // A placement's root opens its input frame, here as in hydrateNode. Expansion keyed
  // everything on this page's breakpoints, so one cursor reads all of it.
  const outerScope = scope ?? createScope();
  const instance = placementInstanceOf(component.props);
  const cursor = { id: breakpointId, breakpoints: allBreakpoints };
  const activeScope = instance ? pushInputFrame(outerScope, inputValuesAt(instance, cursor, cursor, outerScope)) : outerScope;

  const { attributes, style } = component.getResolvedProps(
    breakpointId,
    allBreakpoints,
  );

  // Apply read bindings against the active scope. Style is fed in alongside
  // attributes so `style.*` slots resolve, then split back out.
  const { resolvedProps } = applyBindings(component, { ...attributes, style }, activeScope);
  const { style: boundStyle, ...boundAttributes } = resolvedProps as Record<string, unknown>;
  // A placement's nodes are its expansion's, so their ids are the ones the pass keyed.
  const shown = withSurfaceDom(boundAttributes, (boundStyle ?? {}) as Record<string, unknown>, surfaceDom?.get(component.id), 'preview');
  const resolvedAttributes = shown.attributes;
  const effectiveStyle = shown.style;

  // Effects play here as on the published page (src/lib/effects): this
  // surface renders one breakpoint, so the values resolve for it directly into
  // attributes and custom properties the runtime and its stylesheet read.
  const stored = storedEffectsOf(component.props);
  const fx = stored ? effectDomForBreakpoint(resolveEffects(stored, breakpointId, allBreakpoints)) : undefined;
  const styleWithFx = fx ? { ...effectiveStyle, ...fx.style } : effectiveStyle;

  // A hover preset is a shared class, as on the published page (PreviewRuleStyles).
  const storedClass = typeof resolvedAttributes.className === 'string' ? resolvedAttributes.className.trim() : '';
  const presetClass = fx?.hover ? hoverPresetClass(fx.hover) : '';

  const finalProps: Record<string, unknown> = {
    ...resolvedAttributes,
    ...(fx?.attributes ?? {}),
    ...(presetClass ? { className: storedClass ? `${storedClass} ${presetClass}` : presetClass } : {}),
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

  // A child repeated for a list is drawn once per item (src/lib/components/repeat.ts).
  const children = childrenWithRepeats(component.children, activeScope, renderNode, false);

  return createComponentElement(component, finalProps, children, (resolvedAttributes as any).children, {
    identity: { breakpointId, componentId: component.id },
    scope: activeScope,
    renderNode,
    // Preview/headless/static-emit surface: data renderers render nothing for
    // an errored slot (no broken layout, no thrown render during SSR).
    mode: 'preview',
    runLinksAllowed,
  });
});

HeadlessComponentRenderer.displayName = 'HeadlessComponentRenderer';
export default HeadlessComponentRenderer;
