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
  /** `import` for the historical invoices: their stored original PDF is the document of record. */
  source: 'editor' | 'import';
  /** ISO 4217; EUR except on an imported invoice printed in another currency (never converted). */
  currencyCode: string;
  version: number;
  customerId: string | null;
  templateId: string | null;
  correctsDocumentId: string | null;
  /** The issued invoice this draft or invoice replaces (the Correct flow). */
  replacesDocumentId: string | null;
  printReplacesReference: boolean;
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

/** A short reference to a linked document. */
export interface DocumentRef {
  id: string;
  docType: DocumentView['docType'];
  status: DocumentView['status'];
  documentNumber: string | null;
  issueDate: string | null;
}

export interface DocumentDetail {
  document: DocumentView;
  lines: LineView[];
  events: Array<{ id: string; eventType: string; createdAt: string }>;
  /** The credit note chain and the Correct flow. */
  related: {
    corrects: DocumentRef | null;
    correctedBy: DocumentRef | null;
    replaces: DocumentRef | null;
    replacedBy: DocumentRef | null;
  };
  stale: boolean;
  customer: CustomerView | null;
}

export interface DocumentListItem {
  id: string;
  docType: DocumentView['docType'];
  status: DocumentView['status'];
  source: DocumentView['source'];
  currencyCode: string;
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
  /** The current version (the composer of phase 4 edits its document). */
  currentVersionId: string;
  version: number;
  document: unknown;
  /** The current version's accent colour and small print, as the templates form edits them. */
  accentColor: string;
  footerBlocks: Array<{ heading?: string | null; text: string }>;
  defaultIntroText: string | null;
  defaultOutroText: string | null;
}

/** One saved version of a template (the composer's version list). */
export interface TemplateVersionView {
  id: string;
  version: number;
  createdAt: string;
  current: boolean;
  /** Issued documents frozen with this version. */
  documentCount: number;
}

/** What the template preview renders: a fictional sample, or one of the company's documents. */
export type PreviewSubject = { kind: 'sample'; variant: string } | { kind: 'document'; documentId: string };

/** One reason a template cannot be saved (the save gate's answer, also sent with every preview). */
export interface TemplateProblemView {
  code: string;
  message: string;
  region?: string;
  blockId?: string;
  field?: string;
  probe?: string;
}

/** A block's place on a preview page: points from the page's left and top edge. */
export interface LayoutRectView {
  blockId: string;
  region: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutMapView {
  page: { width: number; height: number };
  pageCount: number;
  blocks: LayoutRectView[];
  tables: Array<{ blockId: string; columns: Partial<Record<string, { x: number; width: number }>> }>;
  issues: Array<{ code: string; blockId: string | null; region: string }>;
}

export interface TemplatePreview {
  /** The PDF, base64. */
  pdf: string;
  layout: LayoutMapView;
  renderMs: number;
  problems: TemplateProblemView[];
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
  template_in_use: 'Drafts use this template, so it cannot be removed. Issue or delete those drafts, or give them another template, first.',
  template_invalid: 'The template cannot be saved:',
  render_incomplete: 'The PDF would be missing a required field; nothing was issued or stored.',
  undrawable_text: 'Some characters cannot be printed in the invoice font. Change these fields; nothing was issued.',
  tax_case_unsupported: 'Invoices to recipients outside the EU are not supported yet under regular taxation.',
  issue_date_out_of_order: 'The issue date is earlier than the last issued document of its series (invoice or credit note).',
  not_correctable:
    'Only an issued invoice made here that is not cancelled can be corrected. Cancel an imported invoice with a credit note and create a new one.',
  replacement_incomplete:
    'The corrected invoice could not be issued together with the cancellation of the old one. Nothing was issued; reload and try again.',
  replaced_invoice_cancelled:
    'The invoice this draft replaces was cancelled in the meantime. Issue this draft as an ordinary invoice instead.',
  extract_busy: 'Four invoices are being read for this company right now. The rest follow automatically.',
  import_limit: 'The daily limit of invoices read for this company is reached. Try again tomorrow.',
  extraction_running: 'This invoice is being read already.',
  stale_extraction: 'This invoice was read again meanwhile. The table shows the new reading; check it again.',
  import_not_ready: 'This row has a problem to fix before it can be imported.',
  reading_would_be_replaced: 'This row holds what you entered. Open it with "Check" and use "Read again with AI" there to replace it with a new reading.',
  counter_raise_unconfirmed: 'The invoice number this import would set has changed. Check the row again and confirm the new value.',
  file_too_large: 'The file is larger than 10 MB.',
  upload_truncated: 'The file did not arrive whole. Upload it again.',
  missing_anthropic_key: 'Reading invoices is not set up on this server (no AI key). Ask an administrator.',
  extract_model_unknown: 'Reading invoices is not set up on this server (unknown model). Ask an administrator.',
  asset_too_large: 'The logo is larger than 1 MB. Save it smaller and upload it again.',
  unsupported_asset_type: 'A logo must be a PNG or a JPEG file. Convert it and upload it again.',
  asset_invalid: 'The logo cannot be used:',
  logo_asset_missing: 'The template’s logo is not stored for this company. Choose the logo in the template again; nothing was issued.',
  asset_limit: 'This company already stores the most logos allowed. Choose one of them.',
  asset_not_found: 'This logo is not stored for this company.',
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

async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      signal,
    });
  } catch (err) {
    // A request the caller aborted (a newer preview replaced it) is not a network failure.
    if (signal?.aborted) throw err;
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
    const problems = Array.isArray(err?.problems)
      ? (err!.problems as Array<{ message?: unknown }>).map((p) => (typeof p.message === 'string' ? p.message : '')).filter(Boolean)
      : null;
    const missing = problems ? ` ${problems.join('; ')}.` : named ? ` (${(named as string[]).join(', ')})` : '';
    throw new BooksApiError(
      res.status,
      code,
      (MESSAGES[code] ?? err?.message ?? `The request failed (${res.status}).`) + missing,
      err ?? {},
    );
  }
  return json as T;
}

