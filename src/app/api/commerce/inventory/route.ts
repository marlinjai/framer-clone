// src/app/api/commerce/inventory/route.ts
//
// GET /api/commerce/inventory?variantId=&locationId= -> AvailabilityDTO (advisory)
//
// The b7 commerce inventory availability read. UNAUTHENTICATED for the v1 cut.
// Runs through the b1 `withTenant` seam and reads the b2 GENERATED column
// `inventory_level.available_quantity` (= stocked_quantity - reserved_quantity)
// for the (item, location) pair, then returns it as the advisory-only DTO.
//
// ADVISORY-ONLY (cross-check doc section 4.4; b7 spec): the returned
// `availableQuantity` is fire-and-forget freshness. It is NOT a reservation and NOT
// permission to complete a sale: it can be stale the instant it is read. The b3
// guarded conditional reserve is the SOLE authority on whether stock can be taken
// and rejects at reserve time against the live, write-locked row regardless of any
// number returned here. The `advisoryOnly: true` literal in the payload makes that
// contract explicit so no client path can treat this read as a sale guarantee.
//
// v1 item/variant identity: there is no separate variant -> inventory_item mapping
// table in this build, so the storefront's `variantId` IS the inventory_item_id at
// this boundary (a 1:1 identity for v1). E7/E8 may introduce a mapping; only this
// lookup key changes if so.
//
// available_quantity is a GENERATED ALWAYS STORED column, intentionally ABSENT from
// the Prisma model (Prisma cannot express generated columns), so it is read via raw
// SQL, schema-qualified to the commerce schema (the same access pattern b3 uses).
//
// Errors surface, never swallowed: a missing query param is a `bad_request` 400, an
// (item, location) pair with no level row is a `not_found` 404 (the pairing is
// genuinely unknown, never fabricated as 0), and a read failure is a 500 envelope.

import { Prisma } from '@prisma/client';

import { getPrismaClient } from '@/server/db';
import { withTenant, COMMERCE_SCHEMA } from '@/server/commerce';
import { jsonError } from '@/lib/api/respond';
import { availabilityDTOSchema, toAvailabilityDTO } from '@/lib/commerce/dto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Schema-qualified table reference. COMMERCE_SCHEMA is a constant, allowlisted
// identifier (single-tenant v1); every VALUE below is bound as a parameter.
const LEVEL_TABLE = Prisma.raw(`"${COMMERCE_SCHEMA}"."inventory_level"`);

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const variantId = url.searchParams.get('variantId');
  const locationId = url.searchParams.get('locationId');

  if (!variantId || !locationId) {
    return jsonError(
      'bad_request',
      'variantId and locationId query params are both required',
      400,
    );
  }

  try {
    const prisma = getPrismaClient();
    const availableQuantity = await withTenant(prisma, async (tx): Promise<number | null> => {
      const rows = await tx.$queryRaw<Array<{ available_quantity: number }>>(
        Prisma.sql`
          SELECT "available_quantity"
            FROM ${LEVEL_TABLE}
           WHERE "inventory_item_id" = ${variantId}
             AND "location_id" = ${locationId}
        `,
      );
      if (rows.length === 0) return null;
      return Number(rows[0].available_quantity);
    });

    if (availableQuantity === null) {
      return jsonError(
        'not_found',
        `no inventory level for variant ${variantId} at location ${locationId}`,
        404,
      );
    }

    const dto = toAvailabilityDTO({ variantId, locationId, availableQuantity });
    return Response.json(availabilityDTOSchema.parse(dto));
  } catch (err) {
    return jsonError(
      'commerce_read_failed',
      err instanceof Error ? err.message : 'failed to read availability',
      500,
    );
  }
}
