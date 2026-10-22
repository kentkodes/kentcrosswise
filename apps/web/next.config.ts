import type { NextConfig } from "next";
import { parseKcwEnv } from "./src/auth/env";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Inlined at build time: prod builds drop the preview-only login provider (see src/auth/env.ts).
  env: { KCW_ENV: parseKcwEnv(process.env.KCW_ENV) },
  // Workspace packages ship TypeScript source.
  transpilePackages: ["@kcw/demo-data", "@kcw/xray", "@kcw/secrets"],
};

export default nextConfig;
