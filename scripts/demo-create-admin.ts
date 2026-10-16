/**
 * Spec 045 §3.9 — provisions an admin evaluator for a demo environment. Never an HTTP route.
 *
 * Usage: npx tsx scripts/demo-create-admin.ts --email <evaluator email> --role <role>
 *
 * Runs only under the spec 045 §3.1 conditions (not production, demo-mode on, a `_demo` database with no
 * non-demo user). Any canonical spec 009 role except super_admin. Prints a one-time password for the operator to
 * hand to the evaluator, who signs in through the normal login and enrols MFA exactly as spec 005 requires — no
 * MFA secret is generated, shared or skipped here.
 */
import 'dotenv/config';
import { getPool } from '@/lib/db';
import { createDemoAdmin, DemoOperatorRefusal } from '@/lib/demo/operator';

function arg(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? '') : '';
}

async function main(): Promise<void> {
  const created = await createDemoAdmin({ email: arg('email'), role: arg('role') });
  console.log(`Demo admin created (role ${created.role}). One-time password, shown only now: ${created.oneTimePassword}`);
  console.log('The evaluator must sign in through the normal login and enrol two-factor authentication.');
}

main()
  .then(async () => {
    await getPool().end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(err instanceof DemoOperatorRefusal ? err.message : err);
    await getPool().end().catch(() => undefined);
    process.exit(1);
  });
