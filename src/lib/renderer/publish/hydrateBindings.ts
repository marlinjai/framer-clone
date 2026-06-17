// hydrateBindings: build-time read-binding hydration for the static-publish path.
//
// This module is PURE and React-free (no React, no jsdom, no MST). It expands a
// data-bound component tree into a tree of CONCRETE prop values by walking the
// React-free resolver (`applyBindings` / `pushRowFrame` / `pushPageFrame` /
// `pushProductFrame` / `lookup`). It is the build-time counterpart to the live
// preview renderers (HeadlessComponentRenderer -> CollectionRenderer /
// RecordViewRenderer / ProductListRenderer / ProductDetailRenderer): same
// resolution logic, same empty/error behavior, but resolved eagerly in Node at
// build time instead of lazily via React effects in the browser.
//
// Reader seam: CMS rows are fetched server-side by importing the local
// `src/server/cms` `CmsReadRepository` DIRECTLY (a type-only import here; the
// concrete repo is injected by the caller). Commerce reads (catalog list,
// product-by-handle, the default variant + price + advisory availability) are
// fetched the SAME way: a `CommerceServerRepository` is injected by the caller
// and read DIRECTLY in Node (no HTTP, no React, no jsdom). The LIVE client keeps
// reading `/api/cms/*` and `/api/commerce/*` over HTTP via its polling
// providers; that path is unchanged by this module.
//
// Options-object signature: `hydrateBindings(tree, params, { cmsRepo,
// commerceRepo })`. `commerceRepo` is ADDITIVE and OPTIONAL: a CMS-only caller
// passing `{ cmsRepo }` keeps working unbroken, and a commerce-bound tree gets
// its catalog reads baked when `commerceRepo` is supplied.
//
// HARD LINE on what commerce hydrates: ONLY the catalog READ surface is baked
// (ProductList -> one block per product; ProductDetail -> a single product
// resolved from the page handle, with its default variant, first price, and
// ADVISORY availability folded into display frames). The four INTERACTIVE
// commerce kinds (variant-selector / add-to-cart / cart-view / checkout-button)
// are NEVER baked: they are left VERBATIM as runtime island placeholders for
// client-side hydration on the published site. Advisory availability is a
// DISPLAY value only and is NEVER permission to sell; Track B stays
// server-authoritative for stock and writes.
//
// Empty / error contract (mirrors the preview surface, resolveDataState):
//  - empty Collection / not-found RecordView / empty catalog / not-found
//    product -> the configured `emptyContent`.
//  - a fetch error during hydration renders NOTHING for that slot and NEVER
//    throws the build. This is the ONE documented swallow in this module and is
//    covered by tests for both the CMS and the commerce paths.
//
// TODO(static-html wave): wiring this helper into the actual published output
// is GATED on the static-html wave. `projectPublisher.ts` / the per-page
// `staticHtmlEmitter.ts` do NOT exist yet; once `static-html-spike` and
// `static-html-publish-pipeline` land, the per-page emitter calls
// `hydrateBindings(pageTree, pageParams, { cmsRepo: getCmsRepository(),
// commerceRepo: getCommerceServerRepository() })` before serializing. That
// wiring is a one-line call by design; see the follow-on stubs
// `followon-wire-hydratebindings-into-publish.md` (CMS) and
// `followon-wire-commerce-hydratebindings-publish.md` (commerce). Client-side
// runtime-island hydration for the interactive commerce kinds is ALSO gated on
// the static-html wave. Do NOT wire any of it here.

