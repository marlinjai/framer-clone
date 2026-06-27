import 'server-only';

// src/server/commerce/repository/order.ts
//
// The b6 OrderRepository implementation over the passed transaction client. This
// is the data-access seam for the owned order entity (order + order_line_item).
// It is React-free and Node-evaluable: it imports only Prisma types, takes a `tx`
// first on every method (the b1 tx-first rule), and never opens its own
// transaction or touches a bare PrismaClient.
//
// This repository deliberately does NO money math and NO stock reservation: the
// atomic cart -> order orchestration (price resolution via b5, tax computation,
// per-line reservation via b3, atomic rollback) lives in
// src/server/commerce/order/createOrder.ts, which calls these primitives inside
// the ONE transaction it owns. Keeping the seam this thin means the order WRITE
// logic is all in one place and the repository stays trivially correct.
//
// Errors surface: a UNIQUE(request_id)/UNIQUE(order_number) violation, an FK
// violation, or a CHECK violation (e.g. a negative total tripping the b6 money
// floor) propagates to the caller, whose transaction rolls back. Nothing is
// caught-and-ignored here.

import type {
  CreateOrderLineItemInput,
  CreateOrderRowInput,
  OrderRepository,
} from './types';
import type { Order, OrderLineItem, Prisma } from '@prisma/client';

import { COMMERCE_SCHEMA } from '../withTenant';

// CM-09 EXPAND imports — the NEW Kysely order repository lives ALONGSIDE the
// Prisma `orderRepository` below (parallel-change / expand-contract).
import { randomUUID } from 'node:crypto';
import { sql, type Insertable, type Kysely, type Selectable } from 'kysely';
import { tenantSchema } from '@marlinjai/tenant-db';
import type { CommerceDB, OrderLineItemTable, OrderTable } from '../db-types';

// The order_number sequence created by the b6 migration. The schema identifier is
// the allowlisted constant; nextval reads it (no values are interpolated).
const ORDER_NUMBER_SEQ = `"${COMMERCE_SCHEMA}"."order_number_seq"`;

/** Zero-pad an order number to a stable width for human-readable invoice ids. */
function formatOrderNumber(n: number): string {
  return `ORD-${String(n).padStart(6, '0')}`;
}

export const orderRepository: OrderRepository = {
  async nextOrderNumber(tx: Prisma.TransactionClient): Promise<string> {
    // nextval is monotonic and concurrency-safe: two concurrent createOrder calls
    // can never draw the same number (a COUNT-based scheme would race). Postgres
    // returns int8 (bigint); the value is small in v1, so Number() is exact.
    const rows = await tx.$queryRawUnsafe<Array<{ nextval: bigint }>>(
      `SELECT nextval('${ORDER_NUMBER_SEQ}') AS nextval`,
    );
    return formatOrderNumber(Number(rows[0].nextval));
  },

  insertOrder(tx: Prisma.TransactionClient, input: CreateOrderRowInput): Promise<Order> {
    return tx.order.create({
      data: {
        orderNumber: input.orderNumber,
        requestId: input.requestId,
        ...(input.status ? { status: input.status } : {}),
        currencyCode: input.currency,
        taxRegion: input.taxRegion,
        vatId: input.vatId ?? null,
        customerType: input.customerType,
        reverseCharge: input.reverseCharge,
        netOrGross: input.netOrGross,
        kleinunternehmer: input.kleinunternehmer,
        taxNote: input.taxNote ?? null,
        subtotal: input.subtotal,
        taxAmount: input.taxAmount,
        total: input.total,
      },
    });
  },

  insertLineItem(
    tx: Prisma.TransactionClient,
    input: CreateOrderLineItemInput,
  ): Promise<OrderLineItem> {
    return tx.orderLineItem.create({
      data: {
        orderId: input.orderId,
        variantTitle: input.variantTitle ?? null,
        variantSku: input.variantSku ?? null,
        unitPrice: input.unitPrice,
        quantity: input.quantity,
        subtotal: input.subtotal,
        taxClass: input.taxClass ?? null,
        taxRate: input.taxRate,
        taxAmount: input.taxAmount,
        taxTreatment: input.taxTreatment,
        variantRef: input.variantRef ?? null,
        variantRefSource: input.variantRefSource,
      },
    });
  },

  findByRequestId(
    tx: Prisma.TransactionClient,
    requestId: string,
  ): Promise<Order | null> {
    return tx.order.findUnique({ where: { requestId } });
  },
};

// =============================================================================
// CM-09 EXPAND — the NEW Kysely order repository, ADDED ALONGSIDE the Prisma
// `orderRepository` above (parallel-change / expand-contract). Everything below
// is ADDITIVE: the old `orderRepository` AND the `OrderRepository` interface in
// ./types.ts are untouched, so createOrder.ts (old path) and the orders route
// keep compiling and the verify gate (whole-program tsc + next build) stays
// green. This Kysely repo is "dark" until CM-09's createOrderKysely wires it in;
// CM-13 then deletes the Prisma path and renames these to canonical.
//
// Each method takes the per-request scoped `db: Kysely<CommerceDB>` first — its
// bare table identifiers already resolve to `tg_<id>.<table>`. `nextOrderNumber`
// additionally takes `tgId`: the per-tenant `order_number_seq` (CM-04 005) is
// read in a raw `sql\`\`` fragment, and a raw fragment must schema-qualify
// explicitly (`withSchema` rewrites only STRUCTURED identifiers, never raw text).
//
// This repo does NO money math and NO stock reservation, exactly like the Prisma
// seam: the atomic cart -> order orchestration lives in `createOrderKysely`.
//
// id is SUPPLIED by app code: the CM-04 DDL declares it NOT NULL with no DB
// default (CM-05 types it as required), so we mint a uuid; `order.updated_at` is
// NOT NULL with no default, so it is stamped (order_line_item has no updated_at).
// =============================================================================

