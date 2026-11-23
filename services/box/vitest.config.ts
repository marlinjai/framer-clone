import { defineConfig } from 'vitest/config';

// The box's unit suite: no database, no container, no network beyond 127.0.0.1.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/*.test.ts'],
    env: { TZ: 'UTC' },
  },
});
