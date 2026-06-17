// HttpCommerceDataSource: the live CommerceDataSource. It satisfies the same
// read-only seam (src/lib/commerce/provider.ts) the InMemoryCommerceDataSource
// double satisfies, but instead of holding a fixture in process it reaches the
// server over the Track B (b7) /api/commerce/* READ routes. Storefront
// components never import this concrete class; it is mounted once at the root,
// so the implementation is swappable behind useCommerceDataSource().
//
// MAPPING BOUNDARY. The b7 routes return their OWN read DTOs (src/lib/commerce/
// dto.ts: a product graph with options + variants + resolved price embedded).
// This provider maps those b7 DTOs onto the seam DTOs (src/lib/commerce/types.ts)
// and never lets a b7 row shape (or a Prisma error) leak past a method return.
// Every b7 response is validated with the b7 zod schemas before it is mapped, so
// a malformed upstream payload becomes a well-formed CommerceHttpError the caller
// can see, never a silent null or a swallowed exception that reads as success.
//
// WHY THE SEAM IS BACKED BY ONLY THREE b7 ROUTES. b7 exposes products (list),
// products/[handle] (detail), inventory (availability). Its product payload
// already EMBEDS each product's variants and each variant's resolved price, so
// the seam's listVariants / getVariant / getPrices are DERIVED from the embedded
// graph: no dedicated variants/prices route is needed. The by-id reads
// (getProduct / listVariants / getVariant / getPrices) have no by-id b7 route, so
// they page the list and resolve client-side (fine for the v1 catalog size).
//
// ONE GENUINE GAP, REQUESTED ADDITIVELY (NOT BUILT HERE). The seam's
// getAvailability(variantId) with NO location must aggregate across every
// location (locationId = ALL_LOCATIONS). b7's inventory route requires a
// locationId and returns a single level, so it cannot aggregate. That aggregate
// mode is REQUESTED as an additive b7 PR (GET /api/commerce/inventory?variantId=
// with no locationId -> an advisory AvailabilityDTO whose locationId is "all").
// Track B owns the route files; this storefront spec adds no route. Until b7
// ships it, the no-location read surfaces b7's 400 as a well-formed error rather
// than fabricating a number.
//
// ADVISORY-ONLY HARD LINE. getAvailability validates that the b7 response asserts
// `advisoryOnly: true` (availabilityDTOSchema) before mapping it to the seam
// AvailabilityDTO. The returned availableQuantity is information only and is
// NEVER permission to complete a sale: the b3 guarded conditional reserve is the
// sole authority on whether stock can be taken. `stale` is false because each
// read is a fresh network fetch (this provider does not cache reads).
//
// subscribe() is POLLING (default 5s): it re-invokes onChange on a fixed cadence
// to signal that data may have changed; the consumer re-reads through the read
// methods. Real-time push is out of scope. This file is React-free and
// Node-evaluable.

import type { CommerceDataSource } from './provider';
import {
  ALL_LOCATIONS,
  type AvailabilityDTO,
  type CommerceFilterClause,
  type CommerceQuery,
  type PriceDTO,
  type ProductDTO,
  type ProductOptionDTO,
  type ProductPage,
  type ProductVariantDTO,
  type VariantOptionCoordinate,
} from './types';
import {
  DEFAULT_CURRENCY,
  availabilityDTOSchema,
  productDTOSchema,
  productListResponseSchema,
  type ProductDTO as B7ProductDTO,
  type ProductVariantDTO as B7VariantDTO,
} from './dto';

/**
 * A well-formed error surfaced by the provider. Carries the upstream `code`
 * (the b7 error envelope code, or an `invalid_response` marker when a b7 payload
 * fails its own schema) and the HTTP `status`, so a caller can branch on the
 * failure instead of pattern-matching a bare message string. The provider NEVER
 * throws a raw Prisma error or a bare fetch rejection past this boundary.
 */
export class CommerceHttpError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, opts: { code: string; status: number }) {
    super(message);
    this.name = 'CommerceHttpError';
    this.code = opts.code;
    this.status = opts.status;
  }
}

