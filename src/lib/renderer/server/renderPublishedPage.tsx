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
import { buildTrackerPayload, type TrackerPayload } from '@/lib/renderer/publish/trackerSnippet';
import { ConsentBanner } from '@/lib/consent/ConsentBanner';
import { HIDE_COOKIE_LINKS_CSS } from '@/lib/consent/consent';
import { DEFAULT_LOOK, type SiteLook } from '@/lib/site/notFoundDefault';
import { renderComponentNode } from './renderComponentNode';
import { applyResponsiveStyles } from './applyResponsiveStyles';
import { applyEffects } from './applyEffects';
import EffectsIsland from './EffectsIsland';
import { EffectsStyles } from '@/lib/effects/EffectsStyles';
import { publishedEffectsBootScript } from '@/lib/effects/effects';
import { publishedFontAssets } from './publishedFonts';
import { applyImageLoading, HeroPreload } from './imageLoading';
import type { BreakpointRef } from '@/lib/responsive/cascade';
import CommercePageProviders from './CommercePageProviders';
import { hoistStickyCta, stickyCtaCss, stickyCtaMeasureScript } from '@/lib/stickyCta/stickyCta';

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
   * Where the site's product page lives (`/products` for `products/:handle`,
   * productPagePath in src/lib/pages/slug.ts), or null when it has none: the
   * base of every `{{product.href}}` link.
   */
  productPagePath?: string | null;
  /**
   * The page's breakpoints (from its viewport canvas nodes). Responsive styles
   * become max-width media queries between them; without any, a responsive
   * style's base value applies at every width.
   */
  breakpoints?: readonly BreakpointRef[];
  /**
   * The site's smooth scrolling setting (Lenis): off by default, and off for
   * visitors who ask for reduced motion.
   */
  smoothScroll?: boolean;
  /**
   * How the consent banner speaks and looks: the site language, the site's
   * look and its privacy policy path. Only used when analytics needs consent.
   */
  consent?: {
    language: string;
    look?: SiteLook;
    privacyHref?: string | null;
  };
}

export interface RenderedPage {
  /**
   * The hydrated, server-rendered body wrapped in the commerce providers,
   * preceded by the page's responsive stylesheet when it has one.
   */
  body: React.ReactNode;
  /**
   * True when the page carries the consent banner because analytics is enabled
   * and resolved: the tracker then loads only after the visitor accepts, and is
   * never part of the HTML.
   */
  analyticsGated: boolean;
}

/**
 * The tracker to load after consent, when the binding is enabled and a public
 * key + endpoint are resolved. A misconfigured key (e.g. a secret-shaped value
 * the backstop refuses) is logged LOUDLY and loads nothing, rather than taking
 * the whole storefront down: analytics is additive, the page must still serve.
 * A/B is deferred for the demo, so `variants` is the control baseline ({}).
 */