import { applyBindings, type Props } from '@/lib/bindings/resolver/applyBindings';
import {
  createScope,
  lookup,
  pushAvailabilityFrame,
  pushPageFrame,
  pushProductFrame,
  pushRowFrame,
  pushVariantFrame,
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
// Type-only commerce DTOs (React-free, Node-evaluable). The concrete commerce
// repo is injected by the caller, exactly like the CMS repo.
import type {
  AvailabilityDTO,
  CommerceQuery,
  PriceDTO,
  ProductDTO,
  ProductPage,
  ProductVariantDTO,
} from '@/lib/commerce/types';

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
 * The Node-direct commerce READ seam the hydrator consumes. A subset of the
 * client `CommerceDataSource`: only the read methods the build-time bake needs.
 * The concrete repo (read DIRECTLY against `src/server/commerce` in Node, or a
 * test double) is injected by the caller; this is a type-only contract so the
 * hydrate path pulls in no server-only runtime code and stays Node-evaluable.
 *
 * READS ONLY by design: there is intentionally no write/reserve/checkout method.
 * `getAvailability` returns an ADVISORY value (display-only, never permission to
 * sell).
 */
export interface CommerceServerRepository {
  /** List products (filter/sort/limit) -> one page of ProductDTOs plus total. */
  listProducts(query?: CommerceQuery): Promise<ProductPage>;
  /** A single product by its handle, or null when no such product exists. */
  getProductByHandle(handle: string): Promise<ProductDTO | null>;
  /** Every variant of a product (empty array when it has none). */
  listVariants(productId: string): Promise<ProductVariantDTO[]>;
  /** Price rows for a variant (empty array when the variant has no prices). */
  getPrices(variantId: string): Promise<PriceDTO[]>;
  /**
   * ADVISORY availability for a variant (aggregated across locations when no
   * locationId is given). Information only, NEVER permission to sell. Throws
   * when the variant does not exist; the hydrator's documented per-slot swallow
   * turns such a throw into an empty slot, never a failed build.
   */
  getAvailability(variantId: string, locationId?: string): Promise<AvailabilityDTO>;
}

/**
 * Repositories available to the hydrator. Options-object form so the commerce
 * repo is ADDITIVE: `commerceRepo` is optional, keeping every existing CMS-only
 * call site (`{ cmsRepo }`) working unbroken. A commerce-bound tree reached
 * without a `commerceRepo` resolves to the unbound configuration placeholder
 * (never a throw).
 */
export interface HydrationRepos {
  cmsRepo: CmsReadRepository;
  commerceRepo?: CommerceServerRepository;
}

// The four INTERACTIVE commerce kinds. These are NEVER baked: they are left
// verbatim as runtime island placeholders for client-side hydration on the
// published site (cart / variant-selection / checkout are client-authoritative).
const INTERACTIVE_COMMERCE_KINDS: ReadonlySet<string> = new Set([
  'variant-selector',
  'add-to-cart',
  'cart-view',
  'checkout-button',
]);

// The two commerce SOURCE (catalog READ) kinds the hydrator bakes.
const COMMERCE_SOURCE_KINDS: ReadonlySet<string> = new Set([
  'product-list',
  'product-detail',
]);

// Human labels for the unbound dashed-box placeholder (mirrors
// createComponentElement's COMMERCE_KIND_LABELS).
const COMMERCE_KIND_LABELS: Record<string, string> = {
  'product-list': 'Product list',
  'product-detail': 'Product detail',
};

/**
 * Expand a data-bound tree into concrete prop values.
 *
 * Collection / ProductList nodes expand to one hydrated block per row/product;
 * RecordView / ProductDetail nodes resolve a single row/product from the page
 * params; ordinary nodes have their read bindings baked into props. Interactive
 * commerce nodes are left verbatim (runtime islands). Runs entirely in Node: no
 * React, no jsdom.
 */
export async function hydrateBindings(
  pageTree: ComponentNode,
  pageParams: Record<string, string>,
  repos: HydrationRepos,
): Promise<ComponentNode> {
  // The page frame drives `{{page.params.*}}` resolution (RecordView row id,
  // ProductDetail handle).
  const rootScope = pushPageFrame(createScope(), pageParams);
  return hydrateNode(pageTree, rootScope, repos);
}

// =============================================================================
// node dispatch
// =============================================================================

async function hydrateNode(
  node: ComponentNode,
  scope: BindingScope,
  repos: HydrationRepos,
): Promise<ComponentNode> {
  const dataKind = node.props?.['data-component-kind'];
  const hasBindings = !!node.bindings && Object.keys(node.bindings).length > 0;

  // ----- Commerce (Track C) dispatch -----
  // Interactive kinds are left VERBATIM (runtime islands), regardless of
  // bindings, and we do NOT recurse into their subtree: the whole island is
  // shipped as-is for client-side hydration.
  if (typeof dataKind === 'string' && INTERACTIVE_COMMERCE_KINDS.has(dataKind)) {
    return node;
  }
  if (typeof dataKind === 'string' && COMMERCE_SOURCE_KINDS.has(dataKind)) {
    return hydrateCommerceSource(node, scope, repos, dataKind, hasBindings);
  }

  // ----- CMS dispatch (unchanged) -----
  if (dataKind === 'collection' && hasBindings) {
    return hydrateCollection(node, scope, repos);
  }
  if (dataKind === 'record-view' && hasBindings) {
    return hydrateRecordView(node, scope, repos);
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
  return hydrateOrdinary(node, scope, repos);
}

async function hydrateOrdinary(
  node: ComponentNode,
  scope: BindingScope,
  repos: HydrationRepos,
): Promise<ComponentNode> {
  const { resolvedProps } = applyBindings(node, node.props ?? {}, scope);
  const children = await hydrateChildren(node.children, scope, repos);
  return { ...node, props: resolvedProps, children };
}

async function hydrateChildren(
  children: ComponentNode[] | undefined,
  scope: BindingScope,
  repos: HydrationRepos,
): Promise<ComponentNode[]> {
  if (!children || children.length === 0) return [];
  return Promise.all(children.map((child) => hydrateNode(child, scope, repos)));
}

// =============================================================================
// Collection: one hydrated block per row
// =============================================================================

async function hydrateCollection(
  node: ComponentNode,
  scope: BindingScope,
  repos: HydrationRepos,
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
    const page = await repos.cmsRepo.listRows(collectionId, query);
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
    rows.map((row) => hydrateNode(template, pushRowFrame(scope, row), repos)),
  );
  return { ...node, props: wrapperPropsOf(node, scope), children: items };
}

// =============================================================================
// RecordView: a single row resolved from the page slug params
// =============================================================================

async function hydrateRecordView(
  node: ComponentNode,
  scope: BindingScope,
  repos: HydrationRepos,
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
    row = await repos.cmsRepo.getRow(collectionId, rowId);
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
  const children = await hydrateChildren(node.children, rowScope, repos);
  return { ...node, props: wrapperPropsOf(node, scope), children };
}

// =============================================================================
// Commerce: ProductList (per-product expansion) + ProductDetail (from handle)
// =============================================================================

/**
 * Dispatch a commerce SOURCE node (product-list / product-detail) to its bake.
 * Mirrors createComponentElement's commerce branch: a source node is baked only
 * when it is BOUND and a `commerceRepo` is available; otherwise it falls through
 * to the unbound dashed-box placeholder (never a silent empty success).
 */
async function hydrateCommerceSource(
  node: ComponentNode,
  scope: BindingScope,
  repos: HydrationRepos,
  dataKind: string,
  hasBindings: boolean,
): Promise<ComponentNode> {
  if (!hasBindings || !repos.commerceRepo) {
    return commercePlaceholderNode(node, dataKind);
  }
  if (dataKind === 'product-list') {
    return hydrateProductList(node, scope, repos);
  }
  return hydrateProductDetail(node, scope, repos);
}

/**
 * ProductList: one hydrated block per product, mirroring ProductListRenderer.
 * The `products` read-binding is a MARKER (there is no source id to resolve:
 * `listProducts` lists the whole catalog), so presence of the binding is all
 * that gates the bake (checked by the caller). Empty catalog -> emptyContent;
 * a fetch error renders nothing for the slot and NEVER throws the build.
 */
async function hydrateProductList(
  node: ComponentNode,
  scope: BindingScope,
  repos: HydrationRepos,
): Promise<ComponentNode> {
  // Guaranteed present by hydrateCommerceSource's gate.
  const commerceRepo = repos.commerceRepo!;
  // Structured filter/sort/limit live as a CommerceQuery object on props.query
  // (NOT a template expression), exactly as the live ProductListRenderer reads it.
  const query = node.props?.query as CommerceQuery | undefined;

  let products: ProductDTO[];
  try {
    const page = await commerceRepo.listProducts(query);
    products = page.products;
  } catch {
    // Documented swallow: render nothing for the slot, never throw the build.
    return emptyWrapper(node, scope);
  }

  if (products.length === 0) {
    return noteNode(node, scope, stringProp(node.props, 'emptyContent', 'No products'));
  }

  const template = node.children?.[0];
  if (!template) {
    return noteNode(
      node,
      scope,
      'Product list: add a child to use as the product template',
    );
  }

  // One hydrated template instance per product, each against a product-scoped
  // chain so descendants resolve `{{product.field}}` to that product's values.
  const items = await Promise.all(
    products.map((product) =>
      hydrateNode(template, pushProductFrame(scope, product), repos),
    ),
  );
  return { ...node, props: wrapperPropsOf(node, scope), children: items };
}

/**
 * ProductDetail: a single product resolved from `{{page.params.handle}}`,
 * mirroring ProductDetailRenderer. Resolves the DEFAULT (first) variant, folds
 * its first price into a variant frame, and folds its ADVISORY availability
 * (aggregated across locations) into an availability frame, then hydrates ALL
 * children against {{product.*}} / {{variant.*}} / {{variant.price.*}} /
 * {{availability.*}}.
 *
 * No handle in scope -> configuration note. A null product -> emptyContent. A
 * fetch error (product OR variant/price/availability resolution) renders
 * nothing for the slot and NEVER throws the build. Availability is a DISPLAY
 * value only and is NEVER permission to sell.
 */
async function hydrateProductDetail(
  node: ComponentNode,
  scope: BindingScope,
  repos: HydrationRepos,
): Promise<ComponentNode> {
  // Guaranteed present by hydrateCommerceSource's gate.
  const commerceRepo = repos.commerceRepo!;
  const rawHandle = lookup(scope, ['page', 'params', 'handle']);
  const handle = typeof rawHandle === 'string' && rawHandle.length > 0 ? rawHandle : null;
  // Configuration guard (mirrors ProductDetailRenderer): no handle in scope.
  if (!handle) {
    return noteNode(node, scope, 'Product detail: no product selected');
  }

  let product: ProductDTO | null = null;
  let variant: ProductVariantDTO | null = null;
  let price: PriceDTO | undefined;
  let availability: AvailabilityDTO | null = null;
  try {
    product = await commerceRepo.getProductByHandle(handle);
    if (product) {
      // Resolve the DEFAULT (first) variant, then fold its first price in and
      // resolve its advisory availability. A product with no variants resolves
      // with nulls: the product still renders, price/availability just do not.
      const variants = await commerceRepo.listVariants(product.id);
      variant = variants.length > 0 ? variants[0] : null;
      if (variant) {
        const prices = await commerceRepo.getPrices(variant.id);
        price = prices.length > 0 ? prices[0] : undefined;
        availability = await commerceRepo.getAvailability(variant.id);
      }
    }
  } catch {
    // Documented swallow: render nothing for the slot, never throw the build.
    return emptyWrapper(node, scope);
  }

  if (!product) {
    return noteNode(
      node,
      scope,
      stringProp(node.props, 'emptyContent', 'Product not found'),
    );
  }

  // Push product, then the default variant (with its folded price), then the
  // ADVISORY availability, so descendants resolve {{product.*}},
  // {{variant.price.*}}, and {{availability.*}}.
  let productScope = pushProductFrame(scope, product);
  if (variant) {
    productScope = pushVariantFrame(productScope, variant, price);
  }
  if (availability) {
    productScope = pushAvailabilityFrame(productScope, availability);
  }

  const children = await hydrateChildren(node.children, productScope, repos);
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

/** The dashed-box label for an UNBOUND commerce SOURCE node (or one reached
 *  without a commerceRepo). Mirrors createComponentElement's commerce
 *  placeholder branch: `<host><span>{Label} (no binding)</span></host>`, with
 *  the node's own props preserved verbatim (no binding resolution). */
function commercePlaceholderNode(node: ComponentNode, dataKind: string): ComponentNode {
  const label = COMMERCE_KIND_LABELS[dataKind] ?? 'Commerce component';
  const props = { ...(node.props ?? {}) };
  delete (props as Record<string, unknown>).children;
  return {
    ...node,
    props,
    children: [{ type: 'span', props: { children: `${label} (no binding)` } }],
  };
}

/**
 * Flatten a hydrated tree to its text content, mirroring how the DOM computes
 * `textContent` for the equivalent preview render: element children win over a
 * raw-text `props.children` (the `content = children.length ? children :
 * rawTextChildren` rule in createComponentElement). A numeric `children` (e.g.
 * a baked price/availability) stringifies the way React renders a number as
 * text. Used by the parity test.
 */
export function nodeTextContent(node: ComponentNode): string {
  const kids = node.children ?? [];
  if (kids.length > 0) {
    return kids.map(nodeTextContent).join('');
  }
  const child = node.props?.children;
  if (typeof child === 'string') return child;
  if (typeof child === 'number') return String(child);
  return '';
}