/** The b7 error envelope is `{ error: { code, message, ...extra } }`. */
interface B7ErrorEnvelope {
  error?: { code?: string; message?: string };
}

/**
 * Read the b7 error envelope off a non-OK response, falling back to the status
 * line when the body is not the expected JSON shape. Never throws.
 */
async function describeFailure(
  res: Response,
): Promise<{ code: string; message: string }> {
  try {
    const body = (await res.json()) as B7ErrorEnvelope;
    if (body?.error?.message) {
      return {
        code: body.error.code ?? 'commerce_read_failed',
        message: body.error.message,
      };
    }
  } catch {
    // Non-JSON or empty body: fall through to the status line.
  }
  return {
    code: 'commerce_read_failed',
    message: `${res.status} ${res.statusText}`.trim(),
  };
}

// ---------------------------------------------------------------------------
// Pure mappers: b7 read DTO -> seam DTO. No I/O. Variants and prices are mapped
// within the owning product's context so option-value labels and the productId
// can be resolved (the b7 variant shape carries only ids, not labels).
// ---------------------------------------------------------------------------

/** Build an optionValueId -> human label map from a b7 product's option graph. */
function buildValueLabelMap(b7: B7ProductDTO): Map<string, string> {
  const labels = new Map<string, string>();
  for (const option of b7.options) {
    for (const value of option.values) {
      labels.set(value.id, value.value);
    }
  }
  return labels;
}

function mapB7Variant(
  b7Product: B7ProductDTO,
  b7Variant: B7VariantDTO,
  labels: Map<string, string>,
): ProductVariantDTO {
  const optionValues: VariantOptionCoordinate[] = b7Variant.options.map(
    (assignment) => ({
      optionId: assignment.optionId,
      valueId: assignment.optionValueId,
      label: labels.get(assignment.optionValueId) ?? '',
    }),
  );
  return {
    id: b7Variant.id,
    productId: b7Product.id,
    title: b7Variant.title,
    // b7 carries sku/barcode as nullable; the seam carries them as optional, so
    // a null upstream value is omitted rather than surfaced as `null`.
    ...(b7Variant.sku !== null ? { sku: b7Variant.sku } : {}),
    ...(b7Variant.barcode !== null ? { barcode: b7Variant.barcode } : {}),
    optionValues,
    // taxClass is intentionally absent: b7's read DTO does not carry it.
  };
}

function mapB7Product(b7: B7ProductDTO): ProductDTO {
  const options: ProductOptionDTO[] = b7.options.map((option) => ({
    id: option.id,
    productId: b7.id,
    title: option.title,
    values: option.values.map((value) => ({
      id: value.id,
      optionId: option.id,
      label: value.value,
    })),
  }));
  return {
    id: b7.id,
    handle: b7.handle,
    title: b7.title,
    description: b7.description,
    options,
    variantIds: b7.variants.map((variant) => variant.id),
    // taxClass is intentionally absent: b7's read DTO does not carry it.
  };
}

function applyProductFilter(
  rows: ProductDTO[],
  clause: CommerceFilterClause,
): ProductDTO[] {
  const needle = clause.value.toLowerCase();
  return rows.filter((row) => {
    const haystack = (
      clause.field === 'handle' ? row.handle : row.title
    ).toLowerCase();
    switch (clause.op) {
      case 'eq':
        return haystack === needle;
      case 'ne':
        return haystack !== needle;
      case 'contains':
        return haystack.includes(needle);
      default:
        return true;
    }
  });
}

export class HttpCommerceDataSource implements CommerceDataSource {
  private readonly baseUrl: string;
  private readonly pollMs: number;
  private readonly currency: string;

  constructor(opts?: { baseUrl?: string; pollMs?: number }) {
    // Default baseUrl is '' so requests are relative (same-origin) in the
    // browser. Tests inject an absolute baseUrl against a mocked fetch.
    this.baseUrl = opts?.baseUrl ?? '';
    this.pollMs = opts?.pollMs ?? 5000;
    // b7 resolves prices in a currency given by ?currency= (default EUR) and
    // does not echo the currency back in its DTO, so the provider pins the
    // currency it requests and reports that same code on every PriceDTO.
    this.currency = DEFAULT_CURRENCY;
  }

