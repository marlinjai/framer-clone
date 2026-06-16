import 'server-only';

// src/server/commerce/repository/pricing.ts
//
// The b5 PricingRepository implementation over the passed transaction client.
// This is the read/write surface for the owned pricing graph (price_set / price /
// price_rule / price_list). It is React-free and Node-evaluable: it imports only
// Prisma types, takes a `tx` first on every method (the b1 tx-first rule), and
// never opens its own transaction or touches a bare PrismaClient. A caller (a
// mutation route, a realtime consumer) opens a `withTenant` block and hands the
// tx in. resolvePrice in particular is a PURE READ over tx, so it runs under the
// node vitest project with no React in scope.
//
// MONEY IS INTEGER CENTS, ALWAYS. price.amount is an Int (integer minor units) in
// the database, so a fractional amount cannot be stored. resolvePrice returns the
// stored Int unchanged: it compares amounts and picks one, it never divides,
// multiplies, or otherwise produces a float. Money never flows through Yjs.
//
// b5 owns ONLY the pricing graph, the catalog-side tax_class (a column on
// Product/ProductVariant, read directly off those rows, NOT resolved here: the
// bought tax-engine resolution is E8), and the CreditNote entity. There is NO
// Order surface here.
//
// Errors surface: a constraint violation (a price on a non-existent price_set, a
// duplicate variant price_set) propagates to the caller, whose transaction rolls
// back. Nothing is caught-and-ignored.

import type {
  PricingRepository,
  AddPriceInput,
  CreatePriceSetInput,
  ResolvePriceOptions,
} from './types';
import type { Price, PriceSet, Prisma } from '@prisma/client';

// A price row joined with its (optional) price_list, the shape resolvePrice reads.
type PriceWithList = Prisma.PriceGetPayload<{ include: { priceList: true } }>;

/**
 * Guard: a monetary amount must be a NON-NEGATIVE integer number of minor units
 * (cents). Two failure modes are rejected loudly at the boundary rather than
 * silently persisted:
 *   - a float (e.g. 19.99 euros instead of 1999 cents) is a programming error and
 *     a rounding-bug source;
 *   - a negative amount (e.g. -1999) is money-losing: resolvePrice picks the
 *     lowest applicable amount, so a stray negative price would always "win" and
 *     undercut every real price.
 * The DB column is Int with a `>= 0` CHECK (the mirror of this guard, see the b5
 * migration), but Prisma would coerce a float before the insert and the negative
 * would only trip at the database; this surfaces both mistakes at the boundary.
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

export const pricingRepository: PricingRepository = {
  createPriceSet(tx: Prisma.TransactionClient, input: CreatePriceSetInput): Promise<PriceSet> {
    return tx.priceSet.create({
      data: { variantId: input.variantId ?? null },
    });
  },

  addPrice(tx: Prisma.TransactionClient, input: AddPriceInput): Promise<Price> {
    assertIntegerCents(input.amount, 'amount');
    if (input.minQuantity != null) assertIntegerCents(input.minQuantity, 'minQuantity');
    if (input.maxQuantity != null) assertIntegerCents(input.maxQuantity, 'maxQuantity');

    return tx.price.create({
      data: {
        priceSetId: input.priceSetId,
        priceListId: input.priceListId ?? null,
        currencyCode: input.currency,
        amount: input.amount,
        minQuantity: input.minQuantity ?? null,
        maxQuantity: input.maxQuantity ?? null,
      },
    });
  },

  /**
   * resolvePrice contract (b5 scope, B5-PRICE-02).
   *
   * Resolution in b5 is exactly three steps, in this order: (1) a quantity-band
   * filter (a price applies only when quantity is within [min_quantity,
   * max_quantity], NULL = unbounded on that side); (2) an active-list-window
   * filter (a price_list price applies only when its list was requested in
   * priceListIds, is `active`, and `now` is inside its optional [starts_at,
   * ends_at] window; the base price, with no list, always passes); (3) a
   * lowest-amount tie-break (a price-list price wins over the base price, and
   * within the winning tier the LOWEST integer amount wins, which is the
   * sale-undercuts-base semantics). The returned value is the stored Int (cents)
   * unchanged: no float math is performed anywhere on the path.
   *
   * What b5 DELIBERATELY does NOT evaluate, and which lands in b7: price_rule
   * (attribute / value / operator / priority) is stored but NOT applied here, and
   * PriceListType (`override` vs `sale`) does NOT change which row wins (b5 prefers
   * any list price over base and then takes the lowest amount, regardless of type
   * or rule priority). When b7 adds priority-based or type-based precedence, the
   * "lowest-wins" tie-break below will change; that current behavior is pinned by
   * a unit test (the sale-1500 + override-1800 -> 1500 case in pricing.test.ts) so
   * a future precedence change is a VISIBLE diff in that assertion, not a silent
   * behavior shift.
   */
  async resolvePrice(
    tx: Prisma.TransactionClient,
    variantId: string,
    options: ResolvePriceOptions,
  ): Promise<number | null> {
    const quantity = options.quantity ?? 1;
    const now = options.now ?? new Date();
    const priceListIds = options.priceListIds ?? [];

    // variant -> price_set -> price. No price_set for the variant means no price.
    const priceSet = await tx.priceSet.findUnique({ where: { variantId } });
    if (!priceSet) return null;

    const prices: PriceWithList[] = await tx.price.findMany({
      where: { priceSetId: priceSet.id, currencyCode: options.currency },
      include: { priceList: true },
    });

    // A price is applicable when it matches the quantity band AND is either the
    // base price (no list) or a price-list price whose list was requested, is
    // active, and is inside its optional date window.
    const applicable = prices.filter((price) => {
      if (price.minQuantity != null && quantity < price.minQuantity) return false;
      if (price.maxQuantity != null && quantity > price.maxQuantity) return false;

      if (price.priceListId == null) return true; // base price

      if (!priceListIds.includes(price.priceListId)) return false;
      const list = price.priceList;
      if (!list || list.status !== 'active') return false;
      if (list.startsAt != null && list.startsAt.getTime() > now.getTime()) return false;
      if (list.endsAt != null && list.endsAt.getTime() < now.getTime()) return false;
      return true;
    });

    if (applicable.length === 0) return null;

    // A price-list price wins over the base price; among one tier the lowest
    // amount wins (sale semantics). This is integer comparison only: the returned
    // value is a stored Int (cents), never a computed float.
    const listPrices = applicable.filter((price) => price.priceListId != null);
    const tier = listPrices.length > 0 ? listPrices : applicable;

    let best = tier[0].amount;
    for (const price of tier) {
      if (price.amount < best) best = price.amount;
    }
    return best;
  },
};
