// src/server/books/snapshots.ts
//
// The JSON shapes the Books tables store (Books plan P1.5), as zod schemas so
// each one is parsed on write and on read. Versioned with `v: 1`: a later shape
// is a new schema beside this one, never an edit of a frozen document.
//
//   - SenderBlockV1: the issuer's legal identity, the company setting
//     (books_company_settings.sender_block). Filled by the init script from the
//     auth-brain company record plus a local file; never a constant in the code.
//   - SenderSnapshotV1: the sender block as it stood at issue, frozen on the
//     document.
//   - CustomerSnapshotV1: the recipient as it stood at issue: name and address
//     from the shared contacts database, tax fields from the customer row. Never
//     recomputed, never returned by listDocuments, never written to a log or an
//     event payload.
//   - TaxSummary: one entry per (rate, treatment) group.
//   - TemplateSnapshotV1 / V2: the template layout frozen at issue. Version 1
//     (accent colour and small print) is rendered by the frozen legacy
//     renderer; version 2 carries the whole template document (template model
//     version 2, template/schema.ts) and is rendered by the layout engine.
//
// Pure module (zod and kysely's sql tag, no database), safe in unit tests and in
// the type module db-types.ts (which imports these types with `import type`).

import { sql, type RawBuilder } from 'kysely';
import { z } from 'zod';

import { templateDocumentV2Schema, type TemplateDocumentV2 } from './template/schema';

import type { JsonbWrite } from '../commerce/db-types';

const optionalText = z.string().nullable();

/** The issuer's legal identity (the company setting). */
export const senderBlockV1Schema = z.object({
  legalName: optionalText,
  addressLine1: optionalText,
  addressLine2: optionalText,
  postalCode: optionalText,
  city: optionalText,
  countryCode: optionalText,
  taxNumber: optionalText,
  vatId: optionalText,
  smallBusinessId: optionalText,
  email: optionalText,
  phone: optionalText,
  website: optionalText,
  bankName: optionalText,
  iban: optionalText,
  bic: optionalText,
  registerCourt: optionalText,
  registerNumber: optionalText,
  managingDirector: optionalText,
});
export type SenderBlockV1 = z.infer<typeof senderBlockV1Schema>;

/**
 * The address lines exactly as an imported document printed them (the
 * historical import, 009). Optional, so every snapshot written before stays
 * valid; documents issued here never carry it (their fields are the print).
 */
const printedAddressLines = z.array(z.string()).max(12).optional();

/** The sender block frozen on an issued document. */
export const senderSnapshotV1Schema = senderBlockV1Schema.extend({
  v: z.literal(1),
  addressLines: printedAddressLines,
});
export type SenderSnapshotV1 = z.infer<typeof senderSnapshotV1Schema>;

/** The recipient frozen on an issued document. */
export const customerSnapshotV1Schema = z.object({
  v: z.literal(1),
  contactId: z.string(),
  kind: z.enum(['person', 'organization']),
  name: z.string(),
  companyOrRole: z.string(),
  legalForm: optionalText,
  addressLine1: z.string(),
  addressLine2: optionalText,
  postalCode: z.string(),
  city: z.string(),
  country: z.string(),
  customerNumber: z.number().int().nullable(),
  customerType: z.enum(['b2c', 'b2b']),
  vatId: optionalText,
  taxNumber: optionalText,
  /** Imported documents only: the printed address lines, verbatim. */
  addressLines: printedAddressLines,
  /** Imported documents only: the customer number as printed, when it was not a plain integer. */
  customerNumberText: z.string().max(64).optional(),
});
export type CustomerSnapshotV1 = z.infer<typeof customerSnapshotV1Schema>;

/**
 * The template's layout as it stood at issue (phase 3), frozen on the document
 * like the other snapshots, so a later template edit never changes how an
 * issued document renders. The intro and outro texts are not here: they are the
 * document's own columns, frozen with it.
 */
export const templateSnapshotV1Schema = z.object({
  v: z.literal(1),
  templateId: z.string().nullable(),
  name: z.string().nullable(),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable(),
  footerBlocks: z
    .array(z.object({ heading: z.string().nullable(), text: z.string() }))
    .max(4),
});
export type TemplateSnapshotV1 = z.infer<typeof templateSnapshotV1Schema>;

/**
 * The template as it stood at issue under the template model version 2
 * (visual template composer plan, decision 4): the whole document, not only
 * its version id, so a re-render never depends on another table; the version
 * id is the human reference ("issued with Klassisch, version 4"). A document
 * without a template freezes the built-in Klassisch layout with null ids.
 */
export const templateSnapshotV2Schema = z
  .object({
    v: z.literal(2),
    templateId: z.string().nullable(),
    templateVersionId: z.string().nullable(),
    name: z.string().nullable(),
    document: templateDocumentV2Schema,
    /** The logo asset (phase 5); null until then. */
    logo: z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict().nullable(),
  })
  .strict();
export type TemplateSnapshotV2 = z.infer<typeof templateSnapshotV2Schema>;

/** A frozen template layout of either version. */
export const templateSnapshotSchema = z.discriminatedUnion('v', [templateSnapshotV1Schema, templateSnapshotV2Schema]);
export type TemplateSnapshot = TemplateSnapshotV1 | TemplateSnapshotV2;
export type { TemplateDocumentV2 };

