import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Primitive score config (run through `pnpm score:primitives`, test/score/run.ts).
// Deliberately SEPARATE from vitest.config.ts: these probes record honest
// failures as results and start a real browser, so they stay out of `pnpm test`
// (which only matches src/**). `cache: false` because a score that replays an
// old result is worthless: every run measures from scratch.
const alias = {
  '@': path.resolve(__dirname, './src'),
  'server-only': path.resolve(__dirname, './test/stubs/server-only.ts'),
};

export default defineConfig({
  resolve: { alias },
  cacheDir: 'node_modules/.vite-score',
  test: {
    cache: false,
    testTimeout: 180_000,
    hookTimeout: 60_000,
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'score-jsdom',
          environment: 'jsdom',
          env: { TZ: 'UTC' },
          globals: false,
          testTimeout: 180_000,
          hookTimeout: 60_000,
          setupFiles: ['./test/setup.client.ts'],
          include: ['test/score/**/*.jsdom.score.{ts,tsx}', 'test/score/matrix.canvas.score.tsx'],
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'score-node',
          environment: 'node',
          env: { TZ: 'UTC' },
          globals: false,
          testTimeout: 180_000,
          hookTimeout: 60_000,
          include: ['test/score/**/*.score.{ts,tsx}'],
          exclude: ['test/score/**/*.jsdom.score.{ts,tsx}', 'test/score/matrix.canvas.score.tsx', 'node_modules/**'],
        },
      },
    ],
  },
});
