import type { MigrationSet } from '@marlinjai/tenant-db';
import { enums } from './000_enums';
import { inventoryLedger } from './001_inventory_ledger';
import { guardedReservation } from './002_guarded_reservation';
import { catalog } from './003_catalog';
import { pricingAndTax } from './004_pricing_and_tax';
import { minimalOrders } from './005_minimal_orders';
import { inventoryPolicy } from './006_inventory_policy';
import { books } from './007_books';
import { booksFiles } from './008_books_files';
import { booksImport } from './009_books_import';
import { booksUploadImport } from './010_books_upload_import';
import { booksReplacement } from './011_books_replacement';
import { booksTemplateV2 } from './012_books_template_v2';
import { booksAssets } from './013_books_assets';
import { booksAssetDelete } from './014_books_asset_delete';
import { booksProducts } from './015_books_products';
import { booksSubject } from './016_books_subject';
import { formSubmissions } from './017_form_submissions';
import { booksTextFormat } from './018_books_text_format';

/**
 * CM-04 — `COMMERCE_TENANT_MIGRATIONS`: the per-tenant (`tg_<id>`) commerce
 * migration set, supplied to `provisionTenant` / `migrateAllTenants` (it REPLACES
 * the package's example workspaces/memberships/outbox set).
 *
 * The runner runs each `up` inside a transaction that already holds
 * `SET LOCAL search_path = <tg_id>, ext`, so every body uses BARE table names and
 * the structures land in the target schema. Each per-tenant schema is therefore
 * structurally identical and self-contained: `pg_dump -n tg_x` extracts one
 * customer with its own enums, constraints, triggers, sequence, and migration
 * history.
 *
 * ORDER MATTERS (every type / FK target / referenced table must exist before
 * use):
 *   000_enums              — the 9 enum TYPES (no table references them yet)
 *   001_inventory_ledger   — inventory_item, stock_location, inventory_level
 *                            (GENERATED available_quantity), stock_movement
 *   002_guarded_reservation— reservation, fulfillment_location_default, the
 *                            deferred transfer-balance constraint trigger
 *   003_catalog            — product graph, composite FK, option_signature triggers
 *   004_pricing_and_tax    — pricing graph, credit_note(_ref), money/currency CHECKs
 *   005_minimal_orders     — order, order_line_item, order_number_seq, the
 *                            accounting-identity CHECK, the credit_note->order FK
 *   006_inventory_policy   — product_variant.manage_inventory / allow_backorder
 *                            flags; DROP the reserved<=stocked CHECK (backorder)
 *   007_books              : the Books invoicing tier (company settings, number
 *                            counters, customer, template, sales_document with its
 *                            lines and append-only events, freeze triggers BK001
 *                            to BK005)
 *   008_books_files        : the stored document of record (the rendered PDF of an
 *                            issued document), append-only (BK006), one per
 *                            document, pointed at by sales_document.rendered_pdf_file_id
 *   009_books_import       : the historical import: the line's document foreign key
 *                            becomes deferrable (lines first, then the issued import
 *                            document), an import's lines must sum to its totals
 *                            (BK005), an import commits only with its stored
 *                            original (BK007), negative (discount) lines are
 *                            allowed on imports and their cancellations only
 *                            (BK008), a currency other than EUR only on imports
 *                            (BK009)
 *   010_books_upload_import: importing past invoices by uploading PDFs: an import
 *                            may keep a printed number without a number value, a
 *                            negative tax amount on its discount lines (BK008), and
 *                            the staging and ledger tables of the upload
 *                            (historical_import_item, historical_import_extraction,
 *                            BK010)
 *   011_books_replacement  : the Correct flow: sales_document.replaces_document_id
 *                            (an invoice replacing an issued editor invoice), one
 *                            replacement per invoice, and a replacement issued only
 *                            together with the cancellation of its invoice (BK011)
 *   012_books_template_v2  : templates become versioned documents of typed blocks:
 *                            document_template_version (append-only, BK012), each
 *                            template's current version, archiving instead of
 *                            deleting, existing templates converted to the
 *                            Klassisch layout as version 1, the version 1 layout
 *                            columns dropped
 *   013_books_assets       : the logos templates print: books_asset (PNG or JPEG
 *                            bytes, unique per company and SHA-256, append-only,
 *                            BK014)
 *   014_books_asset_delete : a logo nobody uses may be deleted: books_asset
 *                            refuses a DELETE while an issued document froze
 *                            the logo or a live template's current version
 *                            names it (BK015, one definition of "in use" in
 *                            books_asset_in_use), UPDATE and TRUNCATE stay
 *                            refused (BK014); commerce_app may DELETE
 *   015_books_products     : the company's list of products and services
 *                            (books_product, mutable, archived instead of
 *                            deleted, a name unique among the live items);
 *                            draft lines copy its values, never reference it
 *   016_books_subject      : a document's subject line (sales_document.subject,
 *                            nullable, at most 200 characters; frozen after
 *                            issue by 007's guard like every column)
 *   017_form_submissions   : what visitors send through a form on a published
 *                            site (form_submission, mutable only in read_at,
 *                            deleted for real by the owner, the project delete
 *                            and company erasure; no IP address stored)
 *   018_books_text_format  : the formatting of the intro and closing texts
 *                            (intro_format / outro_format, nullable JSONB of
 *                            version 1; the plain text is derived from it)
 */
export const COMMERCE_TENANT_MIGRATIONS: MigrationSet = [
  enums,
  inventoryLedger,
  guardedReservation,
  catalog,
  pricingAndTax,
  minimalOrders,
  inventoryPolicy,
  books,
  booksFiles,
  booksImport,
  booksUploadImport,
  booksReplacement,
  booksTemplateV2,
  booksAssets,
  booksAssetDelete,
  booksProducts,
  booksSubject,
  formSubmissions,
  booksTextFormat,
];
