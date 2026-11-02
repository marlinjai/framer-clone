import { defineConfig } from 'vitest/config';
import path from 'node:path';

// The behaviour runtime on a real Next production build, in real Chromium and WebKit
// (run through `pnpm test:behaviour`). Separate from the other configs because it needs
// Docker for a real Postgres and a full `next build`, which is what makes it the one
// place hydration, client chunks and the real published route are all there at once.
// Set BEHAVIOUR_REUSE_BUILD=1 to run again on the last build while working on a test.
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      'server-only': path.resolve(__dirname, './test/stubs/server-only.ts'),
    },
  },
  test: {
    name: 'behaviour',
    environment: 'node',
    env: { TZ: 'UTC' },
    globals: false,
    include: ['test/behaviour/**/*.spec.ts'],
    globalSetup: ['./test/behaviour/setup.ts'],
    fileParallelism: false,
    hookTimeout: 120_000,
    testTimeout: 60_000,
  },
});