function resolveTracker(analytics: ResolvedAnalytics | undefined): TrackerPayload | null {
  if (!analytics || !analytics.enabled) return null;
  if (!analytics.ingestionKey || !analytics.ingestionEndpoint) return null;
  try {
    return buildTrackerPayload({
      ingestionKey: analytics.ingestionKey,
      ingestionEndpoint: analytics.ingestionEndpoint,
      ...(analytics.projectId ? { projectId: analytics.projectId } : {}),
      // The loader script is what actually emits events; pass it through when the
      // deploy configured it, else only the config globals are set (no emission).
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
  const { root, pageParams, cmsRepo, commerceRepo, analytics, productPagePath = null, breakpoints = [], smoothScroll = false, consent } = input;
  const tracker = resolveTracker(analytics);

  const hydratedTree = await hydrateBindings(root, pageParams, { cmsRepo, commerceRepo }, productPagePath);
  // The sticky call to action (src/lib/stickyCta): the page's first bar moves
  // to the end of the page root (its pinned place in the reading order),
  // further ones are dropped (at most one per page).
  const sticky = hoistStickyCta(hydratedTree);
  if (sticky.removed > 0) {
    console.warn(`renderPublishedPage: ${sticky.removed} extra sticky call to action bar(s) not rendered (at most one per page)`);
  }
  const hydrated = sticky.root;

  // Responsive styles leave the inline style for a per-page stylesheet of
  // max-width media queries (desktop-first, the editor's cascade). Done on the
  // hydrated tree so cloned collection rows and the commerce islands (which
  // receive these props across the client boundary) carry the classes too.
  // Lazy images below the hero, a priority hero (src/lib/renderer/server/imageLoading.tsx).
  const images = applyImageLoading(hydrated);
  // Effects next: they become data attributes plus custom properties in
  // `style`, which the responsive pass then moves into the stylesheet per
  // breakpoint like any responsive style.
  const effects = applyEffects(images.root, breakpoints);
  const responsive = applyResponsiveStyles(effects.root, breakpoints);
  // The self-hosted web fonts the page uses, scanned before the responsive
  // rewrite moves styles into classes (src/lib/fonts/registry.ts).
  const fonts = publishedFontAssets(hydrated);

  // The page frame drives any island re-resolution of {{page.params.*}} and {{product.href}}.
  const scope = pushPageFrame(createScope(), pageParams, productPagePath);
  const tree = renderComponentNode(responsive.root, scope);

  return {
    body: (
      <>
        {tracker ? (
          // Consent first in the reading order; the tracker loads only after
          // the visitor accepts (decision 6). Nothing of it is in the HTML.
          <ConsentBanner
            tracker={tracker}
            language={consent?.language ?? 'en'}
            look={consent?.look ?? DEFAULT_LOOK}
            privacyHref={consent?.privacyHref ?? null}
          />
        ) : (
          // Nothing needs consent: a footer "Cookie settings" link would do nothing.
          <style data-fc-consent-none="" dangerouslySetInnerHTML={{ __html: HIDE_COOKIE_LINKS_CSS }} />
        )}
        {fonts}
        {images.preloadUrl ? <HeroPreload url={images.preloadUrl} /> : null}
        {responsive.css ? (
          // Rendered in place (no href / precedence, so React does not hoist
          // it) ahead of the content it styles, so streamed HTML never paints
          // unstyled. The text cannot close the element: the generator drops
          // any value containing `<`.
          <style data-fc-responsive="" dangerouslySetInnerHTML={{ __html: responsive.css }} />
        ) : null}
        {effects.hasEffects || smoothScroll ? (
          <EffectsStyles smoothScroll={smoothScroll} />
        ) : null}
        {effects.needsRuntime ? (
          // Parsed and run before the content it gates: it injects the
          // start-state rules (never part of the HTML, so nothing is hidden
          // without JavaScript) unless the visitor asks for reduced motion.
          <script data-fc-effects-boot="" dangerouslySetInnerHTML={{ __html: publishedEffectsBootScript() }} />
        ) : null}
        {sticky.bar ? (
          // Pins the bar on the smallest breakpoint, pads the page and lifts
          // the consent banner above it. Constant text apart from numbers.
          <style data-fc-sticky-cta-style="" dangerouslySetInnerHTML={{ __html: stickyCtaCss(breakpoints) }} />
        ) : null}
        <CommercePageProviders>{tree}</CommercePageProviders>
        {sticky.bar ? (
          // Measures the bar for the page padding (a fallback height applies without it).
          <script data-fc-sticky-cta-measure="" dangerouslySetInnerHTML={{ __html: stickyCtaMeasureScript() }} />
        ) : null}
        {effects.needsRuntime || smoothScroll ? (
          <EffectsIsland effects={effects.needsRuntime} smoothScroll={smoothScroll} />
        ) : null}
      </>
    ),
    analyticsGated: tracker !== null,
  };
}
