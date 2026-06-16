// src/app/api/commerce/products/route.ts
//
// GET /api/commerce/products -> { products: ProductDTO[]; nextCursor?: string }
//
// The b7 commerce catalog LIST read. UNAUTHENTICATED for the v1 cut (reads are
// public, mirroring the /api/cms GET routes). Runs server-side through the b1
// `withTenant` seam so the commerce search_path is pinned before any query, reads
// the owned typed commerce graph (b4 catalog) over the tx, resolves each variant's
// price via the b5 resolver (integer cents), maps to the typed ProductDTO, and
// validates the response with zod before returning it.
//
// This is a parallel commerce read surface: the typed product/option/variant graph
// is NOT forced through the flat CMS Collection/Row shape.
//
// Errors surface, never swallowed: a read failure or a response that fails its own
// zod schema is returned as a real `commerce_read_failed` envelope, and a malformed
// `limit` is a `bad_request` 400, never a silent success.

import { getPrismaClient } from '@/server/db';
import { withTenant } from '@/server/commerce';
import { pricingRepository } from '@/server/commerce/repository/pricing';
import { jsonError } from '@/lib/api/respond';
import {
  DEFAULT_CURRENCY,
  productGraphInclude,
  productListResponseSchema,
  toProductDTO,
  type ProductDTO,
} from '@/lib/commerce/dto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const currency = (url.searchParams.get('currency') ?? DEFAULT_CURRENCY).toUpperCase();
  const cursor = url.searchParams.get('cursor') ?? undefined;

  // Parse and bound the page size. A non-integer / out-of-range limit is a client
  // error surfaced as a 400, not silently clamped to a default.
  const limitParam = url.searchParams.get('limit');
  let limit = DEFAULT_PAGE_SIZE;
  if (limitParam != null) {
    const parsed = Number(limitParam);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_PAGE_SIZE) {
      return jsonError(
        'bad_request',
        `limit must be an integer in [1, ${MAX_PAGE_SIZE}], got ${limitParam}`,
        400,
      );
    }
    limit = parsed;
  }

  try {
    const prisma = getPrismaClient();
    const result = await withTenant(prisma, async (tx) => {
      // Take limit + 1 so we can tell whether another page exists without a second
      // count query; the extra row (if any) becomes the nextCursor and is dropped.
      const rows = await tx.product.findMany({
        where: { deletedAt: null },
        include: productGraphInclude,
        orderBy: { id: 'asc' },
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;

      const products: ProductDTO[] = [];
      for (const row of page) {
        const priceByVariant = new Map<string, number | null>();
        for (const variant of row.variants) {
          priceByVariant.set(
            variant.id,
            await pricingRepository.resolvePrice(tx, variant.id, { currency }),
          );
        }
        products.push(toProductDTO(row, priceByVariant));
      }

      const nextCursor = hasMore ? page[page.length - 1]?.id : undefined;
      return { products, nextCursor };
    });

    // Validate the outgoing shape: a response that does not satisfy the DTO schema
    // is a server bug, surfaced as a 500 rather than shipped malformed.
    const validated = productListResponseSchema.parse(result);
    return Response.json(validated);
  } catch (err) {
    return jsonError(
      'commerce_read_failed',
      err instanceof Error ? err.message : 'failed to list products',
      500,
    );
  }
}