/** One page of a cursor-paged list: `nextCursor` (null on the last page) fetches the next; `total` counts every match. */
export interface ListPage<T> {
  items: T[];
  nextCursor: string | null;
  total: number;
}

/** A query string from the given values, empty ones left out. */
function query(values: Record<string, string | null | undefined>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(values)) if (v !== undefined && v !== null && v !== '') params.set(k, v);
  const text = params.toString();
  return text === '' ? '' : `?${text}`;
}

export const booksApi = {
  settings: () => request<SettingsView>('GET', '/api/books/settings'),
  /** One page of customers (100 a page); `nextCursor` fetches the next, `total` counts them all. */
  customers: (opts: { includeArchived?: boolean; cursor?: string | null } = {}) =>
    request<ListPage<CustomerView>>('GET', `/api/books/customers${query({ includeArchived: opts.includeArchived ? '1' : undefined, cursor: opts.cursor })}`),
  /** Every customer, page by page (for pickers that must offer all of them). */
  allCustomers: async (opts: { includeArchived?: boolean } = {}): Promise<CustomerView[]> => {
    const out: CustomerView[] = [];
    let cursor: string | null = null;
    // Bounded: 100 pages of 100 is far beyond any company; a cursor that never ends must not loop forever.
    for (let i = 0; i < 100; i += 1) {
      const page: ListPage<CustomerView> = await booksApi.customers({ ...opts, cursor });
      out.push(...page.items);
      cursor = page.nextCursor;
      if (!cursor) return out;
    }
    throw new BooksApiError(500, 'list_too_long', 'The customer list did not end; reload the page.');
  },
  createCustomer: (body: unknown) => request<CustomerView>('POST', '/api/books/customers', body),
  updateCustomer: (id: string, body: unknown) => request<CustomerView>('PATCH', `/api/books/customers/${id}`, body),
  archiveCustomer: (id: string) => request<CustomerView>('DELETE', `/api/books/customers/${id}`),
  searchContacts: (search: string) =>
    request<{ items: ContactLabel[] }>('GET', `/api/books/contacts?search=${encodeURIComponent(search)}`),
  /** One page of documents (50 a page), optionally by number (contains) and issue year. */
  documents: (opts: { status?: string; number?: string; year?: string; cursor?: string | null } = {}) =>
    request<ListPage<DocumentListItem>>('GET', `/api/books/documents${query(opts)}`),
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
    request<{
      document: DocumentDetail;
      alreadyIssued: boolean;
      replaced?: { invoiceId: string; creditNoteId: string };
      render: { stored: boolean };
    }>(
      'POST',
      `/api/books/documents/${id}/issue`,
      { expectedVersion },
    ),
  /** Korrigieren: the replacement draft of an issued invoice (created, or the existing one). */
  correct: (id: string) =>
    request<{ document: DocumentDetail; existing: boolean }>('POST', `/api/books/documents/${id}/correct`, {}),
  cancel: (id: string, reason: string) =>
    request<{ invoice: DocumentDetail; creditNote: DocumentDetail; alreadyCancelled: boolean }>(
      'POST',
      `/api/books/documents/${id}/cancel`,
      { reason },
    ),
  template: (id: string) => request<TemplateView>('GET', `/api/books/templates/${id}`),
  templateVersions: (id: string) => request<{ items: TemplateVersionView[] }>('GET', `/api/books/templates/${id}/versions`),
  /** The composer's live preview of an unsaved layout (never stored); `signal` aborts a superseded one. */
  previewTemplate: (body: { document: unknown; subject: PreviewSubject }, signal?: AbortSignal) =>
    request<TemplatePreview>('POST', '/api/books/templates/preview', body, signal),
  templates: () => request<{ items: TemplateView[] }>('GET', '/api/books/templates'),
  createTemplate: (body: unknown) => request<TemplateView>('POST', '/api/books/templates', body),
  updateTemplate: (id: string, body: unknown) => request<TemplateView>('PATCH', `/api/books/templates/${id}`, body),
  deleteTemplate: (id: string) => request<void>('DELETE', `/api/books/templates/${id}`),
  /** Upload a logo (PNG or JPEG, at most 1 MB and 2000 px on the longer side); the same file again answers the stored one. */
  uploadAsset: (file: Blob) => uploadAsset(file),
  /** The URL of a stored logo by its hash (an <img> source). */
  assetUrl: (sha256: string) => `/api/books/assets/${sha256}`,
};

