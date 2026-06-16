import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Integration config (run via `pnpm test:integration`). Node environment,
// long timeouts (container boot + migrate), and a globalSetup that stands up a
// Dockerized Postgres. Deliberately SEPARATE from vitest.config.ts so the
// headless `pnpm test` unit run never touches Docker.
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      'server-only': path.resolve(__dirname, './test/stubs/server-only.ts'),
    },
  },
  test: {
    name: 'integration',
    environment: 'node',
    globals: false,
    include: ['test/integration/**/*.{test,spec}.ts'],
    globalSetup: ['./vitest.integration.setup.ts'],
    hookTimeout: 120_000,
    testTimeout: 60_000,
  },
});
