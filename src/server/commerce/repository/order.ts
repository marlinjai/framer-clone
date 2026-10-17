import 'server-only';

// src/server/commerce/repository/order.ts
//
// The OrderRepository: the data-access seam for the owned order entity (order +
// order_line_item). React-free and Node-evaluable. Every method takes the scoped
// handle `db: Kysely<CommerceDB>` first (in practice the READ COMMITTED
// transaction createOrder opens on `commerceTenantDb(tgId)`).
//
// This repository deliberately does NO money math and NO stock reservation: the
// atomic cart -> order orchestration (price resolution, tax computation,
// per-line reservation, atomic rollback) lives in
// src/server/commerce/order/createOrder.ts, which calls these primitives inside
// the ONE transaction it owns.
//
// Errors surface: a UNIQUE(request_id)/UNIQUE(order_number) violation, an FK
// violation, or a CHECK violation (e.g. a negative total tripping the money
// floor, or total != subtotal + tax_amount) propagates to the caller, whose
// transaction rolls back. Nothing is caught-and-ignored here.

import { randomUUID } from 'node:crypto';
import { sql, type Insertable, type Kysely } from 'kysely';
import { tenantSchema } from '@marlinjai/tenant-db';

import type { CommerceDB, OrderLineItemTable, OrderTable } from '../db-types';
import type {
  CreateOrderLineItemInput,
  CreateOrderRowInput,
  OrderLineItemRow,
  OrderRepository,
  OrderRow,
} from './types';

/** Zero-pad an order number to a stable width for human-readable invoice ids. */
function formatOrderNumber(n: number): string {
  return `ORD-${String(n).padStart(6, '0')}`;
}

export const orderRepository: OrderRepository = {
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
