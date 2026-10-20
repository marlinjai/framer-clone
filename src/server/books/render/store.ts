// src/server/books/render/store.ts
//
// The render pipeline end to end (Books plan section 5, phase 3):
//
//   document -> render input -> render model -> PDF bytes -> completeness check
//            -> stored once as the document of record (issued documents only)
//
// ISSUED documents (invoices and credit notes, any status after draft) are
// rendered ONLY from their frozen data: the customer, sender and template
// snapshots, the stored lines and totals, and for a credit note the frozen
// number and date of the invoice it cancels. The contacts database, the
// customer row, the template table and the company setting are never read for
// them, so nothing changed after issue can change a re-render.
//
// The document of record is rendered, checked (every printed field drawable by
// the embedded fonts, every legally required field present in the drawn text)
// and stored INSIDE the issue or cancel transaction (`storeRenderedIn`, passed
// as their `beforeCommit`): a failure rolls the issue back, so the document
// stays a draft and no number is taken. `rendered_pdf_file_id` then points at
// the stored `sales_document_file`, set NULL to a value exactly once (the 007
// trigger). Downloads serve the stored bytes; a document issued before this
// existed is rendered and stored on its first download.
//
// IMPORTED documents (`source = 'import'`, the historical invoices) carry the
// original PDF as their stored file from the moment they exist (009 refuses
// the commit otherwise). They are never rendered: renderIssuedDocument refuses
// them with NOT_RENDERABLE, so a missing file would surface as an error, never
// as a drawn substitute.
//
// DRAFTS get a preview rendered from live data (the company's sender block, the
// customer's current contact), watermarked as a draft on every page, never
// checked as a document of record and never stored.

import { createHash, randomUUID } from 'node:crypto';

import type { Kysely, Transaction } from 'kysely';

import type { CommerceDB } from '../../commerce/db-types';
import { BooksError, withDbErrors } from '../errors';
import { readRecipient } from '../recipients';
import { getDocument, selectDocumentRow, type DocumentView } from '../repository/read';
import { selectCustomerRow } from '../repository/taxState';
import { templateSnapshotFor } from '../repository/templates';
import type { BooksScope } from '../scope';
import { readSettings } from '../settings';
import { missingFields } from './completeness';
import { assertDrawable, previewSafe } from './drawable';
import { extractPdfText } from './extractText';
import { fileNamePart } from './format';
import { buildRenderModel, type RenderInput, type RenderModel, type RenderRecipient } from './model';
import { RENDERER_ID, renderPdf } from './pdf';

type Db = Kysely<CommerceDB> | Transaction<CommerceDB>;

