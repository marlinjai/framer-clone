import 'server-only';

// src/server/erasure/commerce.ts
//
// A company erasure's reach into the commerce and Books schemas (plan
// docs/plans/2026-11-05-company-erasure-consumer.md). One `tg_<hex32>` schema per auth-brain TENANT GROUP,
// SHARED by every company of the group, so a company is erased by deleting its rows, never by dropping the
// schema. auth-brain's payload does not carry the group, and a company can have rows in its group's schema
// without any site (a Books-only company), so EVERY tenant schema is visited.
//
// What "the company's rows" means differs per table, and the difference is load-bearing:
//   - most tables name the COMPANY in `tenant_id` (Books since 007, catalogue and orders since 020);
//   - `form_submission.tenant_id` is the tenant GROUP (017); its company key is `workspace_id` (and
//     `site_id`), so it is deleted by the company's workspaces and sites;
//   - the stock ledger, credit notes and reservations name no company: they are reached through the
//     company's variants (by SKU) and orders;
//   - `stock_location` and `price_list` belong to the group, hold no personal data and no company key, and
//     stay.
// ERASURE_COVERAGE names every table and how it is reached; an integration test fails on a table of a
// provisioned schema that is not in it, so a new table cannot be forgotten.
//
// Runs on the OWNER connection (COMMERCE_OWNER_DATABASE_URL, role commerce_ddl): the app role may not delete
// the append-only tables, and the delete guards let a delete through only for the schema owner with the
// transaction-local `lumitra.erasing_company` setting naming the company (tenant migration 029). One
// transaction per bounded delete batch, under the shared form of the deploy lock. A failure rolls back
// only the current batch and throws: the caller answers 5xx and auth-brain retries with the earlier
// batches already committed. Every statement is idempotent, so a retry finishes what an earlier attempt left.

import type postgres from 'postgres';

import { ERASING_COMPANY_SETTING } from '@/server/commerce/migrations/tenant/029_company_erasure';
import { COMMERCE_DEPLOY_LOCK_KEY } from '@/server/commerce/provisioning/deploy';
import { openOwnerSql, type OwnerTimeouts } from '@/server/commerce/provisioning/ownerSql';

import { ERASURE_STEPS, holdsCompany, type StepValues } from './commerceSteps';

export { ERASURE_STEPS };

export const ERASURE_MIGRATION_ID = '029_company_erasure';

/** The bounded waits of an erasure transaction: a busy schema fails fast, and auth-brain retries. */
export const ERASURE_TIMEOUTS: OwnerTimeouts = { lockTimeoutMs: 10_000, statementTimeoutMs: 60_000 };

/** How each table of a tenant schema is reached by a company erasure. */
export const ERASURE_COVERAGE: Readonly<Record<string, string>> = {
  form_submission: 'group id plus the company workspaces or sites (tenant_id is the GROUP here)',
  fulfillment_location_default: 'the company workspaces',
  form_notification: 'cascade from form_submission (its foreign key); the letter holds the visitor words and is emptied once settled',
  shop_mail: 'company',
  shop_mail_connection: 'company',
  commerce_job: 'company',
  payment_event: 'company',
  order_payment: 'company',
  reservation: 'the order lines of the company',
  credit_note: 'the orders of the company',
  credit_note_ref: 'cascade from credit_note',
  stock_movement: 'the inventory items of the company SKUs',
  inventory_level: 'the inventory items of the company SKUs',
  inventory_item: 'the SKUs of the company variants that no other company uses',
  order_line_item: 'company',
  order: 'company',
  historical_import_extraction: 'company',
  historical_import_item: 'company',
  sales_document_event: 'company',
  sales_document_line: 'company',
  sales_document_file: 'company (one statement with sales_document: they reference each other)',
  sales_document: 'company',
  customer: 'company',
  document_template_version: 'company (one statement with document_template: they reference each other)',
  document_template: 'company',
  document_number_counter: 'company',
  books_company_settings: 'company',
  books_asset: 'company (bytes per company and SHA-256, so another company with the same file keeps its row)',
  books_product: 'company',
  product_site_hidden: 'company',
  collection_product: 'company',
  product_image: 'company',
  collection: 'company',
  price_rule: 'cascade from price',
  price: 'company',
  price_set: 'company',
  product_variant_option: 'company',
  product_variant: 'company',
  product_option_value: 'company',
  product_option: 'company',
  product: 'company',
  catalog_image: 'company (bytes per company and SHA-256, as books_asset)',
  payment_account: 'company (the Stripe account row only; Stripe itself is not called)',
  stock_location: 'KEPT: belongs to the tenant group, names no company, holds no personal data',
  price_list: 'KEPT: belongs to the tenant group, names no company, holds no personal data',
  __tenant_db_migrations: 'KEPT: the schema migration ledger',
};

