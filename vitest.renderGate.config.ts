import { defineConfig } from 'vitest/config';
import path from 'node:path';

// The render gate fuzz (`pnpm test:render-gate`, test/renderGate). Its own config
// because it starts Chromium and WebKit and, unlike the primitive score, fails on
// what it finds: the score records failures as results by design. Never cached: a
// hit would replay "nothing ran" without a browser having looked.
const alias = {
  '@': path.resolve(__dirname, './src'),
  'server-only': path.resolve(__dirname, './test/stubs/server-only.ts'),
};

export default defineConfig({
  resolve: { alias },
  cacheDir: 'node_modules/.vite-render-gate',
  test: {
    cache: false,
    environment: 'node',
    env: { TZ: 'UTC' },
    globals: false,
    testTimeout: 3_600_000,
    hookTimeout: 120_000,
    include: ['test/renderGate/**/*.gate.{ts,tsx}'],
  },
});
