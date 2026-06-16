import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Shared resolve aliases for every project:
//   '@'           -> src (mirrors tsconfig paths)
//   'server-only' -> a no-op stub so src/server/** modules can be unit tested
//                    (the real package throws outside the react-server build).
const alias = {
  '@': path.resolve(__dirname, './src'),
  'server-only': path.resolve(__dirname, './test/stubs/server-only.ts'),
};

// Test substrate (Track 0): two projects.
//   - jsdom: the existing client suite (components, renderer, drag, bindings,
//     models, AI helpers). Unchanged environment for src/**.
//   - node:  the server suite (src/server/**) plus the bindings resolver
//     (src/lib/bindings/resolver/**), which run in a real Node environment.
// The Dockerized-Postgres integration harness is a SEPARATE config
// (vitest.integration.config.ts, run via `pnpm test:integration`) and is kept
// OUT of this headless unit run.
export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'jsdom',
          environment: 'jsdom',
          globals: false,
          include: ['src/**/*.{test,spec}.{ts,tsx}'],
          exclude: [
            'src/server/**',
            'src/lib/bindings/resolver/**',
            'node_modules/**',
          ],
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'node',
          environment: 'node',
          globals: false,
          include: [
            'src/server/**/*.{test,spec}.{ts,tsx}',
            'src/lib/bindings/resolver/**/*.{test,spec}.{ts,tsx}',
          ],
        },
      },
    ],
  },
});
