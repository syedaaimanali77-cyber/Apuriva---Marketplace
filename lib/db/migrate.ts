import 'dotenv/config';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { getDb, getPool } from './index';

async function main() {
  await migrate(getDb(), { migrationsFolder: './drizzle' });
  await getPool().end();
  console.log('Migrations applied.');
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
