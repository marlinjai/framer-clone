import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
