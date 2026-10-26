// src/server/commerce/payment/buyer.ts
//
// The buyer as entered at checkout (order_payment.buyer, 021_order_payment): what the receipt's contact in
// the company's contacts database is made from. A person or an organization with a name, an email address
// for the confirmation, and the postal address an invoice needs (section 14 (4) UStG: full name and address
// of the recipient). A business may add its VAT id. Parsed with zod on the way in and on every read.

import { z } from 'zod';

const line = (max: number) => z.string().trim().min(1).max(max);

export const buyerSchema = z
  .object({
    kind: z.enum(['person', 'organization']).default('person'),
    name: line(200),
    email: z.string().trim().email().max(320),
    companyName: z.string().trim().max(200).nullable().optional(),
    addressLine1: line(200),
    addressLine2: z.string().trim().max(200).nullable().optional(),
    postalCode: line(20),
    city: line(100),
    country: z
      .string()
      .trim()
      .transform((v) => v.toUpperCase())
      .refine((v) => /^[A-Z]{2}$/.test(v), 'expected a two-letter country code such as DE'),
    vatId: z.string().trim().max(32).nullable().optional(),
  })
  .strict();

export type Buyer = z.output<typeof buyerSchema>;
export type BuyerInput = z.input<typeof buyerSchema>;

/** The stored buyer, or null for a payment whose buyer was not given yet (an empty object). */
export function readBuyer(stored: Record<string, unknown>): Buyer | null {
  if (Object.keys(stored).length === 0) return null;
  const parsed = buyerSchema.safeParse(stored);
  if (!parsed.success) throw new Error(`order_payment.buyer is malformed: ${parsed.error.message}`);
  return parsed.data;
}
