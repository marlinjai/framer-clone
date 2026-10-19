// @vitest-environment node
//
// src/lib/auth-brain.ts hands the OpenFGA pre-shared key and model id from the
// environment to the SDK client, and never sends an empty or whitespace value.

import { afterEach, describe, expect, it, vi } from 'vitest';

const createAuthBrainClient = vi.fn<(opts: Record<string, unknown>) => object>(() => ({}));
vi.mock('@marlinjai/auth-brain-sdk', () => ({ createAuthBrainClient }));

async function optionsWith(env: Record<string, string | undefined>) {
  vi.resetModules();
  createAuthBrainClient.mockClear();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  await import('../auth-brain');
  expect(createAuthBrainClient).toHaveBeenCalledTimes(1);
  return createAuthBrainClient.mock.calls[0][0];
}

afterEach(() => vi.unstubAllEnvs());

describe('authBrainClient options', () => {
  it('passes OPENFGA_API_TOKEN and OPENFGA_AUTHORIZATION_MODEL_ID from the env', async () => {
    const opts = await optionsWith({
      OPENFGA_API_URL: 'http://openfga:8080',
      OPENFGA_STORE_ID: 'store-1',
      OPENFGA_API_TOKEN: 'test-token',
      OPENFGA_AUTHORIZATION_MODEL_ID: 'model-1',
    });
    expect(opts).toMatchObject({
      openfgaUrl: 'http://openfga:8080',
      openfgaStoreId: 'store-1',
      openfgaToken: 'test-token',
      openfgaModelId: 'model-1',
    });
  });

  it('trims the values', async () => {
    const opts = await optionsWith({
      OPENFGA_API_TOKEN: '  test-token \n',
      OPENFGA_AUTHORIZATION_MODEL_ID: ' model-1 ',
    });
    expect(opts.openfgaToken).toBe('test-token');
    expect(opts.openfgaModelId).toBe('model-1');
  });

  it('never sends an empty or whitespace-only token or model id', async () => {
    for (const blank of ['', '   ']) {
      const opts = await optionsWith({
        OPENFGA_API_TOKEN: blank,
        OPENFGA_AUTHORIZATION_MODEL_ID: blank,
      });
      expect(opts.openfgaToken).toBeUndefined();
      expect(opts.openfgaModelId).toBeUndefined();
    }
  });
});
