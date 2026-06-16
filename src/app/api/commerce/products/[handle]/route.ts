// src/app/api/commerce/products/[handle]/route.ts
//
// GET /api/commerce/products/[handle] -> ProductDTO | 404
//
// The b7 commerce catalog DETAIL read, resolved by `handle`. UNAUTHENTICATED for
// the v1 cut. Runs through the b1 `withTenant` seam, reads the owned typed commerce
// graph (b4) over the tx, resolves each variant's price via the b5 resolver, maps
// to the typed ProductDTO, and validates with zod. A handle that resolves to no
// LIVE product returns a real `not_found` 404 envelope, never an empty 200.
//
// handle is unique only among LIVE rows (a partial-unique index in the b4
// migration, which Prisma cannot express), so the lookup is a findFirst over
// `{ handle, deletedAt: null }`, not a findUnique.

import { getPrismaClient } from '@/server/db';
import { withTenant } from '@/server/commerce';
import { pricingRepository } from '@/server/commerce/repository/pricing';
import { jsonError } from '@/lib/api/respond';
import {
  DEFAULT_CURRENCY,
  productDTOSchema,
  productGraphInclude,
  toProductDTO,
  type ProductDTO,
} from '@/lib/commerce/dto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ handle: string }> },
): Promise<Response> {
  const { handle } = await params;
  const url = new URL(req.url);
  const currency = (url.searchParams.get('currency') ?? DEFAULT_CURRENCY).toUpperCase();

  try {
    const prisma = getPrismaClient();
    const dto = await withTenant(prisma, async (tx): Promise<ProductDTO | null> => {
      const row = await tx.product.findFirst({
        where: { handle, deletedAt: null },
        include: productGraphInclude,
      });
      if (!row) return null;

      const priceByVariant = new Map<string, number | null>();
      for (const variant of row.variants) {
        priceByVariant.set(
          variant.id,
          await pricingRepository.resolvePrice(tx, variant.id, { currency }),
        );
      }
      return toProductDTO(row, priceByVariant);
    });

    if (!dto) {
      return jsonError('not_found', `no product with handle ${handle}`, 404);
    }

    return Response.json(productDTOSchema.parse(dto));
  } catch (err) {
    return jsonError(
      'commerce_read_failed',
      err instanceof Error ? err.message : 'failed to read product',
      500,
    );
  }
}