/** A stored logo, as the upload answers it. */
export interface AssetView {
  sha256: string;
  contentType: 'image/png' | 'image/jpeg';
  byteSize: number;
  widthPx: number;
  heightPx: number;
}

/** Send a logo as the raw request body with its own type; the server checks the bytes. */
async function uploadAsset(file: Blob): Promise<AssetView> {
  let res: Response;
  try {
    res = await fetch('/api/books/assets', {
      method: 'POST',
      // The server checks the bytes; `image/jpg` (sent by some systems) is the same as image/jpeg.
      headers: { 'content-type': file.type === 'image/jpg' ? 'image/jpeg' : file.type || 'application/octet-stream' },
      body: file,
      cache: 'no-store',
    });
  } catch {
    throw new BooksApiError(0, 'network', 'The logo could not be sent. Check your connection and try again.');
  }
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    // reported by status below
  }
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string } } | null)?.error;
    const code = err?.code ?? `http_${res.status}`;
    // asset_invalid names the reason (undecodable, not embeddable, too many pixels): show it after the sentence.
    const limit = (err as { maxAssets?: unknown } | undefined)?.maxAssets;
    const message =
      code === 'asset_invalid' && err?.message
        ? `${MESSAGES[code]} ${err.message}.`
        : code === 'asset_limit' && typeof limit === 'number'
          ? `This company already stores ${limit} logos, the most allowed. Choose one of them.`
          : (MESSAGES[code] ?? err?.message ?? `The upload failed (${res.status}).`);
    throw new BooksApiError(res.status, code, message, err ?? {});
  }
  if (json === null) throw new BooksApiError(res.status, 'bad_response', 'The server’s answer could not be read. Upload the logo again.');
  return json as AssetView;
}

// --- the upload import of past invoices (/api/books/imports) -------------------------

export type ImportStatus = 'uploaded' | 'extracting' | 'ready' | 'needs_attention' | 'imported' | 'discarded';

/** One named problem of a staged row (codes and paths, never values). */
export interface ImportProblem {
  code: string;
  path: string | null;
  blocking: boolean;
  count: number | null;
}

