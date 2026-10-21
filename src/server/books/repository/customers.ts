// src/server/books/repository/customers.ts
//
// Customers (Books plan P1.2, P1.6). A customer row holds the tax fields an
// invoice needs (business or consumer, VAT id, country, tax number) and the id
// of the contact in the shared contacts database, which owns the name, the
// address and the customer number. When `vatId` or `countryCode` is omitted at
// creation, the contact's values prefill them ONCE; after that the customer row
// is authoritative for tax and the contact for name and address (phase 2's
// editor shows both when they differ, nothing is reconciled silently).

import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import type { CustomerType } from '../../commerce/db-types';
import { BooksError, constraintName, invalid, sqlState, withDbErrors } from '../errors';
import { readRecipient } from '../recipients';
import type { BooksScope } from '../scope';
import { CUSTOMER_COLUMNS } from './columns';
import { selectCustomerRow, type CustomerRow } from './taxState';

export interface Customer {
  id: string;
  contactId: string;
  customerType: CustomerType;
  vatId: string | null;
  countryCode: string;
  taxNumber: string | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export function mapCustomer(row: CustomerRow): Customer {
  return {
    id: row.id,
    contactId: row.contact_id,
    customerType: row.customer_type,
    vatId: row.vat_id,
    countryCode: row.country_code,
    taxNumber: row.tax_number,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const VAT_ID = /^[A-Z]{2}[A-Z0-9+*]{2,13}$/;

/** Upper case, no spaces (the stored form). */
export function normalizeVatId(value: string): string {
  return value.replace(/\s+/g, '').toUpperCase();
}

const vatIdInput = z
  .string()
  .transform(normalizeVatId)
  .refine((v) => VAT_ID.test(v), 'expected a VAT id such as DE123456789');
const countryInput = z
  .string()
  .transform((v) => v.trim().toUpperCase())
  .refine((v) => /^[A-Z]{2}$/.test(v), 'expected an ISO 3166-1 alpha-2 country code');
const taxNumberInput = z.string().trim().min(1).max(64);

const createInput = z.object({
  contactId: z.string().regex(UUID, 'expected a contact id'),
  customerType: z.enum(['b2c', 'b2b']),
  vatId: vatIdInput.nullable().optional(),
  countryCode: countryInput.optional(),
  taxNumber: taxNumberInput.nullable().optional(),
});
export type CreateCustomerInput = z.input<typeof createInput>;

/**
 * Create the company's customer for a contact. The contact is read first
 * (outside any transaction): RECIPIENT_NOT_FOUND when it does not exist for the
 * company, RECIPIENT_UNAVAILABLE when the contacts database cannot be read.
 */
export async function createCustomer(scope: BooksScope, input: CreateCustomerInput): Promise<Customer> {
  const parsed = createInput.safeParse(input);
  if (!parsed.success) throw invalid('INVALID_INPUT', parsed.error.issues);
  const args = parsed.data;

  const contact = await readRecipient(scope, args.contactId);
  if (!contact) throw new BooksError('RECIPIENT_NOT_FOUND', 'RECIPIENT_NOT_FOUND: no such contact for this company');

  // Prefill once from the contact, validated like an explicit input.
  let vatId = args.vatId;
  if (vatId === undefined) {
    if (contact.vatId === null || contact.vatId.trim() === '') vatId = null;
    else {
      const fromContact = vatIdInput.safeParse(contact.vatId);
      if (!fromContact.success) throw invalid('INVALID_INPUT', [{ path: ['vatId'], message: "the contact's VAT id is not valid; pass vatId explicitly" }]);
      vatId = fromContact.data;
    }
  }
  let countryCode = args.countryCode;
  if (countryCode === undefined) {
    if (contact.country === null || contact.country.trim() === '') countryCode = 'DE';
    else {
      const fromContact = countryInput.safeParse(contact.country);
      if (!fromContact.success) throw invalid('INVALID_INPUT', [{ path: ['countryCode'], message: "the contact's country is not a two-letter code; pass countryCode explicitly" }]);
      countryCode = fromContact.data;
    }
  }

  const now = new Date();
  try {
    const row = await scope.db
      .insertInto('customer')
      .values({
        id: randomUUID(),
        tenant_id: scope.tenantId,
        contact_id: args.contactId,
        customer_type: args.customerType,
        vat_id: vatId,
        country_code: countryCode,
        tax_number: args.taxNumber ?? null,
        updated_at: now,
      })
      .returning(CUSTOMER_COLUMNS)
      .executeTakeFirstOrThrow();
    return mapCustomer(row);
  } catch (err) {
    if (sqlState(err) === '23505' && constraintName(err) === 'customer_tenant_id_contact_id_key') {
      throw new BooksError('DUPLICATE_CUSTOMER', 'DUPLICATE_CUSTOMER: this contact already is a customer', {
        contactId: args.contactId,
      });
    }
    throw err;
  }
}

const updateInput = z
  .object({
    customerType: z.enum(['b2c', 'b2b']).optional(),
    vatId: vatIdInput.nullable().optional(),
    countryCode: countryInput.optional(),
    taxNumber: taxNumberInput.nullable().optional(),
  })
  .strict();
export type UpdateCustomerTaxFieldsInput = z.input<typeof updateInput>;

/**
 * Change a customer's tax fields. Drafts pick the change up on their next
 * mutation or at issue (their stored tax profile key no longer matches).
 */
export async function updateCustomerTaxFields(
  scope: BooksScope,
  id: string,
  input: UpdateCustomerTaxFieldsInput,
): Promise<Customer> {
  const parsed = updateInput.safeParse(input);
  if (!parsed.success) throw invalid('INVALID_INPUT', parsed.error.issues);
  const args = parsed.data;
  const row = await withDbErrors(() =>
    scope.db
      .updateTable('customer')
      .set({
        ...(args.customerType !== undefined ? { customer_type: args.customerType } : {}),
        ...(args.vatId !== undefined ? { vat_id: args.vatId } : {}),
        ...(args.countryCode !== undefined ? { country_code: args.countryCode } : {}),
        ...(args.taxNumber !== undefined ? { tax_number: args.taxNumber } : {}),
        updated_at: new Date(),
      })
      .where('tenant_id', '=', scope.tenantId)
      .where('id', '=', id)
      .returning(CUSTOMER_COLUMNS)
      .executeTakeFirst(),
  );
  if (!row) throw new BooksError('NOT_FOUND', 'NOT_FOUND: customer', { customerId: id });
  return mapCustomer(row);
}

/** Archive a customer (it can no longer be put on a draft). Idempotent. */
export async function archiveCustomer(scope: BooksScope, id: string): Promise<Customer> {
  const row = await scope.db
    .updateTable('customer')
    .set((eb) => ({ archived_at: eb.fn.coalesce('archived_at', eb.val(new Date())), updated_at: new Date() }))
    .where('tenant_id', '=', scope.tenantId)
    .where('id', '=', id)
    .returning(CUSTOMER_COLUMNS)
    .executeTakeFirst();
  if (!row) throw new BooksError('NOT_FOUND', 'NOT_FOUND: customer', { customerId: id });
  return mapCustomer(row);
}

export async function getCustomer(scope: BooksScope, id: string): Promise<Customer> {
  const row = await selectCustomerRow(scope.db, scope, id);
  if (!row) throw new BooksError('NOT_FOUND', 'NOT_FOUND: customer', { customerId: id });
  return mapCustomer(row);
}

const listInput = z.object({
  includeArchived: z.boolean().default(false),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).optional(),
});
export type ListCustomersInput = z.input<typeof listInput>;

/** The company's customers, by id, with a keyset cursor (the last id of the page). */
export async function listCustomers(
  scope: BooksScope,
  input: ListCustomersInput = {},
): Promise<{ items: Customer[]; nextCursor: string | null; total: number }> {
  const parsed = listInput.safeParse(input);
  if (!parsed.success) throw invalid('INVALID_INPUT', parsed.error.issues);
  const args = parsed.data;
  let q = scope.db.selectFrom('customer').select(CUSTOMER_COLUMNS).where('tenant_id', '=', scope.tenantId);
  let count = scope.db.selectFrom('customer').select((eb) => eb.fn.countAll<string>().as('n')).where('tenant_id', '=', scope.tenantId);
  if (!args.includeArchived) {
    q = q.where('archived_at', 'is', null);
    count = count.where('archived_at', 'is', null);
  }
  if (args.cursor) q = q.where('id', '>', args.cursor);
  const [rows, counted] = await Promise.all([q.orderBy('id').limit(args.limit + 1).execute(), count.executeTakeFirstOrThrow()]);
  const page = rows.slice(0, args.limit);
  return {
    total: Number(counted.n),
    items: page.map(mapCustomer),
    nextCursor: rows.length > args.limit ? (page[page.length - 1]?.id ?? null) : null,
  };
}

/** The company's customers among `ids` (unknown and foreign ids are simply absent). */
export async function getCustomers(scope: BooksScope, ids: readonly string[]): Promise<Customer[]> {
  if (ids.length === 0) return [];
  const rows = await scope.db
    .selectFrom('customer')
    .select(CUSTOMER_COLUMNS)
    .where('tenant_id', '=', scope.tenantId)
    .where('id', 'in', [...new Set(ids)])
    .execute();
  return rows.map(mapCustomer);
}

/** The company's customers (archived included) for the given contact ids. */
export async function customersByContactIds(scope: BooksScope, contactIds: readonly string[]): Promise<Customer[]> {
  if (contactIds.length === 0) return [];
  const rows = await scope.db
    .selectFrom('customer')
    .select(CUSTOMER_COLUMNS)
    .where('tenant_id', '=', scope.tenantId)
    .where('contact_id', 'in', [...new Set(contactIds)])
    .execute();
  return rows.map(mapCustomer);
}
