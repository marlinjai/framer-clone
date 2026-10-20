// src/server/books/upload/views.ts
//
// The JSON the /api/books/imports routes answer for a staging row: what the
// review table shows (the printed invoice the row stands for, what the model
// read, its confidence per field, the named problems) and never the bytes.
// The values are the company's own data shown to its own admins; they are
// never logged.

import { effectivePrinted, type ImportItem } from './staging';

export interface ImportItemView {
  id: string;
  fileName: string;
  byteSize: number;
  status: ImportItem['status'];
  version: number;
  /** The extraction a correction must name (keyed corrections, STALE_EXTRACTION otherwise). */
  extractionId: string | null;
  /** The printed invoice the row stands for now (the correction, else the extraction). */
  printed: Record<string, unknown> | null;
  /** What the model read (to show what the user changed). */
  extractedPrinted: Record<string, unknown> | null;
  confidence: Record<string, 'high' | 'medium' | 'low'>;
  corrected: boolean;
  problems: ImportItem['problems'];
  extractionError: string | null;
  model: string | null;
  documentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export function importItemView(item: ImportItem): ImportItemView {
  return {
    id: item.id,
    fileName: item.fileName,
    byteSize: item.byteSize,
    status: item.status,
    version: item.version,
    extractionId: item.extractionId,
    printed: effectivePrinted(item),
    extractedPrinted: item.extracted?.printed ?? null,
    confidence: item.extracted?.confidence ?? {},
    corrected: item.corrected !== null,
    problems: item.problems,
    extractionError: item.extractionError,
    model: item.model,
    documentId: item.documentId,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
}
