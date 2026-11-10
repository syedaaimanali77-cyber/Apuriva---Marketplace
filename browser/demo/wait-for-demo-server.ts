/**
 * Holds the APP_ENV=production server back until the demo server answers, i.e. until
 * prepare-demo-database.ts has finished recreating the shared `_demo` database (Playwright starts every
 * webServer at once, and a server connecting mid-reseed would have its connections dropped by the reseed).
 */
import { DEMO_BASE_URL } from './demo-environment';

async function main(): Promise<void> {
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${DEMO_BASE_URL}/api/v1/health`)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`wait-for-demo-server: ${DEMO_BASE_URL} did not come up.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
