// src/components/cms/grid/cmsFileAdapter.ts
//
// The grid's FileStorageAdapter. framer-clone has no file-storage backend wired
// yet, so binary UPLOAD fails LOUDLY with a typed, framer-clone-specific error
// instead of silently no-op'ing into something that looks like success. The
// `file` column type is still fully creatable and bindable; only the binary
// upload is deferred to a dedicated storage slice (Storage Brain / R2).
//
// We ship our OWN adapter rather than leaning on the engine's NoopFileAdapter so
// the loud contract is ours, testable, and carries a message that tells the
// builder exactly what is going on.

import type { FileStorageAdapter } from '@marlinjai/data-table-core';

export const CMS_FILE_STORAGE_UNCONFIGURED_MESSAGE =
  'CMS file storage is not configured yet. A file column can be created and bound, ' +
  'but uploading a file needs the storage backend, which is a separate slice. ' +
  'This is an intentional, loud failure, not a silent drop.';

/** Typed failure thrown when a file upload is attempted before storage exists. */
export class CmsFileStorageUnconfiguredError extends Error {
  readonly code = 'file_storage_unconfigured';
  constructor() {
    super(CMS_FILE_STORAGE_UNCONFIGURED_MESSAGE);
    this.name = 'CmsFileStorageUnconfiguredError';
  }
}

export const cmsFileAdapter: FileStorageAdapter = {
  // Upload throws: there is no backend to accept the bytes, and a silent success
  // would be worse than a loud failure (the file would appear saved but vanish).
  async upload() {
    throw new CmsFileStorageUnconfiguredError();
  },

  // Delete resolves: with uploads disabled there is never a stored binary to
  // remove, so a deletion of a (non-existent) binary is a genuine no-op rather
  // than a failure that masquerades as one. The row's file REFERENCE is removed
  // separately through the dbAdapter, which works.
  async delete() {
    /* no-op: nothing to delete while storage is unconfigured */
  },

  // getUrl throws for the same reason as upload: a binary can never have been
  // stored, so a request for its URL is reached only in error and must surface
  // loudly rather than return a broken/empty link.
  async getUrl() {
    throw new CmsFileStorageUnconfiguredError();
  },
};
