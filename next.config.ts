import type { NextConfig } from "next";

/** Pay links carry a token in the path (SPEC §20): no referrer, no indexing. */
const PAY_HEADERS = [
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Robots-Tag", value: "noindex, nofollow" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [
      { source: "/pay/:path*", headers: PAY_HEADERS },
      { source: "/api/pay/:path*", headers: PAY_HEADERS },
    ];
  },
  /* config options here */
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
