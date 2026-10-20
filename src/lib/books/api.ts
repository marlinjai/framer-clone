// src/lib/books/api.ts
//
// The Books area's client for /api/books/* (Books plan phase 2). Client-safe:
// plain fetch, no server imports. Every call answers either the parsed body or
// a BooksApiError carrying the server's code and a sentence a person can act
// on, so no screen ever shows a bare status number or swallows a failure.

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
  customerId?: string | null;
}

export interface CustomerView {
  id: string;
  contactId: string;
  customerType: 'b2c' | 'b2b';
  vatId: string | null;
  countryCode: string;
  taxNumber: string | null;
  archivedAt: string | null;
  contact: ContactLabel | null;
  contactStatus: 'ok' | 'missing' | 'unavailable';
  drift: Array<'vatId' | 'countryCode'>;
}

export interface LineView {
  id: string;
  position: number;
  kind: 'service' | 'product' | 'text';
  title: string;
  description: string | null;
  quantity: number;
  unitLabel: string;
  unitPrice: number;
  discountBp: number;
  subtotal: number;
  taxClass: 'standard' | 'reduced' | 'zero' | null;
  taxRateOverride: number | null;
  taxRate: number;
  taxAmount: number;
  taxTreatment: string | null;
  updatedAt: string;
}

export interface DocumentView {
  id: string;
  docType: 'invoice' | 'credit_note' | 'offer';
  status: 'draft' | 'issued' | 'sent' | 'accepted' | 'rejected' | 'paid' | 'cancelled';
  version: number;
  customerId: string | null;
  templateId: string | null;
  correctsDocumentId: string | null;
  documentNumber: string | null;
  issueDate: string | null;
  serviceDate: string | null;
  servicePeriodStart: string | null;
  servicePeriodEnd: string | null;
  dueDate: string | null;
  paymentTermsDays: number;
  netOrGross: 'net' | 'gross';
  kleinunternehmer: boolean;
  reverseCharge: boolean;
  taxNote: string | null;
  taxProfileKey: string | null;
  subtotal: number;
  taxAmount: number;
  total: number;
  taxSummary: Array<{ taxRate: number; taxTreatment: string; net: number; tax: number }>;
  introText: string | null;
  outroText: string | null;
  renderedPdfFileId: string | null;
  customerSnapshot: { name: string; addressLine1: string; postalCode: string; city: string; country: string } | null;
}

export interface DocumentDetail {
  document: DocumentView;
  lines: LineView[];
  events: Array<{ id: string; eventType: string; createdAt: string }>;
  stale: boolean;
  customer: CustomerView | null;
}

export interface DocumentListItem {
  id: string;
  docType: DocumentView['docType'];
  status: DocumentView['status'];
  documentNumber: string | null;
  issueDate: string | null;
  dueDate: string | null;
  total: number;
  customerName: string | null;
  contactStatus: 'ok' | 'missing' | 'unavailable' | 'none';
  correctsDocumentId: string | null;
  createdAt: string;
}

export interface TemplateView {
  id: string;
  name: string;
  isDefault: boolean;
  accentColor: string | null;
  footerBlocks: Array<{ heading?: string | null; text: string }>;
  defaultIntroText: string | null;
  defaultOutroText: string | null;
}

export interface SettingsView {
  initialised: boolean;
  settings: {
    taxStatus: 'small_business' | 'regular';
    exemptionNote: string;
    senderBlock: Record<string, string | null>;
    defaultPaymentTermsDays: number;
  } | null;
  counters: Array<{ docType: string; format: string; nextValue: number; nextNumber: string }>;
}

/** What the server said, in words a person can act on. */
const MESSAGES: Record<string, string> = {
  unauthorized: 'Your session has ended. Sign in again.',
  books_not_enabled: 'The Books are not enabled for this company.',
  sites_not_enabled: 'Lumitra Sites is not enabled for this company.',
  no_active_company: 'Choose a company on the projects page first.',
  forbidden: 'You need to be an administrator of this company to use the Books.',
  books_not_provisioned: 'The Books are not set up for this company yet.',
  books_not_initialised: 'The Books are not set up for this company yet (sender, tax status and number series).',
  auth_unavailable: 'The sign-in service is not answering. Try again in a moment.',
  authz_unavailable: 'The permission service is not answering. Try again in a moment.',
  recipient_unavailable: 'The contacts database is not answering. Nothing was changed; try again in a moment.',
  concurrent_edit: 'This invoice was changed in another window. It has been reloaded; check it and try again.',
  not_draft: 'This document is no longer a draft and cannot be changed.',
  customer_required: 'Pick a customer before issuing.',
  no_billable_lines: 'Add at least one line with a quantity before issuing.',
  service_date_required: 'Enter a service date or period before issuing.',
  recipient_incomplete: 'The customer’s address is incomplete in the contacts database.',
  recipient_archived: 'The customer’s contact is archived. Restore it in the contacts app or pick another customer.',
  sender_incomplete: 'The company’s sender details are incomplete (name, address and a tax number are required).',
  duplicate_customer: 'This contact is already a customer.',
  duplicate_contact: 'A contact with this name already exists. Search for it instead.',
  template_in_use: 'Documents use this template, so it cannot be deleted.',
  render_incomplete: 'The PDF would be missing a required field; nothing was issued or stored.',
  undrawable_text: 'Some characters cannot be printed in the invoice font. Change these fields; nothing was issued.',
  tax_case_unsupported: 'Invoices to recipients outside the EU are not supported yet under regular taxation.',
  issue_date_out_of_order: 'The issue date is earlier than the last issued invoice.',
};

