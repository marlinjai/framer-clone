import type { NextConfig } from "next";

// The Books engine's browser parity harness (WYSIWYG invoice editor plan,
// phase 1, parity layer (b), src/app/dev/books-engine): its page and routes
// are named *.harness.tsx / *.harness.ts and only count as pages and routes
// when BOOKS_ENGINE_HARNESS=1, a build of its own (into .next-harness) for
// proving that the worker chunk the bundler emits draws the server's bytes in
// a real browser. A normal build never contains it. In that build the font and
// asset routes, which need a signed-in Books session, are rewritten to the
// harness's stand-ins, so the worker fetches the same paths as in production.
const HARNESS = process.env.BOOKS_ENGINE_HARNESS === '1';

const nextConfig: NextConfig = {
  ...(HARNESS
    ? {
        distDir: '.next-harness',
        pageExtensions: ['tsx', 'ts', 'jsx', 'js', 'harness.tsx', 'harness.ts'],
        async rewrites() {
          return {
            beforeFiles: [
              { source: '/api/books/fonts/:sha256', destination: '/dev/books-engine/files/fonts/:sha256' },
              { source: '/api/books/assets/:sha256', destination: '/dev/books-engine/files/assets/:sha256' },
            ],
            afterFiles: [],
            fallback: [],
          };
        },
      }
    : {}),
  // Emit `.next/standalone` (a self-contained server.js + a curated node_modules
  // subset) so the production Docker image runs `node server.js` without shipping
  // the full dependency tree. Required by the Coolify/Hetzner Dockerfile. (The
  // harness build is started with `next start`, which needs the plain output.)
  output: HARNESS ? undefined : 'standalone',
  turbopack: {
    root: __dirname,
  },
  // Keep Prisma's generated client (which loads a native query engine binary)
  // out of the bundler so `next build` treats it as an external require.
  serverExternalPackages: ['@prisma/client'],
  experimental: {
    // The Books upload import sends each past-invoice PDF (at most 10 MB) as
    // the request body, through the edge middleware, which keeps a body only up
    // to this size (default 10 MB: a 10 MB file would arrive cut off). The
    // route refuses a body shorter than its declared length.
    middlewareClientMaxBodySize: '12mb',
  },
  // The Books render their PDFs in embedded fonts read from assets/fonts at run
  // time (src/server/books/render/fonts.ts); the standalone output only copies
  // traced files, so the font files are traced in explicitly for every Books route.
  outputFileTracingIncludes: {
    '/api/books/**/*': ['./assets/fonts/**/*'],
  },
  images: {
    // Allow all external domains (for design tool flexibility)
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '**', // Allow all hostnames
      },
      {
        protocol: 'http',
        hostname: '**', // Allow all hostnames (for development)
      }
    ],
    // Alternative: disable optimization for external images
    unoptimized: false,
  },
};

export default nextConfig;