/** One tax group of a document: the lines sharing a rate and a treatment. */
export const taxSummaryEntrySchema = z.object({
  taxRate: z.number().int(),
  taxTreatment: z.enum(['standard', 'reduced', 'zero', 'reverse_charge', 'kleinunternehmer']),
  net: z.number().int(),
  tax: z.number().int(),
});
export type TaxSummaryEntry = z.infer<typeof taxSummaryEntrySchema>;
export const taxSummarySchema = z.array(taxSummaryEntrySchema);
export type TaxSummary = z.infer<typeof taxSummarySchema>;


/** An event payload. Never a recipient's name or address. */
export type EventPayload = Record<string, unknown>;

/**
 * The one write path for every JSONB column: the value serialized once and sent
 * as a TEXT parameter cast to jsonb (the contacts-core pattern). Passing the
 * serialized string straight to a jsonb column would not work: postgres.js
 * JSON-serializes a parameter the server types as jsonb a second time, and the
 * column would hold a JSON string scalar instead of the object.
 */
export function toJsonb(value: unknown): RawBuilder<JsonbWrite> {
  // A JSONB column is either written with a value or left NULL by the caller;
  // serializing null or undefined would store the JSON literal `null`.
  if (value === null || value === undefined) {
    throw new Error('toJsonb: no value to write (leave the column NULL instead)');
  }
  return sql<JsonbWrite>`${JSON.stringify(value)}::text::jsonb`;
}

// --- validation at issue ------------------------------------------------------

/** The sender fields section 34a requires on every invoice. */
const SENDER_REQUIRED = ['legalName', 'addressLine1', 'postalCode', 'city', 'countryCode'] as const;
/**
 * How the issuer is identified to the tax office (section 14 (4) no. 2 UStG,
 * section 34a UStDV): under Section 19 the tax number, the VAT id or the
 * small-business identification number (Kleinunternehmer-Identifikationsnummer);
 * under regular taxation the tax number or the VAT id. A reverse-charge
 * invoice must carry the issuer's VAT id (section 14a (1) UStG).
 */
export const SENDER_TAX_ID_FIELDS = ['taxNumber', 'vatId', 'smallBusinessId'] as const;
export const REGULAR_SENDER_TAX_ID_FIELDS = ['taxNumber', 'vatId'] as const;

/** What decides which issuer tax id an invoice needs. */
export interface SenderTaxContext {
  taxStatus: 'small_business' | 'regular';
  reverseCharge: boolean;
}

function blank(value: string | null | undefined): boolean {
  return value == null || value.trim() === '';
}

/**
 * The names of the required sender fields that are empty for an invoice in the
 * given tax context. A tax id group is reported as one entry (e.g.
 * `taxNumber|vatId`) when none of its fields is set. Names only, never values.
 */
export function senderMissingFields(block: SenderBlockV1, ctx: SenderTaxContext): string[] {
  const missing: string[] = SENDER_REQUIRED.filter((f) => blank(block[f]));
  if (ctx.reverseCharge) {
    if (blank(block.vatId)) missing.push('vatId');
    return missing;
  }
  const accepted = ctx.taxStatus === 'small_business' ? SENDER_TAX_ID_FIELDS : REGULAR_SENDER_TAX_ID_FIELDS;
  if (accepted.every((f) => blank(block[f]))) missing.push(accepted.join('|'));
  return missing;
}

/** The recipient as the contacts database returns it (the port's shape). */
export interface RecipientContact {
  id: string;
  kind: 'person' | 'organization';
  name: string;
  companyOrRole: string;
  legalForm: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  postalCode: string | null;
  city: string | null;
  country: string | null;
  vatId: string | null;
  customerNumber: number | null;
  archived: boolean;
}

/** The recipient fields section 34a requires. */
export const RECIPIENT_REQUIRED = ['name', 'addressLine1', 'postalCode', 'city', 'country'] as const;

/** The names of the required recipient fields that are empty. Names only, never values. */
export function recipientMissingFields(contact: RecipientContact): string[] {
  return RECIPIENT_REQUIRED.filter((f) => blank(contact[f]));
}

/**
 * Build the customer snapshot from the contact (name, address) and the customer
 * row (tax fields). The caller has checked {@link recipientMissingFields} first;
 * the parse is the backstop.
 */
export function buildCustomerSnapshot(
  contact: RecipientContact,
  customer: { customerType: 'b2c' | 'b2b'; vatId: string | null; taxNumber: string | null },
): CustomerSnapshotV1 {
  return customerSnapshotV1Schema.parse({
    v: 1,
    contactId: contact.id,
    kind: contact.kind,
    name: contact.name,
    companyOrRole: contact.companyOrRole,
    legalForm: contact.legalForm,
    addressLine1: contact.addressLine1,
    addressLine2: contact.addressLine2,
    postalCode: contact.postalCode,
    city: contact.city,
    country: contact.country,
    customerNumber: contact.customerNumber,
    customerType: customer.customerType,
    vatId: customer.vatId,
    taxNumber: customer.taxNumber,
  });
}

/** Build the sender snapshot. The caller has checked {@link senderMissingFields} first. */
export function buildSenderSnapshot(block: SenderBlockV1): SenderSnapshotV1 {
  return senderSnapshotV1Schema.parse({ v: 1, ...senderBlockV1Schema.parse(block) });
}
