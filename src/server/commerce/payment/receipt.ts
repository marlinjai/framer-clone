import 'server-only';

// src/server/commerce/payment/receipt.ts
//
// The receipt of a paid shop order: an invoice in the selling company's Books, issued automatically
// (docs/plans/2026-10-25-catalogue-design.md, "Checkout, payment and receipt", item 4). It goes through the
// same steps a person takes in the invoice editor, so every check of the Issue button applies:
//
//   1. the buyer becomes a contact of the company in the shared contacts database (an existing contact with
//      the same identity is reused) and a Books customer (reused when the contact already is one);
//   2. a draft invoice for that customer, linked to the order (source_order_id, one receipt per order), its
//      service date the order's day (Europe/Berlin), net or gross as the order was priced;
//   3. one line per order line, copied from the order's snapshot (title, quantity, unit price, tax class),
//      the variant as the line's reference;
//   4. the draft's totals must equal the order's (the same German VAT module priced both): otherwise the
//      draft is deleted and nothing is issued;
//   5. issue, with the PDF rendered, checked and stored before the commit (render/store.ts), numbered in the
//      company's series.
//
// Idempotent: an issued receipt for the order is answered as it is; a draft left by an interrupted attempt is
// deleted and built again (019_books_draft_delete). Every failure throws (the caller keeps the reason on the
// payment); nothing is half issued.

import { BooksError } from '@/server/books/errors';
import type { ContactBook, NewContactInput } from '@/server/books/contactBook';
import { issue } from '@/server/books/issue';
import { storeBeforeCommit } from '@/server/books/render/store';
import { createCustomer, customersByContactIds } from '@/server/books/repository/customers';
import { createDraft, deleteDraft } from '@/server/books/repository/documents';
import { addLine } from '@/server/books/repository/lines';
import { getDocument } from '@/server/books/repository/read';
import type { BooksScope } from '@/server/books/scope';
import { requireSettings } from '@/server/books/settings';
import { readBuyer, type Buyer } from './buyer';

/** The actor recorded on the receipt's events: the shop, not a person. */
export const SHOP_ACTOR = 'shop-checkout';

const TAX_CLASSES = new Set(['standard', 'reduced', 'zero']);

/** A receipt that cannot be made from this order (the reason is a stable code, no personal data). */
export class ReceiptError extends Error {
  constructor(readonly code: 'ORDER_NOT_FOUND' | 'BUYER_MISSING' | 'NOT_PAID' | 'TOTALS_MISMATCH' | 'CUSTOMER_ARCHIVED') {
    super(code);
    this.name = 'ReceiptError';
  }
}

/** The calendar day of an instant in Europe/Berlin, YYYY-MM-DD. */
export function berlinDay(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(at);
}

function contactFor(buyer: Buyer): NewContactInput {
  const organization = buyer.kind === 'organization';
  return {
    kind: buyer.kind,
    name: organization ? (buyer.companyName?.trim() || buyer.name) : buyer.name,
    companyOrRole: organization ? null : (buyer.companyName?.trim() || null),
    email: buyer.email,
    addressLine1: buyer.addressLine1,
    addressLine2: buyer.addressLine2 ?? null,
    postalCode: buyer.postalCode,
    city: buyer.city,
    country: buyer.country,
    vatId: buyer.vatId ?? null,
  };
}

/** The Books customer for the buyer: the existing one of the contact, or a new one. */
async function customerFor(scope: BooksScope, contactBook: ContactBook, buyer: Buyer): Promise<string> {
  const input = contactFor(buyer);
  const contact =
    (await contactBook.findSame(scope.tenantId, { kind: input.kind, name: input.name, companyOrRole: input.companyOrRole })) ??
    (await contactBook.create(scope.tenantId, input));
  const [existing] = await customersByContactIds(scope, [contact.id]);
  if (existing) {
    if (existing.archivedAt) throw new ReceiptError('CUSTOMER_ARCHIVED');
    return existing.id;
  }
  const created = await createCustomer(scope, {
    contactId: contact.id,
    customerType: buyer.vatId ? 'b2b' : 'b2c',
    countryCode: buyer.country,
    vatId: buyer.vatId ?? null,
  });
  return created.id;
}

/**
 * Issue (or find) the receipt of a paid order of the scope's company. Answers the Books document id. Throws
 * ReceiptError for an order that cannot have one yet, a BooksError for what the Issue button would refuse
 * (an incomplete sender, the contacts database not answering, ...), with nothing issued.
 */
