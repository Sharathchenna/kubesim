import type { NextConfig } from "next";

// Static export: the whole site is plain files (no server), per ADR 0001.
const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
};

export default nextConfig;
