// @vitest-environment node
//
// Commerce build-time hydration runs in Node with NO React and NO jsdom: it is
// the build-time counterpart to the live storefront renderers
// (ProductListRenderer / ProductDetailRenderer), evaluated eagerly through the
// React-free resolver. This suite opts the file into the node environment (the
// repo convention documented in vitest.config.ts) so it exercises the helper
// under the same resolver-runtime node-env config the resolver tests use, and
// asserts that environment explicitly. The commerce reads go through an
// injected CommerceServerRepository called DIRECTLY in Node: no HTTP, no React.
import { describe, it, expect } from 'vitest';
import {
  hydrateBindings,
  nodeTextContent,
  type ComponentNode,
  type CommerceServerRepository,
} from '@/lib/renderer/publish/hydrateBindings';
import type { CmsReadRepository } from '@/server/cms';
import type {
  AvailabilityDTO,
  CommerceQuery,
  PriceDTO,
  ProductDTO,
  ProductPage,
  ProductVariantDTO,
} from '@/lib/commerce/types';

// A CmsReadRepository stub: commerce-only trees never reach it, so every method
// throws to prove the commerce path does not touch the CMS repo.
function makeCmsRepo(): CmsReadRepository {
  const fail = () => {
    throw new Error('CMS repo must not be called on a commerce-only tree');
  };
  return {
    listCollections: fail,
    getCollection: fail,
    listRows: fail,
    getRow: fail,
  } as unknown as CmsReadRepository;
}

// --- Commerce repo test double (configurable, call-recording) --------------

interface CommerceRepoOptions {
  products?: ProductDTO[];
  total?: number;
  productByHandle?: Record<string, ProductDTO>;
  variants?: Record<string, ProductVariantDTO[]>;
  prices?: Record<string, PriceDTO[]>;
  availability?: Record<string, AvailabilityDTO>;
  listProductsImpl?: (query?: CommerceQuery) => Promise<ProductPage>;
  getProductByHandleImpl?: (handle: string) => Promise<ProductDTO | null>;
}

interface RecordingCommerceRepo extends CommerceServerRepository {
  calls: {
    listProducts: Array<CommerceQuery | undefined>;
    getProductByHandle: string[];
    listVariants: string[];
    getPrices: string[];
    getAvailability: string[];
  };
}

function makeCommerceRepo(opts: CommerceRepoOptions = {}): RecordingCommerceRepo {
  const calls: RecordingCommerceRepo['calls'] = {
    listProducts: [],
    getProductByHandle: [],
    listVariants: [],
    getPrices: [],
    getAvailability: [],
  };
  return {
    calls,
    async listProducts(query?: CommerceQuery): Promise<ProductPage> {
      calls.listProducts.push(query);
      if (opts.listProductsImpl) return opts.listProductsImpl(query);
      const products = opts.products ?? [];
      return { products, total: opts.total ?? products.length };
    },
    async getProductByHandle(handle: string): Promise<ProductDTO | null> {
      calls.getProductByHandle.push(handle);
      if (opts.getProductByHandleImpl) return opts.getProductByHandleImpl(handle);
      return opts.productByHandle?.[handle] ?? null;
    },
    async listVariants(productId: string): Promise<ProductVariantDTO[]> {
      calls.listVariants.push(productId);
      return opts.variants?.[productId] ?? [];
    },
    async getPrices(variantId: string): Promise<PriceDTO[]> {
      calls.getPrices.push(variantId);
      return opts.prices?.[variantId] ?? [];
    },
    async getAvailability(variantId: string): Promise<AvailabilityDTO> {
      calls.getAvailability.push(variantId);
      const found = opts.availability?.[variantId];
      if (!found) {
        throw new Error(`no availability for ${variantId}`);
      }
      return found;
    },
  };
}

// --- Fixtures --------------------------------------------------------------

function product(id: string, handle: string, title: string): ProductDTO {
  return {
    id,
    handle,
    title,
    description: null,
    options: [],
    variantIds: [],
  };
}

