import type { NextConfig } from "next";
const config: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  // Next 16's CLI-based TS checker launches this project's tsc wrapper without
  // output under Node 24; use the compiler API already provided by TypeScript.
  experimental: { useTypeScriptCli: false },
  serverExternalPackages: ["pg", "ioredis", "pino", "@opentelemetry/sdk-node"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
    ];
  },
};
export default config;
