// src/server/books/index.ts
//
// The Books domain (phase 1 of docs/plans/2026-08-15-books-receipts-invoices-integration.md):
// customers, draft invoices, issue with gap-free numbering, cancellation through
// a credit note, frozen snapshots and the audit trail, in each tenant group's
// own schema. No routes and no interface yet (phase 2). Every function takes a
// BooksScope first (booksScope(db, tgId, tenantId)).
//
// Operator scripts import settings.ts directly instead of this index: the line
// repository reads catalog prices through a module that imports `server-only`.

export { booksScope, type BooksScope } from './scope';
export { BooksError, isBooksError, type BooksErrorCode } from './errors';
export {
  contactsDb,
  contactsRecipientDirectory,
  ContactsNotConfiguredError,
  type RecipientContact,
  type RecipientDirectory,
} from './recipients';
export {
  DEFAULT_EXEMPTION_NOTE,
  initBooksCompany,
  readSettings,
  type CompanySettings,
  type InitBooksCompanyInput,
  type InitBooksCompanyResult,
} from './settings';
export { formatDocumentNumber } from './numbering';
export {
  archiveCustomer,
  createCustomer,
  getCustomer,
  listCustomers,
  updateCustomerTaxFields,
  type CreateCustomerInput,
  type Customer,
  type ListCustomersInput,
  type UpdateCustomerTaxFieldsInput,
} from './repository/customers';
export {
  createDraft,
  setCustomer,
  updateDraft,
  type CreateDraftInput,
  type SetCustomerInput,
  type UpdateDraftInput,
} from './repository/documents';
export {
  addLine,
  removeLine,
  reorderLines,
  updateLine,
  type AddLineInput,
  type ReorderLinesInput,
  type UpdateLineInput,
} from './repository/lines';
export {
  getDocument,
  listDocuments,
  type DocumentPage,
  type DocumentView,
  type ListDocumentsInput,
  type SalesDocument,
  type SalesDocumentEvent,
  type SalesDocumentLine,
  type SalesDocumentWithSnapshots,
} from './repository/read';
export { issue, type IssueInput, type IssueOptions, type IssueResult } from './issue';
export { cancelInvoice, type CancelInvoiceInput, type CancelResult } from './cancel';
export type { CustomerSnapshotV1, SenderBlockV1, SenderSnapshotV1, TaxSummary } from './snapshots';
