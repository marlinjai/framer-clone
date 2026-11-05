import 'server-only';

// src/server/erasure/commerceSteps.ts
//
// The deletes of a company erasure in one tenant schema (plan docs/plans/2026-11-05-company-erasure-consumer.md),
// in an order every foreign key accepts: children before parents, and the two pairs that reference each other
// (an invoice and its stored PDF, a template and its versions) in one statement each, because RESTRICT is
// checked at the end of the statement. Every table is qualified with the schema as an interpolated identifier
// (the tenant isolation guards, scripts/check-guards.mjs, accept nothing else), and every value is a bound
// parameter. ERASURE_COVERAGE in commerce.ts says, per table, which step reaches it and why.

import type postgres from 'postgres';

export interface StepValues {
  /** The erased company (auth-brain tenant) id. */
  company: string;
  /** The tenant group the schema belongs to (form_submission's `tenant_id`). */
  group: string;
  /** The company's workspaces. */
  workspaces: string[];
  /** The company's sites. */
  sites: string[];
}

type Step = (tx: postgres.TransactionSql, schema: string, v: StepValues) => postgres.PendingQuery<postgres.Row[]>;

/** Delete the company's rows of a table that names the company in `tenant_id`. */
const byCompany =
  (table: string): Step =>
  (tx, s, v) =>
    tx`DELETE FROM ${tx(s)}.${tx(table)} WHERE "tenant_id" = ${v.company}`;

/** The inventory items of the company: its variants' SKUs that no variant of another company carries. */
const companyItems = (tx: postgres.TransactionSql, s: string, v: StepValues) => tx`
  SELECT "id" FROM ${tx(s)}."inventory_item" WHERE "sku" IN (
    SELECT "sku" FROM ${tx(s)}."product_variant" WHERE "tenant_id" = ${v.company} AND "sku" IS NOT NULL
    EXCEPT
    SELECT "sku" FROM ${tx(s)}."product_variant" WHERE "tenant_id" IS DISTINCT FROM ${v.company} AND "sku" IS NOT NULL
  )`;

/**
 * Whether the schema holds anything of the company, read without locking anything but the rows read: a row
 * naming the company in any of `companyTables`, or a form submission or fulfillment default of its
 * workspaces or sites. Every other table is reached through one of these (the stock ledger through the
 * company's variants, credit notes and reservations through its orders, the cascades through their
 * parents), so a schema without a hit has nothing to erase and gets no delete transaction at all.
 */
export function holdsCompany(
  tx: postgres.TransactionSql,
  s: string,
  v: StepValues,
  companyTables: readonly string[],
): postgres.PendingQuery<postgres.Row[]> {
  const byWorkspace = tx`
    SELECT 1 FROM ${tx(s)}."form_submission"
     WHERE "tenant_id" = ${v.group} AND ("workspace_id" = ANY(${tx.array(v.workspaces)}::text[]) OR "site_id" = ANY(${tx.array(v.sites)}::text[]))
    UNION ALL
    SELECT 1 FROM ${tx(s)}."fulfillment_location_default" WHERE "workspace_id" = ANY(${tx.array(v.workspaces)}::text[])`;
  const union = companyTables.reduce(
    (acc, table) => tx`${acc} UNION ALL SELECT 1 FROM ${tx(s)}.${tx(table)} WHERE "tenant_id" = ${v.company}`,
    byWorkspace,
  );
  return tx`SELECT EXISTS (${union}) AS "hit"`;
}