const PRODUCTS: ProductDTO[] = [
  product('prod_a', 'alpha', 'Alpha'),
  product('prod_b', 'beta', 'Beta'),
];

// A product-list node bound to the catalog whose first child is the per-product
// card template (two field-bound spans: title + handle).
function productListNode(extraProps: Record<string, unknown> = {}): ComponentNode {
  return {
    id: 'list',
    type: 'div',
    props: { 'data-component-kind': 'product-list', ...extraProps },
    bindings: { products: { mode: 'read', expression: 'products' } },
    children: [
      {
        id: 'card',
        type: 'div',
        props: {},
        children: [
          {
            id: 'card-title',
            type: 'span',
            props: {},
            bindings: { children: { mode: 'read', expression: '{{product.title}}' } },
          },
          {
            id: 'card-handle',
            type: 'span',
            props: {},
            bindings: { children: { mode: 'read', expression: '{{product.handle}}' } },
          },
        ],
      },
    ],
  };
}

// A product-detail node resolving {{product.*}}, {{variant.price.*}}, and the
// ADVISORY {{availability.*}} display values.
function productDetailNode(extraProps: Record<string, unknown> = {}): ComponentNode {
  return {
    id: 'detail',
    type: 'div',
    props: { 'data-component-kind': 'product-detail', ...extraProps },
    bindings: { product: { mode: 'read', expression: 'product' } },
    children: [
      {
        id: 'pd-title',
        type: 'h1',
        props: {},
        bindings: { children: { mode: 'read', expression: '{{product.title}}' } },
      },
      {
        id: 'pd-price',
        type: 'span',
        props: {},
        bindings: { children: { mode: 'read', expression: '{{variant.price.amountCents}}' } },
      },
      {
        id: 'pd-stock',
        type: 'span',
        props: {},
        bindings: {
          children: { mode: 'read', expression: '{{availability.availableQuantity}}' },
        },
      },
    ],
  };
}

const TEE = product('prod_tee', 'classic-tee', 'Classic Tee');
const TEE_VARIANT: ProductVariantDTO = {
  id: 'var_s_red',
  productId: 'prod_tee',
  title: 'Small / Red',
  sku: 'TEE-S-RED',
  optionValues: [],
};
const TEE_PRICE: PriceDTO = {
  variantId: 'var_s_red',
  amountCents: 2500,
  currency: 'usd',
};
const TEE_AVAILABILITY: AvailabilityDTO = {
  variantId: 'var_s_red',
  locationId: 'all',
  availableQuantity: 40,
  // ADVISORY: a value the future HTTP provider may flag as stale. Display-only.
  stale: true,
};

function detailRepo(): RecordingCommerceRepo {
  return makeCommerceRepo({
    productByHandle: { 'classic-tee': TEE },
    variants: { prod_tee: [TEE_VARIANT] },
    prices: { var_s_red: [TEE_PRICE] },
    availability: { var_s_red: TEE_AVAILABILITY },
  });
}

// Find a node by id anywhere in a hydrated tree.
function findById(node: ComponentNode, id: string): ComponentNode | null {
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    const hit = findById(child, id);
    if (hit) return hit;
  }
  return null;
}