/** RETURNING projections returned by the Kysely order repo (CommerceDB rows). */
export type OrderRow = Selectable<OrderTable>;
export type OrderLineItemRow = Selectable<OrderLineItemTable>;

/**
 * The Kysely mirror of {@link OrderRepository}, generic over the scoped
 * `Kysely<CommerceDB>` handle. Co-located here (NOT in `repository/types.ts`) so
 * this spec never touches the file the old `OrderRepository` interface lives in.
 * Returns `CommerceDB`-derived row types, never `@prisma/client` row types.
 */
export interface OrderRepositoryKysely {
  /** Allocate the next monotonic order number within the tenant's schema. */
  nextOrderNumber(db: Kysely<CommerceDB>, tgId: string): Promise<string>;

  /** Insert the order row (all monetary fields server-computed by the caller). */
  insertOrder(db: Kysely<CommerceDB>, input: CreateOrderRowInput): Promise<OrderRow>;

  /** Insert one snapshot line item belonging to an order. */
  insertLineItem(
    db: Kysely<CommerceDB>,
    input: CreateOrderLineItemInput,
  ): Promise<OrderLineItemRow>;

  /** Re-read an order by its request_id (the idempotency key), or undefined. */
  findByRequestId(db: Kysely<CommerceDB>, requestId: string): Promise<OrderRow | undefined>;
}

export const orderRepositoryKysely: OrderRepositoryKysely = {
  async nextOrderNumber(db: Kysely<CommerceDB>, tgId: string): Promise<string> {
    // The per-tenant `order_number_seq` (CM-04 005) lives in the tenant schema.
    // A raw fragment must schema-qualify it: `withSchema` rewrites only STRUCTURED
    // identifiers, never raw text, and `commerce_app`'s search_path is `ext` only,
    // so an unqualified `nextval('order_number_seq')` would not resolve.
    //
    // NOTE (deliberate deviation from the spec's literal form): `nextval()` takes
    // a regclass/text ARGUMENT — a value expression, NOT a table reference — so
    // the schema cannot be interpolated as a bare/quoted identifier the way a
    // FROM-clause table is. `nextval(${tenantSchemaRef(tgId)} || '.order_number_seq')`
    // would render `nextval("tg_x" || '.order_number_seq')`, where `"tg_x"` parses
    // as a column reference and the statement fails. Instead the fully-qualified
    // sequence NAME is bound as a parameter — built from `tenantSchema(tgId)`,
    // which is derived from the validated UUID and so is injection-safe — and cast
    // to `::regclass`. This keeps the read schema-qualified (no search_path
    // fallback, no cross-tenant leak) with no bare `order_number_seq` token in the
    // `sql\`\`` text, exactly as the constraint intends.
    const seqRef = `${tenantSchema(tgId)}.order_number_seq`;
    const result = await sql<{ nextval: string | number | bigint }>`
      SELECT nextval(${seqRef}::regclass) AS nextval
    `.execute(db);
    return formatOrderNumber(Number(result.rows[0].nextval));
  },

  insertOrder(db: Kysely<CommerceDB>, input: CreateOrderRowInput): Promise<OrderRow> {
    const values: Insertable<OrderTable> = {
      id: randomUUID(),
      order_number: input.orderNumber,
      request_id: input.requestId,
      status: input.status,
      currency_code: input.currency,
      tax_region: input.taxRegion,
      vat_id: input.vatId ?? null,
      customer_type: input.customerType,
      reverse_charge: input.reverseCharge,
      net_or_gross: input.netOrGross,
      kleinunternehmer: input.kleinunternehmer,
      tax_note: input.taxNote ?? null,
      subtotal: input.subtotal,
      tax_amount: input.taxAmount,
      total: input.total,
      updated_at: new Date(),
    };
    return db.insertInto('order').values(values).returningAll().executeTakeFirstOrThrow();
  },

  insertLineItem(
    db: Kysely<CommerceDB>,
    input: CreateOrderLineItemInput,
  ): Promise<OrderLineItemRow> {
    const values: Insertable<OrderLineItemTable> = {
      id: randomUUID(),
      order_id: input.orderId,
      variant_title: input.variantTitle ?? null,
      variant_sku: input.variantSku ?? null,
      unit_price: input.unitPrice,
      quantity: input.quantity,
      subtotal: input.subtotal,
      tax_class: input.taxClass ?? null,
      tax_rate: input.taxRate,
      tax_amount: input.taxAmount,
      tax_treatment: input.taxTreatment,
      variant_ref: input.variantRef ?? null,
      variant_ref_source: input.variantRefSource,
    };
    return db
      .insertInto('order_line_item')
      .values(values)
      .returningAll()
      .executeTakeFirstOrThrow();
  },

  findByRequestId(db: Kysely<CommerceDB>, requestId: string): Promise<OrderRow | undefined> {
    return db
      .selectFrom('order')
      .selectAll()
      .where('request_id', '=', requestId)
      .executeTakeFirst();
  },
};
