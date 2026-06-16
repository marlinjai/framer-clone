import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Integration config (run via `pnpm test:integration`). Node environment,
// long timeouts (container boot + migrate), and a globalSetup that stands up a
// Dockerized Postgres. Deliberately SEPARATE from vitest.config.ts so the
// headless `pnpm test` unit run never touches Docker.
//
// Two include globs:
//   - test/integration/**: tests that rely on the globalSetup's shared
//     Dockerized Postgres (DATABASE_URL is set by vitest.integration.setup.ts).
//   - src/**/*.itest.ts: co-located schema proving tests (e.g.
//     src/server/commerce/inventory/__tests__/schema.itest.ts) that boot their
//     OWN throwaway Postgres in beforeAll. The `.itest.ts` suffix keeps them out
//     of the headless `pnpm test` unit run (vitest.config.ts matches only
//     *.{test,spec}.{ts,tsx}), so they run ONLY here, against Docker.
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
    include: ['test/integration/**/*.{test,spec}.ts', 'src/**/*.itest.ts'],
    globalSetup: ['./vitest.integration.setup.ts'],
    hookTimeout: 120_000,
    testTimeout: 60_000,
  },
});
