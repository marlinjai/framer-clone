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
// customer's current contact, the current version of its template),
// watermarked as a draft on every page, never checked as a document of record
// and never stored.
//
// WHICH RENDERER (visual template composer plan, decision 4): a document whose
// frozen template is version 2 (every document issued from migration 012 on)
// is drawn by the layout engine (render/engine, `books-pdf-lib-3`) with that
// template document; one with a version 1 template, or none (issued before
// 008), by the frozen version 1 renderer (render/legacyV1.ts,
// `books-pdf-lib-2`), so it re-renders to the bytes it was first stored with.
// The stored file records which one drew it. An engine layout that does not
// fit the page (a block taller than a page, a header pushing into the address
// field) refuses the document of record like a missing field.

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
import type { TemplateDocumentV2 } from '../template/schema';
import { missingFields } from './completeness';
import { assertDrawable, previewSafe, previewSafeTemplate } from './drawable';
import { renderTemplate, RENDERER_ID } from './engine';
import { extractPdfText } from './extractText';
import { fontFiles } from './fonts';
import { fileNamePart } from './format';
import { LEGACY_V1_RENDERER_ID, renderLegacyV1 } from './legacyV1';
import { buildRenderModel, type RenderInput, type RenderModel, type RenderRecipient } from './model';

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

/** How a document is laid out: by the frozen version 1 renderer, or by the engine with a template document. */
type Layout = { kind: 'legacyV1'; template: RenderInput['template'] } | { kind: 'engine'; document: TemplateDocumentV2 };

/** The layout an issued document was frozen with (decision 4). */
function frozenLayout(doc: DocumentView['document']): Layout {
  const t = doc.templateSnapshot;
  if (t?.v === 2) return { kind: 'engine', document: t.document };
  return { kind: 'legacyV1', template: t ? { accentColor: t.accentColor, footerBlocks: t.footerBlocks } : null };
}

/** A rendered document and the renderer that drew it (recorded on the stored file). */
interface Drawn {
  bytes: Uint8Array;
  renderer: string;
}

/** Draw a model with its layout (the test seam replaces the writer of either renderer). */
async function draw(layout: Layout, model: RenderModel, options: RenderOptions & { preview?: boolean } = {}): Promise<Drawn> {
  if (layout.kind === 'legacyV1') {
    return { bytes: await (options.renderPdf ?? renderLegacyV1)(model), renderer: LEGACY_V1_RENDERER_ID };
  }
  if (options.renderPdf) return { bytes: await options.renderPdf(model), renderer: RENDERER_ID };
  const { bytes, layout: map } = await renderTemplate(model, layout.document, fontFiles(), { preview: options.preview });
  if (!model.draft && map.issues.length > 0) {
    const problems = map.issues.map((i) => `layout.${i.code.toLowerCase()}${i.blockId ? `.${i.blockId}` : ''}`);
    throw new BooksError('RENDER_INCOMPLETE', `RENDER_INCOMPLETE: ${problems.join(', ')}`, { missing: problems });
  }
  return { bytes, renderer: RENDERER_ID };
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
    template: (() => {
      const layout = frozenLayout(doc);
      return layout.kind === 'legacyV1' ? layout.template : null;
    })(),
  };
}

/** The render input of a draft preview: live data (never stored). */
async function draftInput(scope: BooksScope, view: DocumentView): Promise<{ input: RenderInput; document: TemplateDocumentV2 }> {
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
  // The current version of the draft's template (the built-in Klassisch layout without one).
  const { document } = await templateSnapshotFor(scope.db, scope, doc.templateId);
  return {
    input: { draft: true, document: doc, lines: view.lines, sender: settings?.senderBlock ?? null, recipient, corrects: null, template: null },
    document,
  };
}

/**
 * The render input of a real document for the template preview: an issued
 * document from its frozen data, a draft from live data. Imported documents
 * are never rendered (NOT_RENDERABLE): their original PDF is the record.
 */
export async function documentRenderInput(scope: BooksScope, documentId: string): Promise<RenderInput> {
  const view = await getDocument(scope, documentId);
  if (view.document.source === 'import') {
    throw new BooksError('NOT_RENDERABLE', 'NOT_RENDERABLE: an imported document is served from its stored original, never rendered', {
      documentId,
    });
  }
  if (view.document.status === 'draft') return (await draftInput(scope, view)).input;
  return issuedInput(scope.db, scope, view);
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
 * the drawn text and a layout that fits the page (RENDER_INCOMPLETE
 * otherwise). Never stores.
 */
export async function renderIssuedDocument(
  scope: BooksScope,
  view: DocumentView,
  options: RenderOptions & { db?: Db } = {},
): Promise<Uint8Array> {
  return (await renderIssued(scope, view, options)).bytes;
}

async function renderIssued(scope: BooksScope, view: DocumentView, options: RenderOptions & { db?: Db }): Promise<Drawn> {
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
  const layout = frozenLayout(view.document);
  assertDrawable(input, layout.kind === 'engine' ? layout.document : null);
  const drawn = await draw(layout, buildRenderModel(input), options);
  const missing = missingFields(view.document, view.lines, await extractPdfText(drawn.bytes), { corrects: input.corrects });
  if (missing.length > 0) {
    throw new BooksError('RENDER_INCOMPLETE', `RENDER_INCOMPLETE: ${missing.join(', ')}`, { missing });
  }
  return drawn;
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

  const { bytes, renderer } = await renderIssued(scope, view, { ...options, db: trx });
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
      renderer,
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
    const { input, document } = await draftInput(scope, view);
    const { bytes } = await draw({ kind: 'engine', document: previewSafeTemplate(document) }, previewSafe(buildRenderModel(input)));
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