/** The tables that name the company in `tenant_id`: what the probe of a schema reads. */
export const COMPANY_KEYED_TABLES: readonly string[] = Object.entries(ERASURE_COVERAGE)
  .filter(([, how]) => how.startsWith('company'))
  .map(([table]) => table);

const SCHEMA_NAME = /^tg_([0-9a-f]{32})$/;

/** `tg_<hex32>` back to the tenant group id it was made from (8-4-4-4-12). */
export function groupIdOfSchema(schema: string): string | null {
  const m = SCHEMA_NAME.exec(schema);
  if (!m) return null;
  const h = m[1];
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export interface CommerceErasureScope {
  companyId: string;
  workspaceIds: readonly string[];
  siteIds: readonly string[];
}

export interface CommerceErasureResult {
  /** Tenant schemas looked at. */
  schemas: number;
  /** Of those, the schemas that held something of the company and were erased in. */
  erasedIn: number;
  /** Rows deleted per step label, summed over every schema (cascades not counted). */
  deleted: Record<string, number>;
}

/** Erase the company in every tenant schema, through an owner connection to `ownerUrl`. */
export async function eraseCompanyCommerce(ownerUrl: string, scope: CommerceErasureScope): Promise<CommerceErasureResult> {
  const sql = await openOwnerSql(ownerUrl, ERASURE_TIMEOUTS);
  try {
    return await eraseCompanyCommerceWith(sql, scope);
  } finally {
    await sql.end();
  }
}

/** As eraseCompanyCommerce, on an open owner session (tests pass their own). */
export async function eraseCompanyCommerceWith(sql: postgres.Sql, scope: CommerceErasureScope): Promise<CommerceErasureResult> {
  const schemas = (
    await sql<{ nspname: string }[]>`SELECT nspname FROM pg_namespace WHERE nspname ~ '^tg_[0-9a-f]{32}$' ORDER BY nspname`
  ).map((r) => r.nspname);
  const deleted: Record<string, number> = {};
  let visited = 0;
  for (const schema of schemas) {
    const groupId = groupIdOfSchema(schema);
    if (!groupId) continue;
    const values: StepValues = { company: scope.companyId, group: groupId, workspaces: [...scope.workspaceIds], sites: [...scope.siteIds] };
    const lockForms = async (tx: postgres.TransactionSql) => {
      // Drain writers before even probing: an uncommitted first submission must not make a schema
      // look empty. Writers re-check the deleted public site while holding this same lock.
      for (const siteId of [...new Set(scope.siteIds)].sort()) {
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`site-forms:${siteId}`}, 0))`;
      }
    };
    const hit = await sql.begin(async (tx) => {
      await lockForms(tx);
      const [probe] = await holdsCompany(tx, schema, values, COMPANY_KEYED_TABLES);
      return probe?.hit === true;
    });
    if (!hit) continue;
    visited += 1;
    for (const step of ERASURE_STEPS) {
      for (;;) {
        const count = await sql.begin(async (tx) => {
          await tx`SELECT pg_advisory_xact_lock_shared(${COMMERCE_DEPLOY_LOCK_KEY}::bigint)`;
          // Overlapping events must not select the same physical batch and mistake a lost delete race
          // for an empty table. A fresh statement snapshot follows this company lock.
          await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`company-erasure:${scope.companyId}`}, 0))`;
          const [applied] = await tx<{ ok: boolean }[]>`
            SELECT EXISTS (SELECT 1 FROM ${tx(schema)}."__tenant_db_migrations" WHERE "id" = ${ERASURE_MIGRATION_ID}) AS ok`;
          if (!applied?.ok) {
            throw new Error(`company erasure: schema ${schema} lacks migration ${ERASURE_MIGRATION_ID}; the fleet migration must run first`);
          }
          if (step.label === 'form_submission') await lockForms(tx);
          await tx`SELECT set_config(${ERASING_COMPANY_SETTING}, ${scope.companyId}, true)`;
          return (await step.run(tx, schema, values)).count;
        });
        deleted[step.label] = (deleted[step.label] ?? 0) + count;
        // Some batches (invoice leaves) are shorter than the limit even with parents left to erase.
        if (count === 0) break;
      }
    }
  }
  return { schemas: schemas.length, erasedIn: visited, deleted };
}
