import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow LAN access to Next.js dev resources (HMR, chunks) from mobile devices
  allowedDevOrigins: [
    "192.168.1.74",
    "192.168.1.74:3000",
    "localhost",
    "localhost:3000",
  ],

  // Proxy API requests to the Fastify backend
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001"}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
