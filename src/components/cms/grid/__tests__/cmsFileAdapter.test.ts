import { describe, it, expect } from 'vitest';
import {
  cmsFileAdapter,
  CmsFileStorageUnconfiguredError,
  CMS_FILE_STORAGE_UNCONFIGURED_MESSAGE,
} from '../cmsFileAdapter';

describe('cmsFileAdapter', () => {
  it('rejects an upload LOUDLY with the typed unconfigured error (never a silent success)', async () => {
    const promise = cmsFileAdapter.upload(new Blob(['x']));
    await expect(promise).rejects.toBeInstanceOf(CmsFileStorageUnconfiguredError);
    await expect(cmsFileAdapter.upload(new Blob(['x']))).rejects.toThrow(
      CMS_FILE_STORAGE_UNCONFIGURED_MESSAGE,
    );
  });

  it('carries a typed code so callers can distinguish storage-unconfigured from a data error', async () => {
    await expect(cmsFileAdapter.upload(new Blob(['x']))).rejects.toMatchObject({
      code: 'file_storage_unconfigured',
    });
  });

  it('treats delete as a genuine no-op (no stored binary exists while uploads are disabled)', async () => {
    await expect(cmsFileAdapter.delete('any-file-id')).resolves.toBeUndefined();
  });
});
