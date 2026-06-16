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
