import 'server-only';

// src/server/commerce/repository/pricing.ts
//
// The PricingRepository: the read/write surface for the owned pricing graph
// (price_set / price / price_rule / price_list). React-free and Node-evaluable.
// Every method takes the scoped handle `db: Kysely<CommerceDB>` first
// (`commerceTenantDb(tgId)`, or a transaction opened on it), whose table
// identifiers already resolve to `tg_<id>.<table>`.
//
// MONEY IS INTEGER CENTS, ALWAYS. price.amount is an INTEGER column, so a
// fractional amount cannot be stored, and addPrice rejects one at the boundary.
// resolvePrice returns the stored Int unchanged: it compares amounts and picks
// one, it never divides, multiplies, or otherwise produces a float.
//
// The pricing graph only: the catalog-side tax_class is a column on
// product / product_variant (read directly off those rows), the bought tax
// engine is out of scope (E8), and there is NO order surface here.
//
// id / updated_at are SUPPLIED by app code: the per-tenant DDL declares them NOT
// NULL with no DB default, so we mint a uuid and stamp the time.
//
// Errors surface: a constraint violation (a price on a non-existent price_set, a
// duplicate variant price_set, a negative amount tripping the `>= 0` CHECK)
// propagates to the caller, whose transaction rolls back. Nothing is
// caught-and-ignored.

import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';

import type { CommerceDB } from '../db-types';
import type {
  AddPriceInput,
  CreatePriceSetInput,
  PricingPriceRow,
  PricingPriceSetRow,
  PricingRepository,
  ResolvePriceOptions,
} from './types';

/**
 * Guard: a monetary amount must be a NON-NEGATIVE integer number of minor units
 * (cents). Two failure modes are rejected loudly at the boundary rather than
 * silently persisted:
 *   - a float (e.g. 19.99 euros instead of 1999 cents) is a programming error and
 *     a rounding-bug source;
 *   - a negative amount (e.g. -1999) is money-losing: resolvePrice picks the
 *     lowest applicable amount, so a stray negative price would always "win" and
 *     undercut every real price.
 * The DB column is INTEGER with a `>= 0` CHECK (the mirror of this guard, see
 * migration 004_pricing_and_tax); this surfaces both mistakes before the insert.
 */
function assertIntegerCents(amount: number, field: string): void {
  if (!Number.isInteger(amount)) {
    throw new Error(
      `pricing: ${field} must be an integer number of minor units (cents), got ${amount}`,
    );
  }
  if (amount < 0) {
    throw new Error(
      `pricing: ${field} must be a non-negative number of minor units (cents), got ${amount}`,
    );
  }
}

/**
 * One candidate price as resolvePrice reads it: the price row joined with its
 * (optional) price_list's status and window. The base price has a NULL
 * price_list_id and NULL list columns.
 */
export interface PriceCandidate {
  price_list_id: string | null;
  amount: number;
  min_quantity: number | null;
  max_quantity: number | null;
  list_status: string | null;
  list_starts_at: Date | string | null;
  list_ends_at: Date | string | null;
}

/**
 * Pick the winning unit price (integer cents) among `candidates`, or null. Pure
 * and DB-free so the resolution rules are unit-pinned (pricing.test.ts).
 *
 * Resolution is exactly three steps, in this order: (1) a quantity-band filter
 * (a price applies only when quantity is within [min_quantity, max_quantity],
 * NULL = unbounded on that side); (2) an active-list-window filter (a price_list
 * price applies only when its list was requested in priceListIds, is `active`,
 * and `now` is inside its optional [starts_at, ends_at] window; the base price,
 * with no list, always passes); (3) a lowest-amount tie-break (a price-list
 * price wins over the base price, and within the winning tier the LOWEST integer
 * amount wins, which is the sale-undercuts-base semantics). The returned value
 * is the stored Int (cents) unchanged: no float math anywhere on the path.
 *
 * What is DELIBERATELY not evaluated (lands in b7): price_rule (attribute /
 * value / operator / priority) is stored but NOT applied here, and
 * PriceListType (`override` vs `sale`) does NOT change which row wins. When b7
 * adds priority- or type-based precedence, the lowest-wins tie-break below will
 * change; that current behaviour is pinned by a unit test (sale 1500 + override
 * 1800 resolves to 1500, in pricing.test.ts) so the change is a VISIBLE diff.
 */
