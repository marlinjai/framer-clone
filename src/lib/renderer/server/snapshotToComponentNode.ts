// snapshotToComponentNode: the pure, SSR-safe adaptor from a persisted page
// snapshot to the serializable `ComponentNode` shape the publish hydrator
// (`hydrateBindings`) and the server renderer (`renderComponentNode`) consume.
//
// A `SitePage.snapshot` is a full PageModel SnapshotOut. Its `appComponentTree`
// field is the renderable root (a ComponentModel SnapshotOut); `canvasNodes`
// holds the editor's viewport / floating canvas nodes and is INTENTIONALLY NOT
// rendered on the published page (those live on the editor canvas, never in the
// deployed app, exactly as HeadlessPageRenderer ignores them). The page's
// `metadata` (title / description / og*) feeds SEO.
//
// This module is PURE: no React, no MST, no Prisma, no `server-only`. It maps a
// ComponentModel SnapshotOut onto `ComponentNode` field-for-field
// (type / props / bindings / children / id), dropping the editor-only canvas
// fields (componentType / canvasX / canvasY / viewport* / label / parentId /
// ...) that the renderer does not need. Empty `props` / `bindings` / `children`
// are omitted so the produced tree is minimal and round-trips cleanly in tests.

import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import type { PageSnapshotOut } from '@/models/PageModel';
import type { ComponentSnapshotOut } from '@/models/ComponentModel';

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
}

/**
 * A structural, MST-free view of a ComponentModel SnapshotOut. The real
 * SnapshotOut carries many editor-only fields; we read only the five that map
 * onto a ComponentNode. Declared loosely (optional) so a snapshot from an older
 * or newer ComponentModel shape still adapts without a type break.
 */
type ComponentSnapshotLike = Pick<
  ComponentSnapshotOut,
  'id' | 'type'
> & {
  props?: Record<string, unknown>;
  bindings?: Record<string, unknown>;
  children?: ComponentSnapshotLike[];
};

function hasEntries(value: unknown): boolean {
  return !!value && typeof value === 'object' && Object.keys(value as object).length > 0;
}

/**
 * Map a single ComponentModel SnapshotOut node to a ComponentNode. Faithful on
 * the five shared fields; the editor-only canvas fields are dropped. Empty
 * `props` / `bindings` / `children` are omitted to keep the node minimal.
 */
export function componentSnapshotToNode(snapshot: ComponentSnapshotLike): ComponentNode {
  const node: ComponentNode = { type: snapshot.type };

  if (typeof snapshot.id === 'string' && snapshot.id.length > 0) {
    node.id = snapshot.id;
  }
  if (hasEntries(snapshot.props)) {
    // Props are passed through verbatim: binding resolution and responsive-map
    // flattening happen downstream (hydrateBindings / renderComponentNode), not
    // in this faithful structural map.
    node.props = snapshot.props as ComponentNode['props'];
  }
  if (hasEntries(snapshot.bindings)) {
    node.bindings = snapshot.bindings as ComponentNode['bindings'];
  }
  const children = snapshot.children;
  if (Array.isArray(children) && children.length > 0) {
    node.children = children.map(componentSnapshotToNode);
  }

  return node;
}

const EMPTY_METADATA: PageSeoMetadata = {
  title: '',
  description: '',
  keywords: [],
  ogTitle: '',
  ogDescription: '',
  ogImage: '',
  canonicalUrl: '',
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
  };
}

/**
 * Adapt a persisted PageModel SnapshotOut into the renderer's input: the
 * `appComponentTree` mapped to a ComponentNode, the slug, and the SEO metadata.
 * `canvasNodes` are intentionally ignored (editor-only). A snapshot with no
 * `appComponentTree` yields `root: null` so the caller can 404.
 */
export function snapshotToComponentNode(snapshot: PageSnapshotOut): AdaptedPage {
  const tree = snapshot.appComponentTree as ComponentSnapshotLike | undefined;
  return {
    root: tree ? componentSnapshotToNode(tree) : null,
    slug: typeof snapshot.slug === 'string' ? snapshot.slug : '',
    metadata: extractMetadata(snapshot),
  };
}
