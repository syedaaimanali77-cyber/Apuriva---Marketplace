import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Emit `.next/standalone` — a self-contained server bundle with only the traced runtime
  // files, which the production Docker image runs via `node server.js`
  // (node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/output.md).
  // Additive output only: `next dev`, `next build` and `next start` behave exactly as before.
  output: 'standalone',
  // `next build` type-checks the production application only. tsconfig.build.json extends
  // tsconfig.json and excludes the test, browser (Playwright), performance and CI tooling, which
  // .dockerignore also keeps out of the image's build context, so the build never resolves a
  // module that is absent there. That tooling stays type-checked by `npm run typecheck`
  // (tsc --noEmit against tsconfig.json), the spec 046 CI static job
  // (node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/typescript.md).
  typescript: {
    tsconfigPath: 'tsconfig.build.json',
  },
};

export default nextConfig;
