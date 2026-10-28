import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  distDir: process.env.ASTRO_NEXT_DIST_DIR ?? ".next",
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
