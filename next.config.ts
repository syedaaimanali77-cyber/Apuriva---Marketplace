import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Emit `.next/standalone` — a self-contained server bundle with only the traced runtime
  // files, which the production Docker image runs via `node server.js`
  // (node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/output.md).
  // Additive output only: `next dev`, `next build` and `next start` behave exactly as before.
  output: 'standalone',
};

export default nextConfig;