export async function ensureReceipt(
  scope: BooksScope,
  contactBook: ContactBook,
  orderId: string,
  opts: { now?: Date } = {},
): Promise<{ documentId: string }> {
  const db = scope.db;
  const order = await db
    .selectFrom('order')
    .select(['id', 'total', 'net_or_gross', 'created_at'])
    .where('tenant_id', '=', scope.tenantId)
    .where('id', '=', orderId)
    .executeTakeFirst();
  if (!order) throw new ReceiptError('ORDER_NOT_FOUND');
  const payment = await db
    .selectFrom('order_payment')
    .select(['status', 'buyer'])
    .where('tenant_id', '=', scope.tenantId)
    .where('order_id', '=', orderId)
    .executeTakeFirst();
  if (!payment || payment.status !== 'paid') throw new ReceiptError('NOT_PAID');

  // An earlier attempt: issued, answer it; a draft left behind, start over.
  const earlier = await db
    .selectFrom('sales_document')
    .select(['id', 'status'])
    .where('tenant_id', '=', scope.tenantId)
    .where('source_order_id', '=', orderId)
    .executeTakeFirst();
  if (earlier && earlier.status !== 'draft') return { documentId: earlier.id };
  if (earlier) await deleteDraft(scope, earlier.id);

  const buyer = readBuyer(payment.buyer as Record<string, unknown>);
  if (!buyer) throw new ReceiptError('BUYER_MISSING');
  // The Books must be set up for the company before anything is written (SETTINGS_MISSING otherwise).
  await requireSettings(db, scope);
  const customerId = await customerFor(scope, contactBook, buyer);

  const draft = await createDraft(scope, {
    docType: 'invoice',
    actorUserId: SHOP_ACTOR,
    customerId,
    netOrGross: order.net_or_gross,
    serviceDate: berlinDay(new Date(order.created_at)),
    sourceOrderId: orderId,
  });
  const id = draft.document.id;

  const lines = await db
    .selectFrom('order_line_item')
    .leftJoin('product_variant', (join) =>
      join
        .onRef('product_variant.id', '=', 'order_line_item.variant_ref')
        .onRef('product_variant.tenant_id', '=', 'order_line_item.tenant_id'),
    )
    .leftJoin('product', (join) =>
      join.onRef('product.id', '=', 'product_variant.product_id').onRef('product.tenant_id', '=', 'product_variant.tenant_id'),
    )
    .select([
      'order_line_item.variant_title as title',
      'order_line_item.variant_sku as sku',
      'order_line_item.quantity as quantity',
      'order_line_item.unit_price as unitPrice',
      'order_line_item.tax_class as taxClass',
      'order_line_item.variant_ref as variantRef',
      'order_line_item.variant_ref_source as variantRefSource',
      'product.kind as productKind',
      'product.title as productTitle',
      'product.unit_label as unitLabel',
    ])
    .where('order_line_item.tenant_id', '=', scope.tenantId)
    .where('order_line_item.order_id', '=', orderId)
    .orderBy('order_line_item.created_at')
    .orderBy('order_line_item.id')
    .execute();

  try {
    for (const line of lines) {
      await addLine(scope, id, {
        kind: line.productKind === 'service' ? 'service' : 'product',
        title: (line.title?.trim() || line.productTitle || line.sku || 'Artikel').slice(0, 300),
        quantity: line.quantity * 1000,
        unitLabel: line.unitLabel ?? 'Stk',
        unitPrice: line.unitPrice,
        taxClass: line.taxClass && TAX_CLASSES.has(line.taxClass) ? (line.taxClass as 'standard' | 'reduced' | 'zero') : null,
        ...(line.variantRefSource === 'owned' && line.variantRef ? { variantRef: line.variantRef } : {}),
      });
    }
    const view = await getDocument(scope, id);
    if (view.document.total !== order.total) throw new ReceiptError('TOTALS_MISMATCH');
  } catch (err) {
    await deleteDraft(scope, id).catch((cleanup: unknown) => {
      console.error(`[receipt] order ${orderId}: the unfinished draft ${id} could not be removed:`, cleanup);
    });
    throw err;
  }

  const issued = await issue(scope, id, { actorUserId: SHOP_ACTOR }, { beforeCommit: storeBeforeCommit(scope), now: opts.now });
  if (issued.document.document.status === 'draft') {
    throw new BooksError('INVALID_TRANSITION', 'the receipt stayed a draft', { documentId: id });
  }
  return { documentId: id };
}
