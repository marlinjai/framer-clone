// src/server/books/repository/columns.ts
//
// The ONE column list per Books table that every Books query selects through
// (Books plan P1.1). DATE columns are selected cast to text: the base handle
// carries no custom parser, and postgres.js would parse a DATE into a JavaScript
// Date at UTC midnight. Never `selectAll()` on a Books table.

import type { ExpressionBuilder } from 'kysely';

import type { CommerceDB } from '../../commerce/db-types';

type DocEb = ExpressionBuilder<CommerceDB, 'sales_document'>;

/** sales_document without the two snapshots (what listDocuments returns). */
export function documentColumns(eb: DocEb) {
  return [
    'sales_document.id',
    'sales_document.tenant_id',
    'sales_document.doc_type',
    'sales_document.status',
    'sales_document.source',
    'sales_document.version',
    'sales_document.customer_id',
    'sales_document.template_id',
    'sales_document.corrects_document_id',
    'sales_document.source_order_id',
    'sales_document.document_number',
    'sales_document.number_value',
    eb.cast<string | null>('sales_document.issue_date', 'text').as('issue_date'),
    eb.cast<string | null>('sales_document.service_date', 'text').as('service_date'),
    eb.cast<string | null>('sales_document.service_period_start', 'text').as('service_period_start'),
    eb.cast<string | null>('sales_document.service_period_end', 'text').as('service_period_end'),
    eb.cast<string | null>('sales_document.due_date', 'text').as('due_date'),
    eb.cast<string | null>('sales_document.valid_until', 'text').as('valid_until'),
    'sales_document.payment_terms_days',
    'sales_document.payment_reference',
    'sales_document.contract_reference',
    'sales_document.currency_code',
    'sales_document.tax_region',
    'sales_document.customer_type',
    'sales_document.vat_id',
    'sales_document.reverse_charge',
    'sales_document.net_or_gross',
    'sales_document.kleinunternehmer',
    'sales_document.tax_note',
    'sales_document.tax_profile_key',
    'sales_document.subtotal',
    'sales_document.tax_amount',
    'sales_document.total',
    'sales_document.tax_summary',
    'sales_document.intro_text',
    'sales_document.outro_text',
    'sales_document.rendered_pdf_file_id',
    'sales_document.issued_at',
    'sales_document.created_at',
    'sales_document.updated_at',
    eb.cast<string>('sales_document.created_at', 'text').as('created_at_text'),
  ] as const;
}

/** sales_document with the two snapshots (what getDocument returns). */
export function documentColumnsWithSnapshots(eb: DocEb) {
  return [
    ...documentColumns(eb),
    'sales_document.customer_snapshot',
    'sales_document.sender_snapshot',
    'sales_document.template_snapshot',
  ] as const;
}

export const LINE_COLUMNS = [
  'id',
  'tenant_id',
  'document_id',
  'position',
  'kind',
  'title',
  'description',
  'quantity',
  'unit_label',
  'unit_price',
  'discount_bp',
  'subtotal',
  'tax_class',
  'tax_rate_override',
  'tax_rate',
  'tax_amount',
  'tax_treatment',
  'variant_ref',
  'variant_ref_source',
  'created_at',
  'updated_at',
] as const;

export const EVENT_COLUMNS = [
  'id',
  'tenant_id',
  'document_id',
  'event_type',
  'from_status',
  'to_status',
  'actor_user_id',
  'payload',
  'created_at',
] as const;

export const CUSTOMER_COLUMNS = [
  'id',
  'contact_id',
  'customer_type',
  'vat_id',
  'country_code',
  'tax_number',
  'archived_at',
  'created_at',
  'updated_at',
] as const;
