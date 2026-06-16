// hydrateBindings: build-time read-binding hydration for the static-publish path.
//
// This module is PURE and React-free (no React, no jsdom, no MST). It expands a
// data-bound component tree into a tree of CONCRETE prop values by walking the
// React-free resolver (`applyBindings` / `pushRowFrame` / `pushPageFrame` /
// `lookup`). It is the build-time counterpart to the live preview renderers
// (HeadlessComponentRenderer -> CollectionRenderer / RecordViewRenderer): same
// resolution logic, same empty/error behavior, but resolved eagerly in Node at
// build time instead of lazily via React effects in the browser.
//
// Reader seam: rows are fetched server-side by importing the local
// `src/server/cms` `CmsReadRepository` DIRECTLY (a type-only import here; the
// concrete repo is injected by the caller). This is the "direct import for
// build-time" reader. The LIVE client keeps reading `/api/cms/*` over HTTP via
// the polling provider; that path is unchanged by this module.
//
// Options-object signature: `hydrateBindings(tree, params, { cmsRepo })` so
// Track C can add `{ cmsRepo, commerceRepo }` additively later
// (`trackc-commerce-binding-preview-and-publish-hydration`) without breaking
// this call site.
//
// Empty / error contract (mirrors the preview surface, resolveDataState):
//  - empty Collection / not-found RecordView -> the configured `emptyContent`.
//  - a fetch error during hydration renders NOTHING for that slot and NEVER
//    throws the build. This is the ONE documented swallow in this module and is
//    covered by a test.
//
// TODO(static-html wave): wiring this helper into the actual published output
// is GATED on the static-html wave. `projectPublisher.ts` / the per-page
// `staticHtmlEmitter.ts` do NOT exist yet; once `static-html-spike` and
// `static-html-publish-pipeline` land, the per-page emitter calls
// `hydrateBindings(pageTree, pageParams, { cmsRepo: getCmsRepository() })`
// before serializing. That wiring is a one-line call by design; see the
// follow-on stub `followon-wire-hydratebindings-publish.md`. Do NOT wire it
// here.

import { applyBindings, type Props } from '@/lib/bindings/resolver/applyBindings';
import {
  createScope,
  lookup,
  pushPageFrame,
  pushRowFrame,
  type BindingScope,
} from '@/lib/bindings/resolver/scope';
import {
  evaluateExpression,
  parseExpression,
} from '@/lib/bindings/resolver/expression';
import type { BindingEntry, BindingsRecord } from '@/lib/bindings/types';
import type { Query, Row } from '@/lib/bindings/dataSource/types';
// Type-only import: erased at compile time, so this module pulls in NO
// server-only / adapter-prisma runtime code and stays Node-evaluable.
import type { CmsReadRepository } from '@/server/cms';

/**
 * A build-time, serializable component node. This is the plain-data shape the
 * publish pipeline feeds in (a snapshot of the MST tree), deliberately free of
 * React / MST coupling. The resolver's data-component dispatch keys off
 * `props['data-component-kind']` and `bindings`, exactly like the live
 * renderers' `createComponentElement` dispatch.
 */
export interface ComponentNode {
  type: string;
  props?: Props;
  bindings?: BindingsRecord;
  children?: ComponentNode[];
  /** Optional stable id, preserved verbatim when present. */
  id?: string;
}

/**
 * Repositories available to the hydrator. Options-object form so Track C can
 * add `commerceRepo` additively without changing this call site.
 */
export interface HydrationRepos {
  cmsRepo: CmsReadRepository;
}

/**
 * Expand a data-bound tree into concrete prop values.
 *
 * Collection nodes expand to one hydrated block per row (with `{{row.field}}`
 * baked in, no LOADING text); RecordView nodes resolve a single row from the
 * page slug params; ordinary nodes have their read bindings baked into props.
 * Runs entirely in Node: no React, no jsdom.
 */
export async function hydrateBindings(
  pageTree: ComponentNode,
  pageParams: Record<string, string>,
  repos: HydrationRepos,
): Promise<ComponentNode> {
  // The page frame drives `{{page.params.*}}` resolution (RecordView row id).
  const rootScope = pushPageFrame(createScope(), pageParams);
  return hydrateNode(pageTree, rootScope, repos.cmsRepo);
}

