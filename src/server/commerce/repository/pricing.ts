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

// CM-06 EXPAND imports — the Kysely path lives ALONGSIDE the Prisma path below.
import { randomUUID } from 'node:crypto';
import type { Kysely, Selectable } from 'kysely';
import type { CommerceDB, PriceSetTable, PriceTable } from '../db-types';

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

// =============================================================================
// CM-06 EXPAND — the Kysely pricing repository (NEW), added ALONGSIDE the Prisma
// `pricingRepository` above. Both paths COEXIST through CM-12 (plan §10): the old
// Prisma object keeps every current caller compiling and serving the demo; this
// Kysely object is "dark" until CM-10 wires it; CM-13 then deletes the Prisma
// path. This is a pure ADDITION — no existing signature changes (expand-contract).
//
// Each method takes a `db: Kysely<CommerceDB>` first — the per-request scoped
// handle whose bare table identifiers already resolve to `tg_<id>.<table>`.
//
// MONEY STAYS INTEGER CENTS. addPrice re-uses the SAME `assertIntegerCents`
// boundary guard as the Prisma path (it is not duplicated or weakened), and
// resolvePrice performs the IDENTICAL three-step resolution (quantity band ->
// active-list window -> lowest-amount tie-break) with INTEGER comparisons only:
// it returns the stored Int amount unchanged and does NO float math. The winning
// price is byte-for-byte the same row the Prisma `resolvePrice` would pick.
//
// id / updated_at are SUPPLIED by app code: the CM-04 DDL declares them NOT NULL
// with no DB default (CM-05 types them as required), so we mint a uuid and stamp
// the time, exactly as the Prisma client did implicitly.
// =============================================================================

/** RETURNING projections returned by the Kysely pricing repo. */
export type PricingPriceSetRow = Selectable<PriceSetTable>;
export type PricingPriceRow = Selectable<PriceTable>;

/**
 * The Kysely mirror of {@link PricingRepository}, generic over the scoped
 * `Kysely<CommerceDB>` handle. Co-located here (NOT in `repository/types.ts`) so
 * this spec never touches the file CM-08/CM-09 edit.
 */
export interface PricingRepositoryKysely {
  /** Create a price_set (optionally attached to a variant). */
  createPriceSet(
    db: Kysely<CommerceDB>,
    input: CreatePriceSetInput,
  ): Promise<PricingPriceSetRow>;

  /** Add a price (integer cents) to a price_set, optionally on a price_list. */
  addPrice(db: Kysely<CommerceDB>, input: AddPriceInput): Promise<PricingPriceRow>;

  /**
   * Resolve the unit price for a variant in integer minor units (cents), or null
   * when no price applies. Behavior is identical to the Prisma `resolvePrice`: a
   * price-list price (active, in-window, quantity-band-matching, named in
   * priceListIds) wins over the base price; within a tier the LOWEST integer
   * amount wins. Returns the stored Int unchanged — no float math.
   */
  resolvePrice(
    db: Kysely<CommerceDB>,
    variantId: string,
    options: ResolvePriceOptions,
  ): Promise<number | null>;
}

export const pricingRepositoryKysely: PricingRepositoryKysely = {
  createPriceSet(
    db: Kysely<CommerceDB>,
    input: CreatePriceSetInput,
  ): Promise<PricingPriceSetRow> {
    return db
      .insertInto('price_set')
      .values({
        id: randomUUID(),
        variant_id: input.variantId ?? null,
        updated_at: new Date(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  },

  addPrice(db: Kysely<CommerceDB>, input: AddPriceInput): Promise<PricingPriceRow> {
    // The SAME boundary guard as the Prisma path: reject floats and negatives at
    // the edge, before any insert (the DB `>= 0` CHECK is the mirror backstop).
    assertIntegerCents(input.amount, 'amount');
    if (input.minQuantity != null) assertIntegerCents(input.minQuantity, 'minQuantity');
    if (input.maxQuantity != null) assertIntegerCents(input.maxQuantity, 'maxQuantity');

    return db
      .insertInto('price')
      .values({
        id: randomUUID(),
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
    const quantity = options.quantity ?? 1;
    const now = options.now ?? new Date();
    const priceListIds = options.priceListIds ?? [];

    // variant -> price_set -> price. No price_set for the variant means no price.
    const priceSet = await db
      .selectFrom('price_set')
      .select('id')
      .where('variant_id', '=', variantId)
      .executeTakeFirst();
    if (!priceSet) return null;

    // price LEFT JOIN price_list: one row per price, carrying its (optional)
    // list's status + window. The base price has a NULL price_list_id (and the
    // joined list columns are NULL).
    const prices = await db
      .selectFrom('price')
      .leftJoin('price_list', 'price_list.id', 'price.price_list_id')
      .where('price.price_set_id', '=', priceSet.id)
      .where('price.currency_code', '=', options.currency)
      .select([
        'price.id as id',
        'price.price_list_id as price_list_id',
        'price.amount as amount',
        'price.min_quantity as min_quantity',
        'price.max_quantity as max_quantity',
        'price_list.status as list_status',
        'price_list.starts_at as list_starts_at',
        'price_list.ends_at as list_ends_at',
      ])
      .execute();

    // A price is applicable when it matches the quantity band AND is either the
    // base price (no list) or a price-list price whose list was requested, is
    // active, and is inside its optional date window. (Identical to Prisma path.)
    const applicable = prices.filter((price) => {
      if (price.min_quantity != null && quantity < price.min_quantity) return false;
      if (price.max_quantity != null && quantity > price.max_quantity) return false;

      if (price.price_list_id == null) return true; // base price

      if (!priceListIds.includes(price.price_list_id)) return false;
      if (price.list_status !== 'active') return false;
      if (
        price.list_starts_at != null &&
        new Date(price.list_starts_at).getTime() > now.getTime()
      ) {
        return false;
      }
      if (
        price.list_ends_at != null &&
        new Date(price.list_ends_at).getTime() < now.getTime()
      ) {
        return false;
      }
      return true;
    });

    if (applicable.length === 0) return null;

    // A price-list price wins over the base price; among one tier the lowest
    // amount wins (sale semantics). INTEGER comparison only: the returned value is
    // a stored Int (cents), never a computed float.
    const listPrices = applicable.filter((price) => price.price_list_id != null);
    const tier = listPrices.length > 0 ? listPrices : applicable;

    let best = tier[0].amount;
    for (const price of tier) {
      if (price.amount < best) best = price.amount;
    }
    return best;
  },
};
