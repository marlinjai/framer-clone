// snapshotToComponentNode: the pure, SSR-safe adaptor from a persisted page
// snapshot to the serializable `ComponentNode` shape the publish hydrator
// (`hydrateBindings`) and the server renderer (`renderComponentNode`) consume.
//
// A `SitePage.snapshot` is a full PageModel SnapshotOut. Its `appComponentTree`
// field is the renderable root (a ComponentModel SnapshotOut); `canvasNodes`
// holds the editor's viewport / floating canvas nodes and is INTENTIONALLY NOT
// rendered on the published page (those live on the editor canvas, never in the
// deployed app, exactly as HeadlessPageRenderer ignores them). The viewport
// nodes do carry the page's breakpoints (`breakpointId` / `breakpointMinWidth`),
// which the published stylesheet needs to turn responsive styles into media
// queries, so those two fields are lifted out. The page's `metadata`
// (title / description / og*) feeds SEO.
//
// This module is PURE: no React, no MST, no Prisma, no `server-only`. It maps a
// ComponentModel SnapshotOut onto `ComponentNode` field-for-field
// (type / props / bindings / children / id), dropping the editor-only canvas
// fields (componentType / canvasX / canvasY / viewport* / label / parentId /
// ...) that the renderer does not need. Empty `props` / `bindings` / `children`
// are omitted so the produced tree is minimal and round-trips cleanly in tests.
//
// Placements are expanded here (src/lib/components/expand.ts), so past this point
// a published page holds only ordinary nodes, and stylesheets, effects, images,
// fonts, the sticky bar and the form lookup need no knowledge of components.

import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import type { PageSnapshotOut } from '@/models/PageModel';
import type { BreakpointRef } from '@/lib/responsive/cascade';
import type { ComponentDefinitions } from '@/lib/components/definition';
import { createRenderBudget, expandPlacements, type RenderBudget } from '@/lib/components/expand';
import { componentSnapshotToNode, extractBreakpoints, type ComponentSnapshotLike } from './componentSnapshot';

export { componentSnapshotToNode, extractBreakpoints, foldCssProps } from './componentSnapshot';

/**
 * SEO metadata lifted off the page snapshot. A plain, serializable subset of
 * PageMetadataModel: the fields the published `<head>` needs. Kept here (rather
 * than importing the MST model type) so this module stays MST-free.
 */
export interface PageSeoMetadata {
  title: string;
  description: string;
  keywords: string[];
  ogTitle: string;
  ogDescription: string;
  ogImage: string;
  canonicalUrl: string;
  /** Keep the page out of search engines (robots noindex, no sitemap entry). */
  noIndex: boolean;
}

/**
 * The adaptor output: the renderable root as a ComponentNode plus the page slug
 * and SEO metadata. `root` is null when the snapshot carries no app component
 * tree (a malformed / empty page), so callers can 404 rather than render a
 * blank shell.
 */
export interface AdaptedPage {
  root: ComponentNode | null;
  slug: string;
  metadata: PageSeoMetadata;
  /** The page's breakpoints (one per viewport node), largest first; empty when none. */
  breakpoints: BreakpointRef[];
  /** What expansion spent. Rendering the page draws on the same budget. */
  budget: RenderBudget;
}

const EMPTY_METADATA: PageSeoMetadata = {
  title: '',
  description: '',
  keywords: [],
  ogTitle: '',
  ogDescription: '',
  ogImage: '',
  canonicalUrl: '',
  noIndex: false,
};

/** Lift the SEO metadata off the page snapshot, defaulting every field. */
function extractMetadata(snapshot: PageSnapshotOut): PageSeoMetadata {
  const meta = snapshot.metadata as Partial<PageSeoMetadata> | undefined;
  if (!meta) return { ...EMPTY_METADATA };
  return {
    title: meta.title ?? '',
    description: meta.description ?? '',
    keywords: Array.isArray(meta.keywords) ? [...meta.keywords] : [],
    ogTitle: meta.ogTitle ?? '',
    ogDescription: meta.ogDescription ?? '',
    ogImage: meta.ogImage ?? '',
    canonicalUrl: meta.canonicalUrl ?? '',
    noIndex: meta.noIndex === true,
  };
}

/**
 * Adapt a persisted PageModel SnapshotOut into the renderer's input: the
 * `appComponentTree` mapped to a ComponentNode with its placements expanded, the
 * slug, the SEO metadata and the breakpoints. `canvasNodes` are otherwise ignored
 * (editor-only). A snapshot with no `appComponentTree` yields `root: null` so the
 * caller can 404. `definitions` has no default on purpose: one would let a caller
 * not updated compile, pass its tests on pages without placements, and delete
 * every placement in production.
 */
export function snapshotToComponentNode(snapshot: PageSnapshotOut, definitions: ComponentDefinitions): AdaptedPage {
  const tree = snapshot.appComponentTree as ComponentSnapshotLike | undefined;
  const breakpoints = extractBreakpoints(snapshot.canvasNodes);
  const budget = createRenderBudget();
  return {
    root: tree ? expandPlacements(componentSnapshotToNode(tree), definitions, breakpoints, { budget }) : null,
    slug: typeof snapshot.slug === 'string' ? snapshot.slug : '',
    metadata: extractMetadata(snapshot),
    breakpoints,
    budget,
  };
}
