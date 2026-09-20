import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow LAN access to Next.js dev resources (HMR, chunks) from mobile devices
  allowedDevOrigins: [
    "192.168.1.74",
    "192.168.1.74:3000",
    "localhost",
    "localhost:3000",
  ],

  // Force HTTPS for production domain when accessed over plain HTTP
  async redirects() {
    return [
      {
        source: "/:path*",
        has: [
          {
            type: "header",
            key: "x-forwarded-proto",
            value: "http",
          },
        ],
        destination: "https://dengarkan.my.id/:path*",
        permanent: true,
      },
    ];
  },

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

