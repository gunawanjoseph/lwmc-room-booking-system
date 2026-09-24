import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  // Dev only: let a phone on the local network load dev scripts when
  // testing at http://<this Mac's IP>:3000. Ignored by production builds.
  allowedDevOrigins: ["172.20.10.2"],
};

export default nextConfig;
