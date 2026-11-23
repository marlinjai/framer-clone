import { defineConfig } from 'vitest/config';

// The box against a real Postgres and against its own built image. Needs a
// Docker daemon. One file at a time: each starts its own containers, bound to
// 127.0.0.1 only, and removes them.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/integration/*.itest.ts'],
    env: { TZ: 'UTC' },
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 300_000,
  },
});
