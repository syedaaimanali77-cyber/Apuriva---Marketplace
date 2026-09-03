/**
 * CI/architecture check for spec 003 §4/§6: 0001_baseline_schema is immutable once merged —
 * its generated SQL is never hand-edited again, not even to fix a baseline mistake found later.
 * This compares the committed migration's sha256 against the sha256 sidecar committed alongside
 * it and fails if they differ, catching an accidental (or deliberate) edit of the baseline file.
 *
 * If 0001_baseline_schema.sql legitimately needs to change before it has ever shipped/merged,
 * regenerate the sidecar with the same command used to produce it originally:
 *   node -e "console.log(require('crypto').createHash('sha256').update(require('fs').readFileSync('drizzle/0001_baseline_schema.sql')).digest('hex'))" > drizzle/0001_baseline_schema.sql.sha256
 * Once merged, neither file is edited again — a later schema change ships as its own new
 * sequentially-numbered migration instead.
 *
 * Usage: npm run check:schema-checksum
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const MIGRATION_PATH = join(ROOT, 'drizzle', '0001_baseline_schema.sql');
const CHECKSUM_PATH = join(ROOT, 'drizzle', '0001_baseline_schema.sql.sha256');

function fail(message: string): never {
  console.error(`check:schema-checksum FAILED\n${message}`);
  process.exit(1);
}

let migrationSql: Buffer;
try {
  migrationSql = readFileSync(MIGRATION_PATH);
} catch {
  fail(`Could not read ${MIGRATION_PATH} — has 0001_baseline_schema.sql been generated (npm run db:generate)?`);
}

let committedChecksum: string;
try {
  committedChecksum = readFileSync(CHECKSUM_PATH, 'utf8').trim();
} catch {
  fail(
    `Could not read ${CHECKSUM_PATH}. The immutability guard requires a committed sha256 sidecar ` +
      'alongside 0001_baseline_schema.sql.',
  );
}

const actualChecksum = createHash('sha256').update(migrationSql!).digest('hex');

if (actualChecksum !== committedChecksum!) {
  fail(
    `drizzle/0001_baseline_schema.sql has changed since it was committed.\n` +
      `  committed sha256: ${committedChecksum}\n` +
      `  actual sha256:    ${actualChecksum}\n` +
      'Spec 003 §4: once merged, 0001_baseline_schema is never edited again — every subsequent ' +
      'schema change ships as its own new sequentially-numbered migration (0002_*, 0003_*, ...).',
  );
}

console.log('check:schema-checksum PASSED — 0001_baseline_schema.sql matches its committed checksum.');
