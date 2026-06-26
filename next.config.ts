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