/** One staged past invoice as the review table shows it. */
export interface ImportItemView {
  id: string;
  fileName: string;
  byteSize: number;
  status: ImportStatus;
  version: number;
  extractionId: string | null;
  /** The printed invoice the row stands for now (the correction, else what was read). */
  printed: PrintedInvoice | null;
  extractedPrinted: PrintedInvoice | null;
  confidence: Record<string, 'high' | 'medium' | 'low'>;
  corrected: boolean;
  problems: ImportProblem[];
  extractionError: string | null;
  model: string | null;
  documentId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A printed invoice as read from a PDF (amounts in the printed currency, dot decimals). */
export interface PrintedInvoice {
  number: string | number | null;
  issueDate: string | null;
  serviceDate: string | null;
  servicePeriod: string | null;
  recipient: {
    name: string;
    addressLines: string[];
    country: string | null;
    countryInferred?: string | null;
    customerNumber: string | null;
  } | null;
  recipientVatId: string | null;
  sender: {
    name: string;
    addressLines: string[];
    country: string | null;
    taxNumber?: string | null;
    vatId?: string | null;
    taxNumberPresent?: boolean;
    vatIdPresent?: boolean;
  } | null;
  lines: PrintedLine[];
  total: number | null;
  currency: string | null;
  taxTreatment: string | null;
  taxAmounts: Array<{ rate: number; net: number | null; tax: number }>;
  pricesIncludeVat: boolean;
  taxNote: string | null;
  paymentTerms: string | null;
  [key: string]: unknown;
}

export interface PrintedLine {
  description: string;
  quantity: number | null;
  unit: string | null;
  unitPrice: number | null;
  discount: string | null;
  lineTotal: number;
  taxRate: number | null;
  taxAmount: number | null;
}

export interface ImportList {
  /** Every open row, then the newest imported ones. */
  items: ImportItemView[];
  /** How many rows are imported in all (the list shows the newest of them). */
  importedTotal: number;
  counter: { format: string; nextValue: number } | null;
  /** `perDay` is null when the server's setting is not valid (reading is refused until it is fixed). */
  limits: { maxFileBytes: number; maxFilesAtOnce: number; parallel: number; perDay: number | null };
}

export type UploadResult =
  | { status: 'staged'; item: ImportItemView }
  | { status: 'duplicate'; item: ImportItemView | null; documentId: string | null };

/** Upload one PDF as the request body (one request per file). */
async function uploadPdf(file: File): Promise<UploadResult> {
  let res: Response;
  try {
    res = await fetch('/api/books/imports', {
      method: 'POST',
      headers: { 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent(file.name) },
      body: file,
      cache: 'no-store',
    });
  } catch {
    throw new BooksApiError(0, 'network', 'The file could not be sent. Check your connection and try again.');
  }
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    // reported by status below
  }
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string } } | null)?.error;
    const code = err?.code ?? `http_${res.status}`;
    throw new BooksApiError(res.status, code, MESSAGES[code] ?? err?.message ?? `The upload failed (${res.status}).`, err ?? {});
  }
  return json as UploadResult;
}

export const importsApi = {
  list: () => request<ImportList>('GET', '/api/books/imports'),
  upload: uploadPdf,
  /** `replace`: read again although the row holds what the user typed or corrected (the user asked for it). */
  extract: (id: string, replace = false) => request<ImportItemView>('POST', `/api/books/imports/${id}/extract${replace ? '?replace=1' : ''}`),
  correct: (id: string, printed: PrintedInvoice, extractionId: string, expectedVersion: number) =>
    request<ImportItemView>('PATCH', `/api/books/imports/${id}`, { printed, extractionId, expectedVersion }),
  recheck: (id: string) => request<ImportItemView>('POST', `/api/books/imports/${id}/recheck`),
  /** An empty manual reading for a row the AI could not read, to fill in by hand. */
  byHand: (id: string, expectedVersion: number) => request<ImportItemView>('POST', `/api/books/imports/${id}/by-hand`, { expectedVersion }),
  /** `confirmCounterRaiseTo`: the new next invoice number the user was shown and confirmed (required when the import raises the counter). */
  confirm: (id: string, expectedVersion: number, confirmCounterRaiseTo: number | null = null) =>
    request<{ item: ImportItemView; documentId: string | null; counterRaisedTo: number | null }>(
      'POST',
      `/api/books/imports/${id}/confirm`,
      { expectedVersion, confirmCounterRaiseTo },
    ),
  confirmNumber: (id: string, documentNumber: string, expectedVersion: number) =>
    request<ImportItemView>('POST', `/api/books/imports/${id}/confirm-number`, { documentNumber, expectedVersion }),
  discard: (id: string) => request<ImportItemView>('POST', `/api/books/imports/${id}/discard`),
};

/** The URL of a staged row's PDF (shown beside the review form). */
export function importPdfUrl(id: string): string {
  return `/api/books/imports/${id}/pdf`;
}

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
