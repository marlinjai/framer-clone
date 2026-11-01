// @vitest-environment node
//
// A failing job worker must never fail the server's start: the shop sells without it, and the host timer's watchdog
// route does the same work.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { startCommerceWorker } = vi.hoisted(() => ({ startCommerceWorker: vi.fn() }));

vi.mock('@/lib/editorHost', () => ({ assertEditorHostConfigured: () => undefined }));
vi.mock('@/lib/openfgaConfig', () => ({ warnIfOpenfgaTokenMissing: () => undefined }));
vi.mock('@/server/commerce/mail/runtime', () => ({ startShopMailSweep: () => undefined }));
vi.mock('@/server/commerce/jobs/runtime', () => ({ startCommerceWorker }));

import { registerNode } from '../instrumentation.node';

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('registerNode', () => {
  it('starts the commerce job worker', async () => {
    await registerNode();
    expect(startCommerceWorker).toHaveBeenCalledOnce();
  });

  it('logs a worker that cannot start, and the start goes on', async () => {
    startCommerceWorker.mockImplementationOnce(() => {
      throw new Error('no worker');
    });
    await expect(registerNode()).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith('[startup] the commerce job worker did not start:', expect.any(Error));
  });
});
