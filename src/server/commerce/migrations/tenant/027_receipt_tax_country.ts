import type { Migration } from '@marlinjai/tenant-db';

/**
 * The receipt's tax country, `027_receipt_tax_country`. Purely additive: one nullable column on `sales_document`.
 *
 * A draft's tax profile reads the recipient's country. For an invoice made in the editor that is the customer row's
 * country. A shop receipt reuses a customer row matched by the buyer's name (the shared contacts database's identity),
 * so the row may carry another person's country, and the receipt was refused (`TAX_IDENTITY_MISMATCH`) after the
 * buyer had paid. `tax_country` is the country the buyer gave for this order, set when the receipt's draft is made: the
 * profile reads it in place of the row's, and the row is never written. Null for every other document, which keeps
 * reading its customer.
 *
 * Frozen with the receipt for free: `sales_document_guard` compares the whole row on an issued document
 * (to_jsonb(OLD) minus the few mutable columns, 007 and 010), so a new column is immutable after issue.
 *
 * House style as 007 to 025: BARE names. Re-runnable.
 */
export const receiptTaxCountry: Migration = {
  id: '027_receipt_tax_country',
  up: async (tx) => {
    await tx`ALTER TABLE "sales_document" ADD COLUMN IF NOT EXISTS "tax_country" TEXT`;
    await tx`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'sales_document_tax_country_check' AND conrelid = 'sales_document'::regclass
        ) THEN
          ALTER TABLE "sales_document"
            ADD CONSTRAINT "sales_document_tax_country_check" CHECK ("tax_country" IS NULL OR "tax_country" ~ '^[A-Z]{2}$');
        END IF;
      END $$`;
  },
};
