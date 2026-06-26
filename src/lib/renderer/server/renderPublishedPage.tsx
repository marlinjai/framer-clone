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
import type { Metadata } from 'next';
import {
  hydrateBindings,
  type ComponentNode,
  type CommerceServerRepository,
} from '@/lib/renderer/publish/hydrateBindings';
import type { CmsReadRepository } from '@/server/cms';
import { createScope, pushPageFrame } from '@/lib/bindings/resolver/scope';
import { buildTrackerSnippet } from '@/lib/renderer/publish/trackerSnippet';
import { renderComponentNode } from './renderComponentNode';
import CommercePageProviders from './CommercePageProviders';
import type { PageSeoMetadata } from './snapshotToComponentNode';

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
  commerceRepo: CommerceServerRepository;
  /** Resolved analytics binding; injection is gated on `enabled` + a public key. */
  analytics?: ResolvedAnalytics;
}

export interface RenderedPage {
  /** The hydrated, server-rendered body wrapped in the commerce providers. */
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
  const { root, pageParams, cmsRepo, commerceRepo, analytics } = input;

  const hydrated = await hydrateBindings(root, pageParams, { cmsRepo, commerceRepo });

  // The page frame drives any island re-resolution of {{page.params.*}}.
  const scope = pushPageFrame(createScope(), pageParams);
  const tree = renderComponentNode(hydrated, scope);

  return {
    body: <CommercePageProviders>{tree}</CommercePageProviders>,
    headSnippet: buildHeadSnippet(analytics),
  };
}

/**
 * Map the page SEO metadata onto a Next.js Metadata object for `generateMetadata`.
 * Empty fields are omitted so Next falls back to its defaults rather than
 * emitting empty tags.
 */
export function pageSeoToMetadata(meta: PageSeoMetadata): Metadata {
  const metadata: Metadata = {};
  if (meta.title) metadata.title = meta.title;
  if (meta.description) metadata.description = meta.description;
  if (meta.keywords.length > 0) metadata.keywords = meta.keywords;
  if (meta.canonicalUrl) metadata.alternates = { canonical: meta.canonicalUrl };

  const ogTitle = meta.ogTitle || meta.title;
  const ogDescription = meta.ogDescription || meta.description;
  const hasOg = ogTitle || ogDescription || meta.ogImage;
  if (hasOg) {
    metadata.openGraph = {
      ...(ogTitle ? { title: ogTitle } : {}),
      ...(ogDescription ? { description: ogDescription } : {}),
      ...(meta.ogImage ? { images: [{ url: meta.ogImage }] } : {}),
    };
  }
  return metadata;
}
