import 'server-only';

// src/server/books/http/views.ts
//
// The JSON the Books routes answer, built from the repository's domain shapes
// plus the labels from the shared contacts database (Books plan P1.2: the
// customer row is authoritative for tax, the contact for name and address).
//
// A label is best effort and says so: when the contacts database cannot be
// read, the lists still answer (their figures come from the Books tables) with
// `contactStatus: 'unavailable'`, and the editor shows that instead of a name.
// Issuing never relies on a label; it reads the contact itself and refuses
// when it cannot (RECIPIENT_UNAVAILABLE).
//
// Drift (P1.12 item 6): when the contact's VAT id or country differs from the
// customer's tax fields, the customer view names the differing fields, so the
// editor can show both values; nothing is reconciled silently.

import { isBooksError } from '../errors';
import type { ContactBook } from '../contactBook';
import type { Customer } from '../repository/customers';
import type { DocumentView, SalesDocument, SalesDocumentListItem } from '../repository/read';
import type { RecipientContact } from '../snapshots';

export type ContactStatus = 'ok' | 'missing' | 'unavailable';

/** The contact fields the editor shows (the user's own data, never logged). */
export interface ContactLabel {
  id: string;
  kind: string;
  name: string;
  companyOrRole: string;
  legalForm: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  postalCode: string | null;
  city: string | null;
  country: string | null;
  vatId: string | null;
  customerNumber: string | null;
  archived: boolean;
}

export interface CustomerView extends Customer {
  contact: ContactLabel | null;
  contactStatus: ContactStatus;
  /** Tax fields whose contact value differs from the customer row. */
  drift: Array<'vatId' | 'countryCode'>;
}

export function contactLabel(c: RecipientContact): ContactLabel {
  return {
    id: c.id,
    kind: c.kind,
    name: c.name,
    companyOrRole: c.companyOrRole,
    legalForm: c.legalForm,
    addressLine1: c.addressLine1,
    addressLine2: c.addressLine2,
    postalCode: c.postalCode,
    city: c.city,
    country: c.country,
    vatId: c.vatId,
    customerNumber: c.customerNumber === null ? null : String(c.customerNumber),
    archived: c.archived,
  };
}

function normVat(v: string | null | undefined): string {
  return (v ?? '').replace(/\s+/g, '').toUpperCase();
}

function driftOf(customer: Customer, contact: RecipientContact | null): Array<'vatId' | 'countryCode'> {
  if (!contact) return [];
  const drift: Array<'vatId' | 'countryCode'> = [];
  if (normVat(contact.vatId) !== normVat(customer.vatId)) drift.push('vatId');
  const country = (contact.country ?? '').trim().toUpperCase();
  if (country !== '' && country !== customer.countryCode) drift.push('countryCode');
  return drift;
}

/**
 * The contacts of `contactIds` for the company, by id; `null` when the contacts
 * database could not be read (every other error propagates).
 */
export async function contactsById(
  book: ContactBook,
  tenantId: string,
  contactIds: readonly string[],
): Promise<Map<string, RecipientContact> | null> {
  const unique = [...new Set(contactIds)];
  try {
    const rows = await book.getMany(tenantId, unique);
    return new Map(rows.map((c) => [c.id, c]));
  } catch (err) {
    if (isBooksError(err, 'RECIPIENT_UNAVAILABLE')) {
      console.error('[books] contacts database unavailable while labelling', (err as Error).cause ?? err);
      return null;
    }
    throw err;
  }
}

export function customerView(customer: Customer, contacts: Map<string, RecipientContact> | null): CustomerView {
  if (contacts === null) return { ...customer, contact: null, contactStatus: 'unavailable', drift: [] };
  const contact = contacts.get(customer.contactId) ?? null;
  return {
    ...customer,
    contact: contact ? contactLabel(contact) : null,
    contactStatus: contact ? 'ok' : 'missing',
    drift: driftOf(customer, contact),
  };
}

export async function customerViews(
  book: ContactBook,
  tenantId: string,
  customers: readonly Customer[],
): Promise<CustomerView[]> {
  const contacts = await contactsById(
    book,
    tenantId,
    customers.map((c) => c.contactId),
  );
  return customers.map((c) => customerView(c, contacts));
}

/** One row of the documents list. */
export interface DocumentListItem {
  id: string;
  docType: SalesDocument['docType'];
  status: SalesDocument['status'];
  documentNumber: string | null;
  issueDate: string | null;
  dueDate: string | null;
  total: number;
  currencyCode: string;
  customerId: string | null;
  /**
   * The recipient's name: for an issued document the name it was issued to
   * (frozen snapshot), for a draft the customer's current contact name; null
   * when unknown (see `contactStatus`).
   */
  customerName: string | null;
  contactStatus: ContactStatus | 'none';
  correctsDocumentId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export function documentListItem(
  doc: SalesDocument & { recipientName?: string | null },
  customerContact: Map<string, string>,
  contactsReadable: boolean,
): DocumentListItem {
  if (doc.recipientName) {
    return { ...listFields(doc), customerName: doc.recipientName, contactStatus: 'ok' };
  }
  const name = doc.customerId ? (customerContact.get(doc.customerId) ?? null) : null;
  return {
    ...listFields(doc),
    customerName: name,
    contactStatus: !doc.customerId ? 'none' : !contactsReadable ? 'unavailable' : name ? 'ok' : 'missing',
  };
}

function listFields(doc: SalesDocument): Omit<DocumentListItem, 'customerName' | 'contactStatus'> {
  return {
    id: doc.id,
    docType: doc.docType,
    status: doc.status,
    documentNumber: doc.documentNumber,
    issueDate: doc.issueDate,
    dueDate: doc.dueDate,
    total: doc.total,
    currencyCode: doc.currencyCode,
    customerId: doc.customerId,
    correctsDocumentId: doc.correctsDocumentId,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/** A document as the editor reads it: the repository view plus the customer label. */
export interface DocumentDetail extends DocumentView {
  customer: CustomerView | null;
}

/**
 * The document detail the editor renders: the repository view (recomputed in
 * memory when stale) plus the current customer label. An issued document's
 * recipient is its frozen `customerSnapshot`; the label is only context.
 */
export async function documentDetail(
  book: ContactBook,
  tenantId: string,
  view: DocumentView,
  loadCustomer: (id: string) => Promise<Customer>,
): Promise<DocumentDetail> {
  const customerId = view.document.customerId;
  if (!customerId) return { ...view, customer: null };
  const customer = await loadCustomer(customerId);
  const [label] = await customerViews(book, tenantId, [customer]);
  return { ...view, customer: label ?? null };
}

/** Label a page of documents with their customers' current contact names. */
export async function documentListItems(
  book: ContactBook,
  tenantId: string,
  docs: readonly SalesDocumentListItem[],
  loadCustomers: (ids: string[]) => Promise<Customer[]>,
): Promise<DocumentListItem[]> {
  // Issued documents carry their frozen recipient name; only drafts need the contacts database.
  const customerIds = [
    ...new Set(docs.filter((d) => !d.recipientName).map((d) => d.customerId).filter((x): x is string => x !== null)),
  ];
  const customers = customerIds.length > 0 ? await loadCustomers(customerIds) : [];
  const contacts = await contactsById(
    book,
    tenantId,
    customers.map((c) => c.contactId),
  );
  const names = new Map<string, string>();
  if (contacts) {
    for (const c of customers) {
      const contact = contacts.get(c.contactId);
      if (contact) names.set(c.id, contact.name);
    }
  }
  return docs.map((d) => documentListItem(d, names, contacts !== null));
}
