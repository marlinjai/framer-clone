// renderPublishedPage: the SSR render seam the public route calls.
//
// Given an adapted page root (a ComponentNode), the page route params, and the
// LIVE read repos, it: runs `hydrateBindings` to expand CMS + commerce data per
// request, walks the hydrated tree with `renderComponentNode`, wraps the body in
// the page-level commerce providers, and (when analytics is enabled) builds the
// tracker `<head>` snippet. PURE of `server-only`: the repos and the resolved
// public ingestion key are INJECTED by the caller, so this seam is unit-testable
// headless with fakes (the route wires the real, server-only dependencies).

import React from 'react';
import {
  hydrateBindings,
  type ComponentNode,
  type CommerceServerRepository,
} from '@/lib/renderer/publish/hydrateBindings';
import type { CmsReadRepository } from '@/server/cms';
import { createScope, pushPageFrame } from '@/lib/bindings/resolver/scope';
import { buildTrackerSnippet } from '@/lib/renderer/publish/trackerSnippet';
import { renderComponentNode } from './renderComponentNode';
import { applyResponsiveStyles } from './applyResponsiveStyles';
import { publishedFontAssets } from './publishedFonts';
import type { BreakpointRef } from '@/lib/responsive/cascade';
import CommercePageProviders from './CommercePageProviders';

/**
 * The resolved analytics binding for a published page. `ingestionKey` is the
 * PUBLIC `ap_live_` key, resolved server-side by the caller from the snapshot's
 * `apiKeyRef` (a server-side ref). The secret ref literal NEVER reaches here.
 */
export interface ResolvedAnalytics {
  enabled: boolean;
  ingestionKey: string | null;
  ingestionEndpoint: string | null;
  projectId?: string | null;
  /**
   * The tracker LOADER script URL (`<script async src>`). This is what actually
   * reads `window.__AP_CONFIG` and emits events; without it the snippet publishes
   * the config but the site emits nothing. Resolved from the deploy env by the
   * caller; null when unset (snippet degrades to config-only).
   */
  trackerScriptSrc?: string | null;
}

export interface RenderPublishedPageInput {
  /** The adapted renderable root (from snapshotToComponentNode). */
  root: ComponentNode;
  /** Route params extracted from the slug ({{page.params.id}} / .handle). */
  pageParams: Record<string, string>;
  cmsRepo: CmsReadRepository;
  /**
   * The site's scoped commerce read repository, or undefined when the site has
   * no commerce tenant (fail closed, CM-10): every commerce binding then renders
   * the hydrator's unbound placeholder instead of any catalog data.
   */
  commerceRepo?: CommerceServerRepository;
  /** Resolved analytics binding; injection is gated on `enabled` + a public key. */
  analytics?: ResolvedAnalytics;
  /**
   * The page's breakpoints (from its viewport canvas nodes). Responsive styles
   * become max-width media queries between them; without any, a responsive
   * style's base value applies at every width.
   */
  breakpoints?: readonly BreakpointRef[];
}

export interface RenderedPage {
  /**
   * The hydrated, server-rendered body wrapped in the commerce providers,
   * preceded by the page's responsive stylesheet when it has one.
   */
  body: React.ReactNode;
  /** The analytics `<head>` snippet HTML, or null when disabled / unresolved. */
  headSnippet: string | null;
}

/**
 * Build the analytics tracker snippet when the binding is enabled and a public
 * key + endpoint are resolved. A misconfigured key (e.g. a secret-shaped value
 * the backstop refuses) is logged LOUDLY and injects nothing, rather than taking
 * the whole storefront down: analytics is additive, the page must still serve.
 * A/B is deferred for the demo, so `variants` is the control baseline ({}).
 */
function buildHeadSnippet(analytics: ResolvedAnalytics | undefined): string | null {
  if (!analytics || !analytics.enabled) return null;
  if (!analytics.ingestionKey || !analytics.ingestionEndpoint) return null;
  try {
    return buildTrackerSnippet({
      ingestionKey: analytics.ingestionKey,
      ingestionEndpoint: analytics.ingestionEndpoint,
      ...(analytics.projectId ? { projectId: analytics.projectId } : {}),
      // The loader script is what actually emits events; pass it through when the
      // deploy configured it, else the snippet is config-only (no emission).
      ...(analytics.trackerScriptSrc ? { trackerScriptSrc: analytics.trackerScriptSrc } : {}),
      variants: {},
    });
  } catch (err) {
    console.error(
      'renderPublishedPage: analytics snippet refused / failed to build; injecting nothing.',
      err,
    );
    return null;
  }
}

/**
 * Hydrate and render a published page. Throws nothing for an empty CMS/commerce
 * result (hydrateBindings owns the empty/error contract); the caller decides
 * 404 from the resolver / a null adapted root BEFORE calling this.
 */
export async function renderPublishedPage(
  input: RenderPublishedPageInput,
): Promise<RenderedPage> {
  const { root, pageParams, cmsRepo, commerceRepo, analytics, breakpoints = [] } = input;

  const hydrated = await hydrateBindings(root, pageParams, { cmsRepo, commerceRepo });

  // Responsive styles leave the inline style for a per-page stylesheet of
  // max-width media queries (desktop-first, the editor's cascade). Done on the
  // hydrated tree so cloned collection rows and the commerce islands (which
  // receive these props across the client boundary) carry the classes too.
  const responsive = applyResponsiveStyles(hydrated, breakpoints);
  // The self-hosted web fonts the page uses, scanned before the responsive
  // rewrite moves styles into classes (src/lib/fonts/registry.ts).
  const fonts = publishedFontAssets(hydrated);

  // The page frame drives any island re-resolution of {{page.params.*}}.
  const scope = pushPageFrame(createScope(), pageParams);
  const tree = renderComponentNode(responsive.root, scope);

  return {
    body: (
      <>
        {fonts}
        {responsive.css ? (
          // Rendered in place (no href / precedence, so React does not hoist
          // it) ahead of the content it styles, so streamed HTML never paints
          // unstyled. The text cannot close the element: the generator drops
          // any value containing `<`.
          <style data-fc-responsive="" dangerouslySetInnerHTML={{ __html: responsive.css }} />
        ) : null}
        <CommercePageProviders>{tree}</CommercePageProviders>
      </>
    ),
    headSnippet: buildHeadSnippet(analytics),
  };
}