describe('hydrateBindings commerce', () => {
  it('runs under the resolver-runtime node-env config (no React, no jsdom)', () => {
    expect(typeof window).toBe('undefined');
    expect(typeof document).toBe('undefined');
  });

  it('expands ProductList to one hydrated block per product (Node-direct repo)', async () => {
    const commerceRepo = makeCommerceRepo({ products: PRODUCTS });
    const tree = await hydrateBindings(productListNode(), {}, {
      cmsRepo: makeCmsRepo(),
      commerceRepo,
    });

    // One card per product, each with {{product.title}}/{{product.handle}} baked.
    expect(tree.children).toHaveLength(2);
    expect(nodeTextContent(tree)).toBe('AlphaalphaBetabeta');
    // The repo was called DIRECTLY (no HTTP layer between hydrator and repo).
    expect(commerceRepo.calls.listProducts).toHaveLength(1);
  });

  it('passes the structured CommerceQuery on props.query through to listProducts', async () => {
    const query: CommerceQuery = {
      filter: [{ field: 'title', op: 'contains', value: 'Al' }],
      limit: 5,
    };
    const commerceRepo = makeCommerceRepo({ products: [PRODUCTS[0]] });
    await hydrateBindings(productListNode({ query }), {}, {
      cmsRepo: makeCmsRepo(),
      commerceRepo,
    });
    expect(commerceRepo.calls.listProducts[0]).toEqual(query);
  });

  it('renders emptyContent for an empty catalog and never throws', async () => {
    const commerceRepo = makeCommerceRepo({ products: [] });
    const tree = await hydrateBindings(
      productListNode({ emptyContent: 'Nothing in stock' }),
      {},
      { cmsRepo: makeCmsRepo(), commerceRepo },
    );
    expect(nodeTextContent(tree)).toBe('Nothing in stock');
  });

  it('renders nothing for the slot on a ProductList fetch error and NEVER throws the build', async () => {
    const commerceRepo = makeCommerceRepo({
      listProductsImpl: async () => {
        throw new Error('boom: commerce unreachable');
      },
    });
    const tree = await hydrateBindings(productListNode(), {}, {
      cmsRepo: makeCmsRepo(),
      commerceRepo,
    });
    expect(tree.children).toEqual([]);
    expect(nodeTextContent(tree)).toBe('');
  });

  it('resolves ProductDetail from pageParams.handle, baking product/variant price/advisory availability', async () => {
    const commerceRepo = detailRepo();
    const tree = await hydrateBindings(
      productDetailNode(),
      { handle: 'classic-tee' },
      { cmsRepo: makeCmsRepo(), commerceRepo },
    );

    // Resolved by handle, Node-direct.
    expect(commerceRepo.calls.getProductByHandle).toEqual(['classic-tee']);
    expect(commerceRepo.calls.listVariants).toEqual(['prod_tee']);

    // {{product.title}} baked.
    expect(findById(tree, 'pd-title')?.props?.children).toBe('Classic Tee');
    // {{variant.price.amountCents}} baked as the integer-cents DISPLAY value.
    expect(findById(tree, 'pd-price')?.props?.children).toBe(2500);
    // ADVISORY availability baked as a DISPLAY value (never permission to sell).
    expect(findById(tree, 'pd-stock')?.props?.children).toBe(40);
  });

  it('bakes the advisory availability stale flag as a display value', async () => {
    const commerceRepo = detailRepo();
    const node = productDetailNode();
    // Add a child binding {{availability.stale}} to assert the advisory flag.
    node.children!.push({
      id: 'pd-stale',
      type: 'span',
      props: {},
      bindings: { 'data-stale': { mode: 'read', expression: '{{availability.stale}}' } },
    });
    const tree = await hydrateBindings(
      node,
      { handle: 'classic-tee' },
      { cmsRepo: makeCmsRepo(), commerceRepo },
    );
    expect(findById(tree, 'pd-stale')?.props?.['data-stale']).toBe(true);
  });

  it('renders emptyContent when no product resolves for the handle', async () => {
    const commerceRepo = makeCommerceRepo({ productByHandle: {} });
    const tree = await hydrateBindings(
      productDetailNode({ emptyContent: 'No such product' }),
      { handle: 'ghost' },
      { cmsRepo: makeCmsRepo(), commerceRepo },
    );
    expect(nodeTextContent(tree)).toBe('No such product');
  });

  it('renders nothing for the slot on a ProductDetail fetch error and NEVER throws the build', async () => {
    const commerceRepo = makeCommerceRepo({
      getProductByHandleImpl: async () => {
        throw new Error('boom: product fetch failed');
      },
    });
    const tree = await hydrateBindings(
      productDetailNode(),
      { handle: 'classic-tee' },
      { cmsRepo: makeCmsRepo(), commerceRepo },
    );
    expect(tree.children).toEqual([]);
    expect(nodeTextContent(tree)).toBe('');
  });

  it('renders a configuration note when ProductDetail has no handle in scope', async () => {
    const commerceRepo = detailRepo();
    const tree = await hydrateBindings(productDetailNode(), {}, {
      cmsRepo: makeCmsRepo(),
      commerceRepo,
    });
    expect(nodeTextContent(tree)).toBe('Product detail: no product selected');
    expect(commerceRepo.calls.getProductByHandle).toEqual([]);
  });

  it('leaves the four INTERACTIVE commerce kinds VERBATIM as runtime islands (NOT baked)', async () => {
    const commerceRepo = detailRepo();
    // A root containing each interactive kind, all with bindings + children that
    // would resolve IF baked. They must be returned untouched.
    const interactiveChild = (id: string, kind: string): ComponentNode => ({
      id,
      type: 'div',
      props: { 'data-component-kind': kind },
      // A read binding + a child that references a scope value: if the hydrator
      // (wrongly) baked these, the binding/children shape would change.
      bindings: { products: { mode: 'read', expression: 'products' } },
      children: [
        {
          id: `${id}-label`,
          type: 'span',
          props: {},
          bindings: { children: { mode: 'read', expression: '{{product.title}}' } },
        },
      ],
    });
    const kinds = ['variant-selector', 'add-to-cart', 'cart-view', 'checkout-button'];
    const root: ComponentNode = {
      id: 'root',
      type: 'div',
      props: {},
      children: kinds.map((k) => interactiveChild(`node-${k}`, k)),
    };
    const input = JSON.parse(JSON.stringify(root)) as ComponentNode;

    const tree = await hydrateBindings(root, { handle: 'classic-tee' }, {
      cmsRepo: makeCmsRepo(),
      commerceRepo,
    });

    // Every interactive node is left BYTE-for-BYTE identical to its input: the
    // binding is preserved (not resolved away) and the child is NOT expanded.
    for (const k of kinds) {
      const out = findById(tree, `node-${k}`);
      const original = findById(input, `node-${k}`);
      expect(out).toEqual(original);
    }
    // None of them triggered a commerce read (no bake happened).
    expect(commerceRepo.calls.listProducts).toEqual([]);
    expect(commerceRepo.calls.getProductByHandle).toEqual([]);
  });

  it('renders the unbound dashed-box placeholder when a commerce source is unbound', async () => {
    const commerceRepo = detailRepo();
    const unbound: ComponentNode = {
      id: 'list',
      type: 'div',
      props: { 'data-component-kind': 'product-list' },
      // no bindings
      children: [],
    };
    const tree = await hydrateBindings(unbound, {}, {
      cmsRepo: makeCmsRepo(),
      commerceRepo,
    });
    expect(nodeTextContent(tree)).toBe('Product list (no binding)');
    expect(commerceRepo.calls.listProducts).toEqual([]);
  });

  it('renders the unbound placeholder when no commerceRepo is supplied (CMS-only caller)', async () => {
    // The additive options object keeps a CMS-only caller working: a commerce
    // node reached without a commerceRepo resolves to the placeholder, never a throw.
    const tree = await hydrateBindings(productListNode(), {}, { cmsRepo: makeCmsRepo() });
    expect(nodeTextContent(tree)).toBe('Product list (no binding)');
  });

  it('never mutates its input tree (pure expansion)', async () => {
    const commerceRepo = makeCommerceRepo({ products: PRODUCTS });
    const input = productListNode();
    const before = JSON.stringify(input);
    await hydrateBindings(input, {}, { cmsRepo: makeCmsRepo(), commerceRepo });
    expect(JSON.stringify(input)).toBe(before);
  });
});