export const ERASURE_STEPS: ReadonlyArray<{ label: string; run: Step }> = [
  {
    label: 'form_submission',
    run: (tx, s, v) => tx`
      DELETE FROM ${tx(s)}."form_submission"
       WHERE "tenant_id" = ${v.group}
         AND ("workspace_id" = ANY(${tx.array(v.workspaces)}::text[]) OR "site_id" = ANY(${tx.array(v.sites)}::text[]))`,
  },
  {
    label: 'fulfillment_location_default',
    run: (tx, s, v) => tx`DELETE FROM ${tx(s)}."fulfillment_location_default" WHERE "workspace_id" = ANY(${tx.array(v.workspaces)}::text[])`,
  },
  { label: 'shop_mail', run: byCompany('shop_mail') },
  { label: 'shop_mail_connection', run: byCompany('shop_mail_connection') },
  { label: 'commerce_job', run: byCompany('commerce_job') },
  { label: 'payment_event', run: byCompany('payment_event') },
  { label: 'order_payment', run: byCompany('order_payment') },
  {
    label: 'reservation',
    run: (tx, s, v) => tx`
      DELETE FROM ${tx(s)}."reservation"
       WHERE "line_item_id" IN (SELECT "id" FROM ${tx(s)}."order_line_item" WHERE "tenant_id" = ${v.company})`,
  },
  {
    label: 'credit_note',
    run: (tx, s, v) => tx`
      DELETE FROM ${tx(s)}."credit_note" WHERE "order_id" IN (SELECT "id" FROM ${tx(s)}."order" WHERE "tenant_id" = ${v.company})`,
  },
  {
    label: 'stock_movement',
    run: (tx, s, v) => tx`DELETE FROM ${tx(s)}."stock_movement" WHERE "inventory_item_id" IN (${companyItems(tx, s, v)})`,
  },
  {
    label: 'inventory_level',
    run: (tx, s, v) => tx`DELETE FROM ${tx(s)}."inventory_level" WHERE "inventory_item_id" IN (${companyItems(tx, s, v)})`,
  },
  {
    label: 'inventory_item',
    run: (tx, s, v) => tx`DELETE FROM ${tx(s)}."inventory_item" WHERE "id" IN (${companyItems(tx, s, v)})`,
  },
  { label: 'order_line_item', run: byCompany('order_line_item') },
  { label: 'order', run: byCompany('order') },
  { label: 'historical_import_extraction', run: byCompany('historical_import_extraction') },
  { label: 'historical_import_item', run: byCompany('historical_import_item') },
  { label: 'sales_document_event', run: byCompany('sales_document_event') },
  { label: 'sales_document_line', run: byCompany('sales_document_line') },
  {
    label: 'sales_document_file+sales_document',
    run: (tx, s, v) => tx`
      WITH files AS (DELETE FROM ${tx(s)}."sales_document_file" WHERE "tenant_id" = ${v.company} RETURNING 1)
      DELETE FROM ${tx(s)}."sales_document" WHERE "tenant_id" = ${v.company}`,
  },
  { label: 'customer', run: byCompany('customer') },
  {
    label: 'document_template_version+document_template',
    run: (tx, s, v) => tx`
      WITH versions AS (DELETE FROM ${tx(s)}."document_template_version" WHERE "tenant_id" = ${v.company} RETURNING 1)
      DELETE FROM ${tx(s)}."document_template" WHERE "tenant_id" = ${v.company}`,
  },
  { label: 'document_number_counter', run: byCompany('document_number_counter') },
  { label: 'books_company_settings', run: byCompany('books_company_settings') },
  { label: 'books_asset', run: byCompany('books_asset') },
  { label: 'books_product', run: byCompany('books_product') },
  { label: 'product_site_hidden', run: byCompany('product_site_hidden') },
  { label: 'collection_product', run: byCompany('collection_product') },
  { label: 'product_image', run: byCompany('product_image') },
  { label: 'collection', run: byCompany('collection') },
  { label: 'price', run: byCompany('price') },
  { label: 'price_set', run: byCompany('price_set') },
  { label: 'product_variant_option', run: byCompany('product_variant_option') },
  { label: 'product_variant', run: byCompany('product_variant') },
  { label: 'product_option_value', run: byCompany('product_option_value') },
  { label: 'product_option', run: byCompany('product_option') },
  { label: 'product', run: byCompany('product') },
  { label: 'catalog_image', run: byCompany('catalog_image') },
  { label: 'payment_account', run: byCompany('payment_account') },
];