export interface RenderedPdf {
  bytes: Uint8Array;
  fileName: string;
  /** True for a stored document of record; false for a draft preview. */
  ofRecord: boolean;
  fileId: string | null;
  sha256: string;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function frozenTemplate(doc: DocumentView['document']): RenderInput['template'] {
  const t = doc.templateSnapshot;
  return t ? { accentColor: t.accentColor, footerBlocks: t.footerBlocks } : null;
}

/** The render input of an issued document: frozen data only. */
async function issuedInput(db: Db, scope: BooksScope, view: DocumentView): Promise<RenderInput> {
  const doc = view.document;
  if (!doc.senderSnapshot || !doc.customerSnapshot) {
    throw new BooksError('NOT_RENDERABLE', 'NOT_RENDERABLE: the document carries no snapshots', { documentId: doc.id });
  }
  let corrects: RenderInput['corrects'] = null;
  if (doc.correctsDocumentId) {
    // The cancelled invoice's number and date are frozen with it.
    const original = await selectDocumentRow(db, scope, doc.correctsDocumentId);
    if (original?.document_number && original.issue_date) {
      corrects = { documentNumber: original.document_number, issueDate: original.issue_date };
    }
  }
  const c = doc.customerSnapshot;
  return {
    draft: false,
    document: doc,
    lines: view.lines,
    sender: doc.senderSnapshot,
    recipient: {
      name: c.name,
      companyOrRole: c.companyOrRole,
      legalForm: c.legalForm,
      addressLine1: c.addressLine1,
      addressLine2: c.addressLine2,
      postalCode: c.postalCode,
      city: c.city,
      country: c.country,
      customerNumber: c.customerNumber,
      vatId: c.vatId,
    },
    corrects,
    template: frozenTemplate(doc),
  };
}

/** The render input of a draft preview: live data (never stored). */
async function draftInput(scope: BooksScope, view: DocumentView): Promise<RenderInput> {
  const doc = view.document;
  const settings = await readSettings(scope.db, scope);
  let recipient: RenderRecipient | null = null;
  if (doc.customerId) {
    const customer = await selectCustomerRow(scope.db, scope, doc.customerId);
    if (customer) {
      const contact = await readRecipient(scope, customer.contact_id);
      if (contact) {
        recipient = {
          name: contact.name,
          companyOrRole: contact.companyOrRole,
          legalForm: contact.legalForm,
          addressLine1: contact.addressLine1,
          addressLine2: contact.addressLine2,
          postalCode: contact.postalCode,
          city: contact.city,
          country: contact.country,
          customerNumber: contact.customerNumber,
          vatId: customer.vat_id,
        };
      }
    }
  }
  let template: RenderInput['template'] = null;
  if (doc.templateId) {
    const t = await templateSnapshotFor(scope.db, scope, doc.templateId);
    template = { accentColor: t.accentColor, footerBlocks: t.footerBlocks };
  }
  return { draft: true, document: doc, lines: view.lines, sender: settings?.senderBlock ?? null, recipient, corrects: null, template };
}

function fileNameFor(view: DocumentView, draft: boolean): string {
  const doc = view.document;
  const kind = doc.docType === 'credit_note' ? 'Gutschrift' : 'Rechnung';
  return draft ? `${kind}-Entwurf-${doc.id.slice(0, 8)}.pdf` : `${kind}-${fileNamePart(doc.documentNumber ?? doc.id)}.pdf`;
}

/** Test seam: replace the PDF writer (a broken one proves a failed check rolls the issue back). */
export interface RenderOptions {
  renderPdf?: (model: RenderModel) => Promise<Uint8Array>;
}

/**
 * Render an issued document from its frozen data, and check it: every printed
 * field drawable (UNDRAWABLE_TEXT otherwise), every legally required field in
 * the drawn text (RENDER_INCOMPLETE otherwise). Never stores.
 */
export async function renderIssuedDocument(
  scope: BooksScope,
  view: DocumentView,
  options: RenderOptions & { db?: Db } = {},
): Promise<Uint8Array> {
  if (view.document.status === 'draft') {
    throw new BooksError('NOT_RENDERABLE', 'NOT_RENDERABLE: a draft is previewed, not rendered', {
      documentId: view.document.id,
    });
  }
  if (view.document.source === 'import') {
    // The original PDF is the document of record of an imported invoice (009
    // makes it commit only together with it); this system never draws one.
    throw new BooksError(
      'NOT_RENDERABLE',
      'NOT_RENDERABLE: an imported document is served from its stored original, never rendered',
      { documentId: view.document.id },
    );
  }
  const input = await issuedInput(options.db ?? scope.db, scope, view);
  assertDrawable(input);
  const bytes = await (options.renderPdf ?? renderPdf)(buildRenderModel(input));
  const missing = missingFields(view.document, view.lines, await extractPdfText(bytes), { corrects: input.corrects });
  if (missing.length > 0) {
    throw new BooksError('RENDER_INCOMPLETE', `RENDER_INCOMPLETE: ${missing.join(', ')}`, { missing });
  }
  return bytes;
}

export interface StoredFile {
  fileId: string;
  bytes: Uint8Array;
  sha256: string;
  created: boolean;
}

/**
 * Inside the caller's transaction (the issue's or the cancellation's
 * `beforeCommit`, or the lazy download path): lock the document, render, check
 * and store its document of record once, and point the document at it. A throw
 * rolls the caller's transaction back.
 */
export async function storeRenderedIn(
  trx: Transaction<CommerceDB>,
  scope: BooksScope,
  view: DocumentView,
  options: RenderOptions = {},
): Promise<StoredFile> {
  const documentId = view.document.id;
  const row = await selectDocumentRow(trx, scope, documentId, { forUpdate: true });
  if (!row) throw new BooksError('NOT_FOUND', 'NOT_FOUND: document', { documentId });
  const stored = await trx
    .selectFrom('sales_document_file')
    .select(['id', 'content', 'sha256'])
    .where('tenant_id', '=', scope.tenantId)
    .where('document_id', '=', documentId)
    .executeTakeFirst();
  if (stored) return { fileId: stored.id, bytes: new Uint8Array(stored.content), sha256: stored.sha256, created: false };

  const bytes = await renderIssuedDocument(scope, view, { ...options, db: trx });
  const digest = sha256(bytes);
  const fileId = randomUUID();
  await trx
    .insertInto('sales_document_file')
    .values({
      id: fileId,
      tenant_id: scope.tenantId,
      document_id: documentId,
      content_type: 'application/pdf',
      byte_size: bytes.byteLength,
      sha256: digest,
      renderer: RENDERER_ID,
      content: Buffer.from(bytes),
    })
    .execute();
  await trx
    .updateTable('sales_document')
    .set({ rendered_pdf_file_id: fileId, updated_at: new Date() })
    .where('tenant_id', '=', scope.tenantId)
    .where('id', '=', documentId)
    .where('rendered_pdf_file_id', 'is', null)
    .execute();
  return { fileId, bytes, sha256: digest, created: true };
}

/** The `beforeCommit` the issue and cancel routes pass: store the document of record in their transaction. */
export function storeBeforeCommit(scope: BooksScope, options: RenderOptions = {}) {
  return async (trx: Transaction<CommerceDB>, view: DocumentView): Promise<void> => {
    await storeRenderedIn(trx, scope, view, options);
  };
}

/** The stored document of record, rendering and storing it first when missing (documents issued before 008). */
export async function storeRenderedDocument(scope: BooksScope, documentId: string): Promise<StoredFile> {
  const existing = await scope.db
    .selectFrom('sales_document_file')
    .select(['id', 'content', 'sha256'])
    .where('tenant_id', '=', scope.tenantId)
    .where('document_id', '=', documentId)
    .executeTakeFirst();
  if (existing) {
    return { fileId: existing.id, bytes: new Uint8Array(existing.content), sha256: existing.sha256, created: false };
  }
  const view = await getDocument(scope, documentId);
  if (view.document.status === 'draft') {
    throw new BooksError('NOT_RENDERABLE', 'NOT_RENDERABLE: a draft is previewed, not rendered', { documentId });
  }
  return withDbErrors(() =>
    scope.db
      .transaction()
      .setIsolationLevel('read committed')
      .execute((trx) => storeRenderedIn(trx, scope, view)),
  );
}

/**
 * The PDF the editor downloads: the stored document of record of an issued
 * document (rendered and stored on the first request if the render after issue
 * failed), or a fresh preview of a draft.
 */
export async function documentPdf(scope: BooksScope, documentId: string): Promise<RenderedPdf> {
  const view = await getDocument(scope, documentId);
  if (view.document.status === 'draft') {
    const bytes = await renderPdf(previewSafe(buildRenderModel(await draftInput(scope, view))));
    return { bytes, fileName: fileNameFor(view, true), ofRecord: false, fileId: null, sha256: sha256(bytes) };
  }
  const stored = await storeRenderedDocument(scope, documentId);
  return {
    bytes: stored.bytes,
    fileName: fileNameFor(view, false),
    ofRecord: true,
    fileId: stored.fileId,
    sha256: stored.sha256,
  };
}
