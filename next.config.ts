import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emit `.next/standalone` (a self-contained server.js + a curated node_modules
  // subset) so the production Docker image runs `node server.js` without shipping
  // the full dependency tree. Required by the Coolify/Hetzner Dockerfile.
  output: 'standalone',
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