// =============================================================================
// node dispatch
// =============================================================================

async function hydrateNode(
  node: ComponentNode,
  scope: BindingScope,
  cmsRepo: CmsReadRepository,
): Promise<ComponentNode> {
  const dataKind = node.props?.['data-component-kind'];
  const hasBindings = !!node.bindings && Object.keys(node.bindings).length > 0;

  if (dataKind === 'collection' && hasBindings) {
    return hydrateCollection(node, scope, cmsRepo);
  }
  if (dataKind === 'record-view' && hasBindings) {
    return hydrateRecordView(node, scope, cmsRepo);
  }
  // Unbound data node: emit the wave-1 dashed-box label (mirrors
  // createComponentElement) so a misconfigured node is visible, not silent.
  if (
    typeof dataKind === 'string' &&
    !hasBindings &&
    (node.children?.length ?? 0) === 0
  ) {
    return placeholderNode(node, dataKind);
  }
  return hydrateOrdinary(node, scope, cmsRepo);
}

async function hydrateOrdinary(
  node: ComponentNode,
  scope: BindingScope,
  cmsRepo: CmsReadRepository,
): Promise<ComponentNode> {
  const { resolvedProps } = applyBindings(node, node.props ?? {}, scope);
  const children = await hydrateChildren(node.children, scope, cmsRepo);
  return { ...node, props: resolvedProps, children };
}

async function hydrateChildren(
  children: ComponentNode[] | undefined,
  scope: BindingScope,
  cmsRepo: CmsReadRepository,
): Promise<ComponentNode[]> {
  if (!children || children.length === 0) return [];
  return Promise.all(children.map((child) => hydrateNode(child, scope, cmsRepo)));
}

// =============================================================================
// Collection: one hydrated block per row
// =============================================================================

async function hydrateCollection(
  node: ComponentNode,
  scope: BindingScope,
  cmsRepo: CmsReadRepository,
): Promise<ComponentNode> {
  const collectionId = resolveCollectionId(node.bindings?.collection, scope);
  // Unresolved / missing source binding: a configuration note, never a silent
  // empty success (mirrors CollectionRenderer).
  if (!collectionId) {
    return noteNode(node, scope, 'Collection: no source collection bound');
  }

  // Structured filter/sort/limit live as a Query object on props.query (NOT a
  // template expression), exactly as the live CollectionRenderer reads it.
  const query = node.props?.query as Query | undefined;

  let rows: Row[];
  try {
    const page = await cmsRepo.listRows(collectionId, query);
    rows = page.rows;
  } catch {
    // Documented swallow: a fetch error during build-time hydration renders
    // nothing for this slot and NEVER throws the build (preview-surface
    // contract, resolveDataState's preview-mode error path).
    return emptyWrapper(node, scope);
  }

  if (rows.length === 0) {
    return noteNode(node, scope, stringProp(node.props, 'emptyContent', 'No items'));
  }

  const template = node.children?.[0];
  if (!template) {
    return noteNode(
      node,
      scope,
      'Collection: add a child to use as the row template',
    );
  }

  // One hydrated template instance per row, each against a row-scoped chain so
  // descendants resolve `{{row.field}}` to that row's values.
  const items = await Promise.all(
    rows.map((row) => hydrateNode(template, pushRowFrame(scope, row), cmsRepo)),
  );
  return { ...node, props: wrapperPropsOf(node, scope), children: items };
}

// =============================================================================
// RecordView: a single row resolved from the page slug params
// =============================================================================

