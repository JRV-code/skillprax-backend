require('dotenv').config();
const { Pool } = require('pg');

async function cleanOrphans() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.log('[Cleanup] No DATABASE_URL found, skipping pre-migration cleanup.');
    return;
  }

  const pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
  });

  try {
    console.log('[Cleanup] Checking for orphaned records in skill_steps...');
    
    // Check if tables exist before running delete
    const tableCheck = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name IN ('skill_steps', 'user_skills', 'skills');
    `);

    const tables = tableCheck.rows.map(r => r.table_name);

    if (tables.includes('skill_steps')) {
      const parentTable = tables.includes('user_skills') ? 'user_skills' : 'skills';
      
      // Delete orphaned steps whose parent skill no longer exists
      const result = await pool.query(`
        DELETE FROM skill_steps 
        WHERE skill_id IS NULL 
        OR skill_id NOT IN (SELECT id::text FROM ${parentTable});
      `);

      console.log(`[Cleanup] Successfully removed ${result.rowCount} orphaned rows from skill_steps.`);
    } else {
      console.log('[Cleanup] skill_steps table does not exist yet. Clean.');
    }
  } catch (err) {
    console.warn('[Cleanup Warning] Non-fatal cleanup issue:', err.message);
  } finally {
    try {
      await pool.end();
    } catch (_) {}
  }
}

cleanOrphans().catch((err) => {
  console.warn('[Cleanup Error]:', err);
  process.exit(0); // Exit 0 so build never breaks on pre-check
});
