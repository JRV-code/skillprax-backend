import { ensureDatabaseSchema } from '../../src/lib/ensureSchema';

async function main() {
  console.log('Running ensureDatabaseSchema()...');
  await ensureDatabaseSchema();
  console.log('ensureDatabaseSchema() completed successfully!');
}

main().catch(err => {
  console.error('ensureDatabaseSchema() failed:', err);
  process.exit(1);
});