async function hydrateRecordView(
  node: ComponentNode,
  scope: BindingScope,
  cmsRepo: CmsReadRepository,
): Promise<ComponentNode> {
  const collectionId = resolveCollectionId(node.bindings?.record, scope);
  if (!collectionId) {
    return noteNode(node, scope, 'Record view: no record source bound');
  }

  // Row id from the dynamic-route param: {{page.params.id}}.
  const rawId = lookup(scope, ['page', 'params', 'id']);
  const rowId = typeof rawId === 'string' && rawId.length > 0 ? rawId : null;
  if (!rowId) {
    return noteNode(node, scope, 'Record view: no record selected');
  }

  let row: Row | null;
  try {
    row = await cmsRepo.getRow(collectionId, rowId);
  } catch {
    // Documented swallow (see hydrateCollection): error renders nothing, never
    // throws the build.
    return emptyWrapper(node, scope);
  }

  if (!row) {
    return noteNode(
      node,
      scope,
      stringProp(node.props, 'emptyContent', 'Record not found'),
    );
  }

  const rowScope = pushRowFrame(scope, row);
  const children = await hydrateChildren(node.children, rowScope, cmsRepo);
  return { ...node, props: wrapperPropsOf(node, scope), children };
}

// =============================================================================
// helpers
// =============================================================================

/**
 * Resolve the source collection id from a slot's read-binding. Supports a
 * literal id (used as-is) or a `{{...}}` template resolving to an id string.
 * Returns null when there is no usable read-binding or the resolved value is
 * not a non-empty string (callers MUST treat null as the error/empty path).
 *
 * Reimplemented locally (rather than imported from the React-coupled
 * CollectionRenderer.tsx) so this module stays React-free and Node-evaluable.
 */
function resolveCollectionId(
  binding: BindingEntry | undefined,
  scope: BindingScope,
): string | null {
  if (!binding || binding.mode !== 'read') return null;
  const raw = typeof binding.expression === 'string' ? binding.expression.trim() : '';
  if (!raw) return null;

  const parsed = parseExpression(raw);
  if (parsed) {
    const resolved = evaluateExpression(parsed, scope);
    return typeof resolved === 'string' && resolved.length > 0 ? resolved : null;
  }
  return raw;
}

/** Resolve the wrapper props for a data node: bake its own read bindings, then
 *  drop `children` (the renderer owns per-row child construction). */
function wrapperPropsOf(node: ComponentNode, scope: BindingScope): Props {
  const { resolvedProps } = applyBindings(node, node.props ?? {}, scope);
  const wrapper: Props = { ...resolvedProps };
  delete (wrapper as Record<string, unknown>).children;
  return wrapper;
}

/** Read a string-valued node prop, falling back when absent or empty. */
function stringProp(
  props: Props | undefined,
  key: string,
  fallback: string,
): string {
  const raw = props?.[key];
  return typeof raw === 'string' && raw.length > 0 ? raw : fallback;
}

/** A data wrapper carrying a single text note (config message / emptyContent),
 *  matching the live renderers' `note(...)` shape (wrapper > span(text)). */
function noteNode(
  node: ComponentNode,
  scope: BindingScope,
  text: string,
): ComponentNode {
  return {
    ...node,
    props: wrapperPropsOf(node, scope),
    children: [{ type: 'span', props: { children: text } }],
  };
}

/** A data wrapper rendering NOTHING for the slot (the preview-mode error path):
 *  an empty wrapper, no children, no thrown build. */
function emptyWrapper(node: ComponentNode, scope: BindingScope): ComponentNode {
  return { ...node, props: wrapperPropsOf(node, scope), children: [] };
}

/** The wave-1 dashed-box label for an UNBOUND data node (mirrors
 *  createComponentElement's placeholder branch). */
function placeholderNode(node: ComponentNode, dataKind: string): ComponentNode {
  const label =
    dataKind === 'collection'
      ? 'Collection'
      : dataKind === 'record-view'
        ? 'Record view'
        : 'Table view';
  return {
    ...node,
    children: [{ type: 'span', props: { children: `${label} (no binding)` } }],
  };
}

/**
 * Flatten a hydrated tree to its text content, mirroring how the DOM computes
 * `textContent` for the equivalent preview render: element children win over a
 * raw-text `props.children` (the `content = children.length ? children :
 * rawTextChildren` rule in createComponentElement). Used by the parity test.
 */
export function nodeTextContent(node: ComponentNode): string {
  const kids = node.children ?? [];
  if (kids.length > 0) {
    return kids.map(nodeTextContent).join('');
  }
  const child = node.props?.children;
  return typeof child === 'string' ? child : '';
}
