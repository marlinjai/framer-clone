// src/app/projects/books/composer/workingCopy.ts
//
// The composer's working copy (visual template composer plan, decision 11):
// unsaved changes kept in the browser's localStorage, keyed by template id and
// the saved version they started from, never in the database. On load:
//   - a copy made on the current version is restored (the resume path), with a
//     notice and a way to discard it;
//   - a copy made on an older version (another tab or person saved since) is
//     OFFERED, never applied silently: the user sees it is based on an older
//     version and chooses to discard it or apply it anyway;
//   - a copy without a base version (an older format) or one that equals the
//     saved layout is dropped.
// Storage can be missing or throw (private windows, blocked site data, a full
// quota), so every access is wrapped: losing the working copy is a nicety lost,
// never a failure of the composer.

const PREFIX = 'books-composer:';
/** The working copy's own format version: a copy written by another format is dropped. */
const FORMAT = 1;

export interface WorkingCopy {
  format: typeof FORMAT;
  /** The saved version the edits started from. */
  baseVersionId: string;
  /** The version's number, for the notice ("based on version 3"). */
  baseVersion: number;
  document: unknown;
  /** When it was last written (ISO). */
  savedAt: string;
}

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** The stored copy for a template, or null (none, unreadable, or of an older format: then it is removed). */
export function readWorkingCopy(templateId: string): WorkingCopy | null {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(PREFIX + templateId);
    if (raw === null) return null;
    const value = JSON.parse(raw) as Partial<WorkingCopy> | null;
    if (
      !value ||
      value.format !== FORMAT ||
      typeof value.baseVersionId !== 'string' ||
      typeof value.baseVersion !== 'number' ||
      typeof value.savedAt !== 'string' ||
      value.document === undefined
    ) {
      store.removeItem(PREFIX + templateId);
      return null;
    }
    return value as WorkingCopy;
  } catch {
    return null;
  }
}

/** Keep the unsaved document (a failure to store is ignored: the edit itself is not lost). */
export function writeWorkingCopy(templateId: string, base: { id: string; version: number }, document: unknown): void {
  const store = storage();
  if (!store) return;
  try {
    const copy: WorkingCopy = { format: FORMAT, baseVersionId: base.id, baseVersion: base.version, document, savedAt: new Date().toISOString() };
    store.setItem(PREFIX + templateId, JSON.stringify(copy));
  } catch {
    // Quota or blocked storage: the composer keeps working without a working copy.
  }
}

export function clearWorkingCopy(templateId: string): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(PREFIX + templateId);
  } catch {
    // Nothing to do: an unremovable copy is offered again next time, never applied silently.
  }
}

const KNOWN_TYPES = new Set([
  'logo', 'senderLine', 'recipient', 'documentMeta', 'title', 'introText', 'outroText', 'lineTable', 'totals', 'taxNote',
  'paymentDetails', 'paymentQr', 'senderColumns', 'freeText', 'spacer', 'divider', 'columns',
]);

/**
 * True when a stored copy is a template document the composer can show: the
 * page, theme and the five regions, every block of a known type with an id.
 * It may still fail the strict schema (an edit that ended with an emptied
 * text): the composer restores it and the preview waits for the field, so a
 * crash or reload mid-edit never loses the edits before it.
 */
export function hasDocumentShape(value: unknown): boolean {
  const doc = value as { v?: unknown; page?: unknown; theme?: unknown; regions?: Record<string, unknown> } | null;
  if (!doc || typeof doc !== 'object' || doc.v !== 2 || typeof doc.page !== 'object' || typeof doc.theme !== 'object' || !doc.regions) return false;
  const r = doc.regions as { addressZone?: { left?: unknown; right?: unknown } } & Record<string, unknown>;
  const lists = [r.firstPageHeader, r.addressZone?.left, r.addressZone?.right, r.body, r.followingPageHeader, r.footer];
  const isBlock = (b: unknown): boolean => {
    const x = b as { id?: unknown; type?: unknown; style?: unknown; cells?: unknown } | null;
    if (!x || typeof x.id !== 'string' || typeof x.type !== 'string' || !KNOWN_TYPES.has(x.type) || typeof x.style !== 'object') return false;
    if (x.type !== 'columns') return true;
    return Array.isArray(x.cells) && x.cells.every((c: { blocks?: unknown }) => Array.isArray(c?.blocks) && c.blocks.every(isBlock));
  };
  return lists.every((l) => Array.isArray(l) && l.every(isBlock));
}

/** What to do with a stored copy when the template opens. */
export type ResumeDecision =
  | { kind: 'none' }
  /** Made on the current version: restore it. */
  | { kind: 'restore'; copy: WorkingCopy }
  /** Made on an older version: offer it, never apply it silently. */
  | { kind: 'stale'; copy: WorkingCopy };

export function resumeDecision(copy: WorkingCopy | null, currentVersionId: string, savedDocument: unknown): ResumeDecision {
  if (!copy) return { kind: 'none' };
  if (copy.baseVersionId !== currentVersionId) return { kind: 'stale', copy };
  if (JSON.stringify(copy.document) === JSON.stringify(savedDocument)) return { kind: 'none' };
  return { kind: 'restore', copy };
}
