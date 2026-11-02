// Render a page's app component tree at a single chosen breakpoint, with no
// editor chrome. Mounted by the preview shell (and reusable for any future
// surface: iframe embed, static export, screenshot worker).
//
// Floating elements live on the editor canvas, not in the published app, so
// they are intentionally not rendered here. Only `page.appComponentTree`.
'use client';
import React from 'react';
import { observer } from 'mobx-react-lite';
import { getParent, hasParent } from 'mobx-state-tree';
import type { PageModelType } from '@/models/PageModel';
import type { ComponentInstance } from '@/models/ComponentModel';
import HeadlessComponentRenderer, { PreviewExpansionContext, StickyCtaPreviewContext } from './HeadlessComponentRenderer';
import { isStickyCta, STICKY_CTA_MAX_HEIGHT, STICKY_CTA_Z_INDEX } from '@/lib/stickyCta/stickyCta';

/** The first sticky call to action in the tree (depth first), or null. */
function firstStickyCta(node: ComponentInstance): ComponentInstance | null {
  if (isStickyCta(node.props)) return node;
  for (const child of node.children as ComponentInstance[]) {
    const found = firstStickyCta(child);
    if (found) return found;
  }
  return null;
}
import PageFontFaces from '@/lib/fonts/PageFontFaces';
import { createScope, pushInputFrame, pushPageFrame } from '@/lib/bindings/resolver/scope';
import { defaultValuesAt } from '@/lib/components/frameInputs';
import { useProductPageParams } from '@/lib/commerce/productPreview';

/** The product page path of the project holding `page` (pages map -> project), or null. */
function productPagePathOf(page: PageModelType): string | null {
  if (!hasParent(page, 2)) return null;
  const project = getParent(page, 2) as { productPagePath?: string | null };
  return project.productPagePath ?? null;
}

export interface HeadlessPageRendererProps {
  page: PageModelType;
  breakpointId: string;
}

const HeadlessPageRenderer = observer(({ page, breakpointId }: HeadlessPageRendererProps) => {
  const { appComponentTree } = page;
  const viewportNodes = page.sortedViewportNodes;
  const pageParams = useProductPageParams(page.slug);

  if (!appComponentTree) return null;
  if (viewportNodes.length === 0) return null;

  const allBreakpoints = viewportNodes.map((v: ComponentInstance) => ({
    id: v.breakpointId!,
    minWidth: v.breakpointMinWidth!,
    label: v.label!,
  }));

  // The sticky call to action (src/lib/stickyCta): the page's first bar, on
  // the smallest breakpoint only (the published page hides it on larger ones).
  const smallest = [...allBreakpoints].sort((a, b) => a.minWidth - b.minWidth)[0];
  const stickyBar = isStickyCta(appComponentTree.props) ? null : firstStickyCta(appComponentTree);
  const pinned = stickyBar !== null && smallest?.id === breakpointId;
  // The page frame, as on the published page: `{{product.href}}` links to the
  // product page, and a product page shows the product being previewed.
  const pageScope = pushPageFrame(createScope(), pageParams, productPagePathOf(page));
  // A definition previewed on its own shows its defaults.
  const inputs = page.definitionInputs;
  const scope = inputs
    ? pushInputFrame(pageScope, defaultValuesAt(inputs, { id: breakpointId, breakpoints: allBreakpoints }, pageScope))
    : pageScope;

  return (
    <PreviewExpansionContext.Provider value={page.expansion}>
      {/* The self-hosted web fonts the page uses (src/lib/fonts/registry.ts). */}
      <PageFontFaces roots={page.pageFontRoots} />
      <StickyCtaPreviewContext.Provider value={true}>
        <HeadlessComponentRenderer
          component={appComponentTree}
          breakpointId={breakpointId}
          allBreakpoints={allBreakpoints}
          scope={scope}
        />
        {pinned && stickyBar ? (
          // After the page root, as a child of the preview frame (the scroll
          // container): sticky keeps it at the frame's bottom whatever the
          // root's overflow, where fixed would pin it to the browser window.
          <div data-fc-sticky-cta-preview="" style={{ position: 'sticky', bottom: 0, zIndex: STICKY_CTA_Z_INDEX, maxHeight: STICKY_CTA_MAX_HEIGHT, overflow: 'hidden' }}>
            <HeadlessComponentRenderer
              component={stickyBar}
              breakpointId={breakpointId}
              allBreakpoints={allBreakpoints}
              scope={scope}
              hoisted
            />
          </div>
        ) : null}
      </StickyCtaPreviewContext.Provider>
    </PreviewExpansionContext.Provider>
  );
});

HeadlessPageRenderer.displayName = 'HeadlessPageRenderer';
export default HeadlessPageRenderer;