export class BooksApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'BooksApiError';
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
  } catch {
    throw new BooksApiError(0, 'network', 'The server could not be reached. Check your connection and try again.');
  }
  if (res.status === 204) return undefined as T;
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    // fall through: a non-JSON answer is reported by status below
  }
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string; [k: string]: unknown } } | null)?.error;
    const code = err?.code ?? `http_${res.status}`;
    const named = Array.isArray(err?.missing) ? err!.missing : Array.isArray(err?.fields) ? err!.fields : null;
    const missing = named ? ` (${(named as string[]).join(', ')})` : '';
    throw new BooksApiError(
      res.status,
      code,
      (MESSAGES[code] ?? err?.message ?? `The request failed (${res.status}).`) + missing,
      err ?? {},
    );
  }
  return json as T;
}

export const booksApi = {
  settings: () => request<SettingsView>('GET', '/api/books/settings'),
  customers: (includeArchived = false) =>
    request<{ items: CustomerView[] }>('GET', `/api/books/customers${includeArchived ? '?includeArchived=1' : ''}`),
  createCustomer: (body: unknown) => request<CustomerView>('POST', '/api/books/customers', body),
  updateCustomer: (id: string, body: unknown) => request<CustomerView>('PATCH', `/api/books/customers/${id}`, body),
  archiveCustomer: (id: string) => request<CustomerView>('DELETE', `/api/books/customers/${id}`),
  searchContacts: (search: string) =>
    request<{ items: ContactLabel[] }>('GET', `/api/books/contacts?search=${encodeURIComponent(search)}`),
  documents: (status?: string) =>
    request<{ items: DocumentListItem[] }>('GET', `/api/books/documents${status ? `?status=${status}` : ''}`),
  createDraft: (body: unknown = {}) => request<DocumentDetail>('POST', '/api/books/documents', body),
  document: (id: string) => request<DocumentDetail>('GET', `/api/books/documents/${id}`),
  updateDraft: (id: string, body: unknown) => request<DocumentDetail>('PATCH', `/api/books/documents/${id}`, body),
  setCustomer: (id: string, customerId: string, expectedVersion: number) =>
    request<DocumentDetail>('PUT', `/api/books/documents/${id}/customer`, { customerId, expectedVersion }),
  addLine: (id: string, body: unknown) => request<DocumentDetail>('POST', `/api/books/documents/${id}/lines`, body),
  updateLine: (id: string, lineId: string, body: unknown) =>
    request<DocumentDetail>('PATCH', `/api/books/documents/${id}/lines/${lineId}`, body),
  removeLine: (id: string, lineId: string, expectedVersion: number) =>
    request<DocumentDetail>('DELETE', `/api/books/documents/${id}/lines/${lineId}?expectedVersion=${expectedVersion}`),
  reorderLines: (id: string, lineIds: string[], expectedVersion: number) =>
    request<DocumentDetail>('POST', `/api/books/documents/${id}/lines/reorder`, { lineIds, expectedVersion }),
  issue: (id: string, expectedVersion: number) =>
    request<{ document: DocumentDetail; alreadyIssued: boolean; render: { stored: boolean } }>(
      'POST',
      `/api/books/documents/${id}/issue`,
      { expectedVersion },
    ),
  cancel: (id: string, reason: string) =>
    request<{ invoice: DocumentDetail; creditNote: DocumentDetail; alreadyCancelled: boolean }>(
      'POST',
      `/api/books/documents/${id}/cancel`,
      { reason },
    ),
  templates: () => request<{ items: TemplateView[] }>('GET', '/api/books/templates'),
  createTemplate: (body: unknown) => request<TemplateView>('POST', '/api/books/templates', body),
  updateTemplate: (id: string, body: unknown) => request<TemplateView>('PATCH', `/api/books/templates/${id}`, body),
  deleteTemplate: (id: string) => request<void>('DELETE', `/api/books/templates/${id}`),
};

/** The download URL of a document's PDF (the stored one when issued, a preview for a draft). */
export function pdfUrl(id: string): string {
  return `/api/books/documents/${id}/pdf`;
}

export const STATUS_LABELS: Record<DocumentView['status'], string> = {
  draft: 'Draft',
  issued: 'Issued',
  sent: 'Sent',
  accepted: 'Accepted',
  rejected: 'Rejected',
  paid: 'Paid',
  cancelled: 'Cancelled',
};

export const TYPE_LABELS: Record<DocumentView['docType'], string> = {
  invoice: 'Invoice',
  credit_note: 'Credit note',
  offer: 'Offer',
};
