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
// and read DIRECTLY in Node (no HTTP, no React, no jsdom). The LIVE editor and
// preview client keeps reading `/api/cms/*` over HTTP via its polling provider,
// and the storefront islands read `/api/commerce/*`; that path is unchanged by
// this module. Tenancy is the CALLER's: the storefront render passes
// `getCmsRepository(site.workspaceId)` for the site its request Host resolves to.
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
import { isTextNodeType, renderableText } from '@/lib/renderer/textNode';
import { MISSING_TYPE, serializedBytes } from '@/lib/components/placement';
import {
  bakeInputBindings,
  createRenderBudget,
  placementInstanceOf,
  resolveInputValues,
  withoutInstance,
  type RenderBudget,
} from '@/lib/components/expand';
import {
  createScope,
  lookup,
  pushAvailabilityFrame,
  pushInputFrame,
  pushPageFrame,
  pushProductFrame,
  pushRowFrame,
  pushVariantFrame,
  type BindingFrame,
  type BindingScope,
} from '@/lib/bindings/resolver/scope';
import {
  evaluateExpression,
  parseExpression,
} from '@/lib/bindings/resolver/expression';
import type { BindingEntry, BindingsRecord } from '@/lib/bindings/types';
import type { HoverKind } from '@/lib/effects/effects';
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
  /**
   * On a node a placement expanded to: the definition node's id. `id` is unique to
   * the placement, so a form placed twice is two forms; a class keys on this, so
   * twelve cards share their CSS. Spreading a node keeps both.
   */
  classKey?: string;
  /**
   * The hover preset, from applyEffects to applyResponsiveStyles, which turns it into
   * a shared class. On the node rather than in `className`, because that step removes
   * every stored `fc_` name, and no stored page can spell a mark set after hydration.
   */
  hoverPreset?: HoverKind;
  /**
   * On an interactive commerce island only: the commerce frames (product, variant, availability) of the
   * source it sits in, as the hydrator resolved them. The island is shipped verbatim and rendered later
   * from the page scope alone, so without these a variant selector inside a product detail would find no
   * product. Plain DTO data, so it crosses the client boundary with the node.
   */
  islandFrames?: BindingFrame[];
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

/** The repositories, and the page's budget, which rows draw on after expansion. */
interface HydrationContext extends HydrationRepos {
  budget: RenderBudget;
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

/** The commerce frames of a scope (product, variant, availability), in order: what an island needs to see. */
function commerceFramesOf(scope: BindingScope): BindingFrame[] {
  return scope.frames.filter((f) => f.kind === 'product' || f.kind === 'variant' || f.kind === 'availability');
}

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
 * Log a data-slot read failure. The slot still renders empty (hydration never
 * throws the page), but the cause reaches the server log instead of vanishing.
 */
function logSlotReadError(slot: string, err: unknown): void {
  console.error(`[hydrate] ${slot} read failed; rendering the slot empty`, err);
}

/**
 * True when hydrating `pageTree` would READ commerce data: some node outside an
 * interactive island is a BOUND commerce source (product-list / product-detail).
 * Unbound sources render a placeholder and islands are never baked, so neither
 * needs a repository. The render route asks this BEFORE deriving the commerce
 * handle, so a page without commerce bindings never touches the commerce
 * connection (and never fails because it is unconfigured).
 */
export function treeNeedsCommerceRepo(pageTree: ComponentNode): boolean {
  const stack: ComponentNode[] = [pageTree];
  while (stack.length > 0) {
    const node = stack.pop()!;
    const dataKind = node.props?.['data-component-kind'];
    if (typeof dataKind === 'string' && INTERACTIVE_COMMERCE_KINDS.has(dataKind)) continue;
    const hasBindings = !!node.bindings && Object.keys(node.bindings).length > 0;
    if (typeof dataKind === 'string' && COMMERCE_SOURCE_KINDS.has(dataKind) && hasBindings) {
      return true;
    }
    for (const child of node.children ?? []) stack.push(child);
  }
  return false;
}

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
  productPagePath?: string | null,
  budget: RenderBudget = createRenderBudget(),
): Promise<ComponentNode> {
  // The page frame drives `{{page.params.*}}` resolution (RecordView row id,
  // ProductDetail handle) and `{{product.href}}` (the site's product page path).
  const rootScope = pushPageFrame(createScope(), pageParams, productPagePath);
  const root = await hydrateNode(pageTree, rootScope, { ...repos, budget });
  // A root that hides itself: the page still serves, with nothing on it.
  return root ?? { type: MISSING_TYPE };
}

