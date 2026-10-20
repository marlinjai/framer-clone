// src/server/books/render/store.ts
//
// The render pipeline end to end (Books plan section 5, phase 3):
//
//   document -> render input -> render model -> PDF bytes -> completeness check
//            -> stored once as the document of record (issued documents only)
//
// ISSUED documents (invoices and credit notes, any status after draft) are
// rendered ONLY from their frozen data: the customer and sender snapshots, the
// stored lines and totals, and for a credit note the frozen number and date of
// the invoice it cancels. The contacts database, the customer row and the
// company setting are never read for them, so nothing changed after issue can
// change a re-render. The first render after issue is checked for completeness
// (completeness.ts) and stored in `sales_document_file`; the document points at
// it through `rendered_pdf_file_id`, which the 007 trigger lets go from NULL to
// a value exactly once. Later downloads serve the stored bytes.
//
// DRAFTS get a preview rendered from live data (the company's sender block, the
// customer's current contact), watermarked as a draft on every page, never
// checked as a document of record and never stored.

import { createHash, randomUUID } from 'node:crypto';

import { BooksError, isBooksError, withDbErrors } from '../errors';
import { readRecipient } from '../recipients';
import { getDocument, selectDocumentRow, type DocumentView } from '../repository/read';
import { selectCustomerRow } from '../repository/taxState';
import { getTemplate, type DocumentTemplate } from '../repository/templates';
import type { BooksScope } from '../scope';
import { readSettings } from '../settings';
import { missingFields } from './completeness';
import { extractPdfText } from './extractText';
import { fileNamePart } from './format';
import { buildRenderModel, type RenderInput, type RenderRecipient } from './model';
import { RENDERER_ID, renderPdf } from './pdf';

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

async function templateFor(scope: BooksScope, id: string | null): Promise<DocumentTemplate | null> {
  if (!id) return null;
  try {
    return await getTemplate(scope, id);
  } catch (err) {
    if (isBooksError(err, 'TEMPLATE_NOT_FOUND')) return null;
    throw err;
  }
}

/** The render input of an issued document: frozen data only (plus the template's layout). */
async function issuedInput(scope: BooksScope, view: DocumentView): Promise<RenderInput> {
  const doc = view.document;
  if (!doc.senderSnapshot || !doc.customerSnapshot) {
    throw new BooksError('NOT_RENDERABLE', 'NOT_RENDERABLE: the document carries no snapshots', { documentId: doc.id });
  }
  let corrects: RenderInput['corrects'] = null;
  if (doc.correctsDocumentId) {
    const original = await selectDocumentRow(scope.db, scope, doc.correctsDocumentId);
    if (original?.document_number && original.issue_date) {
      corrects = { documentNumber: original.document_number, issueDate: original.issue_date };
    }
  }
  const template = await templateFor(scope, doc.templateId);
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
    template: template ? { accentColor: template.accentColor, footerBlocks: template.footerBlocks } : null,
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
  const template = await templateFor(scope, doc.templateId);
  return {
    draft: true,
    document: doc,
    lines: view.lines,
    sender: settings?.senderBlock ?? null,
    recipient,
    corrects: null,
    template: template ? { accentColor: template.accentColor, footerBlocks: template.footerBlocks } : null,
  };
}

function fileNameFor(view: DocumentView, draft: boolean): string {
  const doc = view.document;
  const kind = doc.docType === 'credit_note' ? 'Gutschrift' : 'Rechnung';
  return draft ? `${kind}-Entwurf-${doc.id.slice(0, 8)}.pdf` : `${kind}-${fileNamePart(doc.documentNumber ?? doc.id)}.pdf`;
}

/**
 * Render an issued document from its frozen data, and check it. Never stores.
 * Used to store the document of record and by the re-render tests.
 */
export async function renderIssuedDocument(scope: BooksScope, view: DocumentView): Promise<Uint8Array> {
  if (view.document.status === 'draft') {
    throw new BooksError('NOT_RENDERABLE', 'NOT_RENDERABLE: a draft is previewed, not rendered', {
      documentId: view.document.id,
    });
  }
  const bytes = await renderPdf(buildRenderModel(await issuedInput(scope, view)));
  const missing = missingFields(view.document, view.lines, extractPdfText(bytes));
  if (missing.length > 0) {
    throw new BooksError('RENDER_INCOMPLETE', `RENDER_INCOMPLETE: ${missing.join(', ')}`, { missing });
  }
  return bytes;
}

/** The stored file of a document, if any. */
async function readStoredFile(scope: BooksScope, documentId: string) {
  return scope.db
    .selectFrom('sales_document_file')
    .select(['id', 'content', 'sha256'])
    .where('tenant_id', '=', scope.tenantId)
    .where('document_id', '=', documentId)
    .executeTakeFirst();
}

/**
 * Render, check and store the document of record of an issued document, once.
 * Idempotent: when a file is stored already, that one is returned untouched.
 */
export async function storeRenderedDocument(
  scope: BooksScope,
  documentId: string,
): Promise<{ fileId: string; bytes: Uint8Array; sha256: string; created: boolean }> {
  const existing = await readStoredFile(scope, documentId);
  if (existing) {
    return { fileId: existing.id, bytes: new Uint8Array(existing.content), sha256: existing.sha256, created: false };
  }
  const view = await getDocument(scope, documentId);
  const bytes = await renderIssuedDocument(scope, view);
  const digest = sha256(bytes);

  return withDbErrors(() =>
    scope.db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx) => {
        const row = await selectDocumentRow(trx, scope, documentId, { forUpdate: true });
        if (!row) throw new BooksError('NOT_FOUND', 'NOT_FOUND: document', { documentId });
        const stored = await trx
          .selectFrom('sales_document_file')
          .select(['id', 'content', 'sha256'])
          .where('tenant_id', '=', scope.tenantId)
          .where('document_id', '=', documentId)
          .executeTakeFirst();
        if (stored) {
          return { fileId: stored.id, bytes: new Uint8Array(stored.content), sha256: stored.sha256, created: false };
        }
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
      }),
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
    const bytes = await renderPdf(buildRenderModel(await draftInput(scope, view)));
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