export function selectPrice(
  candidates: readonly PriceCandidate[],
  options: { quantity?: number; now?: Date; priceListIds?: readonly string[] },
): number | null {
  const quantity = options.quantity ?? 1;
  const now = options.now ?? new Date();
  const priceListIds = options.priceListIds ?? [];

  const applicable = candidates.filter((price) => {
    if (price.min_quantity != null && quantity < price.min_quantity) return false;
    if (price.max_quantity != null && quantity > price.max_quantity) return false;

    if (price.price_list_id == null) return true; // base price

    if (!priceListIds.includes(price.price_list_id)) return false;
    if (price.list_status !== 'active') return false;
    if (price.list_starts_at != null && new Date(price.list_starts_at).getTime() > now.getTime()) {
      return false;
    }
    if (price.list_ends_at != null && new Date(price.list_ends_at).getTime() < now.getTime()) {
      return false;
    }
    return true;
  });

  if (applicable.length === 0) return null;

  // A price-list price wins over the base price; among one tier the lowest
  // amount wins (sale semantics). INTEGER comparison only.
  const listPrices = applicable.filter((price) => price.price_list_id != null);
  const tier = listPrices.length > 0 ? listPrices : applicable;

  let best = tier[0].amount;
  for (const price of tier) {
    if (price.amount < best) best = price.amount;
  }
  return best;
}

export const pricingRepository: PricingRepository = {
  createPriceSet(
    db: Kysely<CommerceDB>,
    input: CreatePriceSetInput,
  ): Promise<PricingPriceSetRow> {
    return db
      .insertInto('price_set')
      .values({
        id: randomUUID(),
        tenant_id: input.tenantId,
        variant_id: input.variantId ?? null,
        updated_at: new Date(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  },

  addPrice(db: Kysely<CommerceDB>, input: AddPriceInput): Promise<PricingPriceRow> {
    // Reject floats and negatives at the edge, before any insert (the DB `>= 0`
    // CHECK is the mirror backstop).
    assertIntegerCents(input.amount, 'amount');
    if (input.minQuantity != null) assertIntegerCents(input.minQuantity, 'minQuantity');
    if (input.maxQuantity != null) assertIntegerCents(input.maxQuantity, 'maxQuantity');

    return db
      .insertInto('price')
      .values({
        id: randomUUID(),
        tenant_id: input.tenantId,
        price_set_id: input.priceSetId,
        price_list_id: input.priceListId ?? null,
        currency_code: input.currency,
        amount: input.amount,
        min_quantity: input.minQuantity ?? null,
        max_quantity: input.maxQuantity ?? null,
        updated_at: new Date(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  },

  async resolvePrice(
    db: Kysely<CommerceDB>,
    variantId: string,
    options: ResolvePriceOptions,
  ): Promise<number | null> {
    // variant -> price_set -> price. No price_set for the variant means no price.
    const priceSet = await db
      .selectFrom('price_set')
      .select('id')
      .where('variant_id', '=', variantId)
      .executeTakeFirst();
    if (!priceSet) return null;

    // price LEFT JOIN price_list: one row per price, carrying its (optional)
    // list's status + window.
    const candidates = await db
      .selectFrom('price')
      .leftJoin('price_list', 'price_list.id', 'price.price_list_id')
      .where('price.price_set_id', '=', priceSet.id)
      .where('price.currency_code', '=', options.currency)
      .select([
        'price.price_list_id as price_list_id',
        'price.amount as amount',
        'price.min_quantity as min_quantity',
        'price.max_quantity as max_quantity',
        'price_list.status as list_status',
        'price_list.starts_at as list_starts_at',
        'price_list.ends_at as list_ends_at',
      ])
      .execute();

    return selectPrice(candidates, options);
  },
};