// =============================================================================
// node dispatch
// =============================================================================

/**
 * True when a bound `visible` resolves to exactly `false`, which removes the node
 * from the markup. Anything else keeps it, so a binding that fails shows content
 * rather than hiding it.
 */
function isHiddenByBinding(node: ComponentNode, scope: BindingScope): boolean {
  const binding = node.bindings?.visible;
  if (!binding || binding.mode !== 'read') return false;
  const parsed = parseExpression(binding.expression);
  return !!parsed && evaluateExpression(parsed, scope) === false;
}

/**
 * Null when `visible` removes the node. A placement root opens its input frame
 * here, with its values resolved in the scope outside it and parsed after they
 * resolve, because a value bound to data is only known now.
 */
async function hydrateNode(
  stored: ComponentNode,
  outerScope: BindingScope,
  repos: HydrationContext,
): Promise<ComponentNode | null> {
  const instance = placementInstanceOf(stored.props);
  const scope = instance ? pushInputFrame(outerScope, resolveInputValues(instance, outerScope, repos.budget)) : outerScope;
  const node = instance ? withoutInstance(stored) : stored;
  if (isHiddenByBinding(node, scope)) return null;

  // A text node is only its text (which may be bound), whatever else a stored
  // row carries: no dispatch below applies to it.
  if (isTextNodeType(node.type)) {
    return { ...node, props: applyBindings(node, node.props ?? {}, scope).resolvedProps, children: [] };
  }

  const dataKind = node.props?.['data-component-kind'];
  const hasBindings = !!node.bindings && Object.keys(node.bindings).length > 0;

  // ----- Commerce (Track C) dispatch -----
  // Interactive kinds are left VERBATIM (runtime islands), regardless of
  // bindings, and we do NOT recurse into their subtree: the whole island is
  // shipped as-is for client-side hydration.
  if (typeof dataKind === 'string' && INTERACTIVE_COMMERCE_KINDS.has(dataKind)) {
    const island = bakeIsland(node, scope, repos.budget);
    const islandFrames = commerceFramesOf(scope);
    return islandFrames.length > 0 ? { ...island, islandFrames } : island;
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

/**
 * An island ships verbatim and no renderer applies bindings inside it, so what
 * only this pass can know is baked in first: input values and `visible`, and any
 * placement inside it opens its frame here. Commerce bindings stay for the
 * client. A node none of that touches comes back as it went in.
 */
function bakeIsland(node: ComponentNode, scope: BindingScope, budget: RenderBudget): ComponentNode {
  const baked = bakeInputBindings(node, scope);
  const children = node.children?.flatMap((child) => {
    const instance = placementInstanceOf(child.props);
    const childScope = instance ? pushInputFrame(scope, resolveInputValues(instance, scope, budget)) : scope;
    const stored = instance ? withoutInstance(child) : child;
    return isHiddenByBinding(stored, childScope) ? [] : [bakeIsland(stored, childScope, budget)];
  });
  const same = !children || (children.length === node.children?.length && children.every((child, i) => child === node.children?.[i]));
  return same ? baked : { ...baked, children };
}

async function hydrateOrdinary(
  node: ComponentNode,
  scope: BindingScope,
  repos: HydrationContext,
): Promise<ComponentNode> {
  const { resolvedProps } = applyBindings(node, node.props ?? {}, scope);
  const children = await hydrateChildren(node.children, scope, repos);
  return { ...node, props: resolvedProps, children };
}

async function hydrateChildren(
  children: ComponentNode[] | undefined,
  scope: BindingScope,
  repos: HydrationContext,
): Promise<ComponentNode[]> {
  if (!children || children.length === 0) return [];
  const hydrated = await Promise.all(children.map((child) => hydrateNode(child, scope, repos)));
  return hydrated.filter((child) => child !== null);
}

/** What one more copy of a template costs, or null for one no placement made. */
interface TemplateCost {
  nodes: number;
  bytes: number;
}

const templateCosts = new WeakMap<ComponentNode, TemplateCost | null>();

function templateCostOf(template: ComponentNode): TemplateCost | null {
  const known = templateCosts.get(template);
  if (known !== undefined) return known;
  let nodes = 0;
  let expanded = false;
  const stack = [template];
  while (stack.length > 0) {
    const node = stack.pop()!;
    nodes += 1;
    expanded ||= node.classKey !== undefined;
    for (const child of node.children ?? []) stack.push(child);
  }
  const cost = expanded ? { nodes, bytes: serializedBytes(template) } : null;
  templateCosts.set(template, cost);
  return cost;
}

/**
 * One hydrated copy of a template per scope. Expansion paid for the first copy,
 * and each further one of a template holding expanded nodes draws on the budget,
 * so a large card in a 100 row Collection is counted as what it renders. Past the
 * limit the rows that do not fit are left out. A template no placement made is
 * never charged: a page without placements renders every row, as it always has.
 */
async function hydrateCopies(
  template: ComponentNode,
  scopes: BindingScope[],
  repos: HydrationContext,
): Promise<ComponentNode[]> {
  const cost = templateCostOf(template);
  const paid = cost
    ? scopes.filter((_, index) => index === 0 || repos.budget.charge(cost.nodes, cost.bytes))
    : scopes;
  const copies = await Promise.all(paid.map((scope) => hydrateNode(template, scope, repos)));
  return copies.filter((copy) => copy !== null);
}

// =============================================================================
// Collection: one hydrated block per row
// =============================================================================

async function hydrateCollection(
  node: ComponentNode,
  scope: BindingScope,
  repos: HydrationContext,
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
  } catch (err) {
    // Documented degrade: a fetch error during hydration renders nothing for
    // this slot and NEVER throws the build (preview-surface contract,
    // resolveDataState's preview-mode error path). It is LOGGED, never silent.
    logSlotReadError('collection', err);
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
  const items = await hydrateCopies(template, rows.map((row) => pushRowFrame(scope, row)), repos);
  return { ...node, props: wrapperPropsOf(node, scope), children: items };
}

// =============================================================================
// RecordView: a single row resolved from the page slug params
// =============================================================================

async function hydrateRecordView(
  node: ComponentNode,
  scope: BindingScope,
  repos: HydrationContext,
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
  } catch (err) {
    // Documented degrade (see hydrateCollection): error renders nothing, never
    // throws the build, and is logged.
    logSlotReadError('record-view', err);
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
  repos: HydrationContext,
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
  repos: HydrationContext,
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
  } catch (err) {
    // Documented degrade: render nothing for the slot, never throw the build,
    // and log the cause so an empty shop slot is never silent.
    logSlotReadError('product-list', err);
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
  const items = await hydrateCopies(template, products.map((product) => pushProductFrame(scope, product)), repos);
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
  repos: HydrationContext,
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
  } catch (err) {
    // Documented degrade: render nothing for the slot, never throw the build,
    // and log the cause so an empty shop slot is never silent.
    logSlotReadError('product-detail', err);
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
  const props = { ...(node.props ?? {}) };
  delete (props as Record<string, unknown>).children;
  return {
    ...node,
    props,
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
 * `textContent` for the equivalent preview render: a node's own text, then its
 * children in order (the rule in src/lib/renderer/textNode.ts). A numeric
 * `children` (e.g. a baked price/availability) stringifies the way React renders
 * a number as text. Used by the parity test.
 */
export function nodeTextContent(node: ComponentNode): string {
  const own = renderableText(node.props?.children);
  return `${own ?? ''}${(node.children ?? []).map(nodeTextContent).join('')}`;
}