  private _url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  /**
   * Fetch one b7 product LIST page, validating it against the b7 list schema.
   * A non-OK response or a payload that fails its own schema becomes a
   * CommerceHttpError rather than a silently-degraded result.
   */
  private async _fetchProductPage(
    cursor?: string,
  ): Promise<{ products: B7ProductDTO[]; nextCursor?: string }> {
    const params = new URLSearchParams({ currency: this.currency });
    if (cursor) params.set('cursor', cursor);
    const res = await fetch(this._url(`/api/commerce/products?${params.toString()}`));
    if (!res.ok) {
      const { code, message } = await describeFailure(res);
      throw new CommerceHttpError(`listProducts failed: ${message}`, {
        code,
        status: res.status,
      });
    }
    const parsed = productListResponseSchema.safeParse(await res.json());
    if (!parsed.success) {
      throw new CommerceHttpError(
        'listProducts failed: b7 returned a malformed product list',
        { code: 'invalid_response', status: res.status },
      );
    }
    return parsed.data;
  }

  /**
   * Page the whole b7 catalog by following nextCursor. b7 has no by-id product
   * route, so the by-id reads resolve against this set client-side. The cursor
   * must strictly advance; a repeated cursor is treated as the end of the list
   * to avoid an unbounded loop on a misbehaving upstream.
   */
  private async _fetchAllB7Products(): Promise<B7ProductDTO[]> {
    const all: B7ProductDTO[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (;;) {
      const page = await this._fetchProductPage(cursor);
      all.push(...page.products);
      if (!page.nextCursor || seenCursors.has(page.nextCursor)) break;
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    return all;
  }

  async listProducts(query?: CommerceQuery): Promise<ProductPage> {
    const b7Products = await this._fetchAllB7Products();
    let rows = b7Products.map(mapB7Product);

    for (const clause of query?.filter ?? []) {
      rows = applyProductFilter(rows, clause);
    }

    for (const sort of query?.sort ?? []) {
      const dir = sort.direction === 'desc' ? -1 : 1;
      rows.sort((a, b) => {
        const av = sort.field === 'handle' ? a.handle : a.title;
        const bv = sort.field === 'handle' ? b.handle : b.title;
        return av < bv ? -dir : av > bv ? dir : 0;
      });
    }

    // total reflects the filter but ignores the limit (a page-size cap, not a
    // match count), matching the seam contract.
    const total = rows.length;
    if (typeof query?.limit === 'number') {
      rows = rows.slice(0, Math.max(0, query.limit));
    }

    return { products: rows, total };
  }

  async getProduct(productId: string): Promise<ProductDTO | null> {
    const b7Products = await this._fetchAllB7Products();
    const hit = b7Products.find((p) => p.id === productId);
    return hit ? mapB7Product(hit) : null;
  }

  async getProductByHandle(handle: string): Promise<ProductDTO | null> {
    // b7 has a dedicated detail-by-handle route, so this read is a single fetch.
    const res = await fetch(
      this._url(
        `/api/commerce/products/${encodeURIComponent(handle)}?currency=${this.currency}`,
      ),
    );
    if (res.status === 404) {
      return null;
    }
    if (!res.ok) {
      const { code, message } = await describeFailure(res);
      throw new CommerceHttpError(`getProductByHandle failed: ${message}`, {
        code,
        status: res.status,
      });
    }
    const parsed = productDTOSchema.safeParse(await res.json());
    if (!parsed.success) {
      throw new CommerceHttpError(
        'getProductByHandle failed: b7 returned a malformed product',
        { code: 'invalid_response', status: res.status },
      );
    }
    return mapB7Product(parsed.data);
  }

  async listVariants(productId: string): Promise<ProductVariantDTO[]> {
    const b7Products = await this._fetchAllB7Products();
    const product = b7Products.find((p) => p.id === productId);
    if (!product) return [];
    const labels = buildValueLabelMap(product);
    return product.variants.map((variant) =>
      mapB7Variant(product, variant, labels),
    );
  }

  async getVariant(variantId: string): Promise<ProductVariantDTO | null> {
    const b7Products = await this._fetchAllB7Products();
    for (const product of b7Products) {
      const variant = product.variants.find((v) => v.id === variantId);
      if (variant) {
        return mapB7Variant(product, variant, buildValueLabelMap(product));
      }
    }
    return null;
  }

  async getPrices(variantId: string): Promise<PriceDTO[]> {
    const b7Products = await this._fetchAllB7Products();
    for (const product of b7Products) {
      const variant = product.variants.find((v) => v.id === variantId);
      if (!variant) continue;
      // b7 carries a single resolved price per variant (integer cents), or null
      // when no price applies. Quantity-band pricing and a per-row taxClass are
      // not in b7's read DTO, so a variant maps to at most one PriceDTO.
      if (variant.resolvedPriceCents === null) return [];
      return [
        {
          variantId: variant.id,
          amountCents: variant.resolvedPriceCents,
          currency: this.currency,
        },
      ];
    }
    // Unknown variant: no prices, mirroring the seam's empty-array contract.
    return [];
  }

  async getAvailability(
    variantId: string,
    locationId?: string,
  ): Promise<AvailabilityDTO> {
    // locationId omitted -> the seam aggregates across every location. b7's
    // inventory route cannot aggregate today, so this calls the REQUESTED
    // additive b7 aggregate mode (variantId only). Until b7 ships it, b7 returns
    // a 400 here, which surfaces as a well-formed error below (never a number).
    const params = new URLSearchParams({ variantId });
    if (locationId !== undefined) params.set('locationId', locationId);

    const res = await fetch(
      this._url(`/api/commerce/inventory?${params.toString()}`),
    );
    if (!res.ok) {
      const { code, message } = await describeFailure(res);
      throw new CommerceHttpError(`getAvailability failed: ${message}`, {
        code,
        status: res.status,
      });
    }
    // Validating against the b7 availability schema enforces the advisory-only
    // marker (advisoryOnly: true) at the boundary: a response that does not
    // assert it is rejected rather than mapped into a sale-looking number.
    const parsed = availabilityDTOSchema.safeParse(await res.json());
    if (!parsed.success) {
      throw new CommerceHttpError(
        'getAvailability failed: b7 returned a malformed availability payload',
        { code: 'invalid_response', status: res.status },
      );
    }
    const b7 = parsed.data;
    return {
      variantId: b7.variantId,
      // When aggregated (no locationId), the aggregate mode reports the "all"
      // sentinel; carry whatever b7 returns through unchanged.
      locationId: locationId === undefined ? ALL_LOCATIONS : b7.locationId,
      availableQuantity: b7.availableQuantity,
      // A fresh network read is never stale; this provider does not cache reads.
      stale: false,
    };
  }

  /**
   * Polling subscription. Re-invokes `onChange` every `pollMs` to signal that
   * data the consumer depends on may have changed; the consumer re-reads through
   * the read methods. There is no server push here. The productId scope is
   * advisory for polling (every tick fires regardless), mirroring the seam's
   * "may have changed" contract. Returns an unsubscribe that clears the timer.
   */
  subscribe(_productId: string | null, onChange: () => void): () => void {
    const handle = setInterval(() => {
      onChange();
    }, this.pollMs);
    return () => {
      clearInterval(handle);
    };
  }
}

/**
 * Lazy singleton for app-wide use, so subscription cadence and provider identity
 * stay stable across re-renders (mounting `new HttpCommerceDataSource()` inline
 * would churn subscriptions every render). Tests construct their own instance to
 * stay isolated.
 */
let sharedInstance: HttpCommerceDataSource | null = null;

export function getSharedHttpCommerceDataSource(): HttpCommerceDataSource {
  if (!sharedInstance) {
    sharedInstance = new HttpCommerceDataSource();
  }
  return sharedInstance;
}
