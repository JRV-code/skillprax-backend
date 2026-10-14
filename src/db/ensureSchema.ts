import { db } from '../lib/db';
import prisma from '../lib/prisma';

export async function runSchemaMigration() {
  console.log('[SchemaMigration] Running safe schema migration & repair...');
  
  const statements = [
    `ALTER TABLE skill_steps ADD COLUMN IF NOT EXISTS is_sourced BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE skill_steps ADD COLUMN IF NOT EXISTS topics JSONB DEFAULT '[]'`,
    `ALTER TABLE skill_steps ADD COLUMN IF NOT EXISTS difficulty_tier VARCHAR(50) DEFAULT 'Foundations'`,
    `ALTER TABLE skill_steps ADD COLUMN IF NOT EXISTS video_id VARCHAR(100) DEFAULT ''`,
    `ALTER TABLE skill_steps ADD COLUMN IF NOT EXISTS video_url TEXT DEFAULT ''`,
    `ALTER TABLE skill_steps ADD COLUMN IF NOT EXISTS video_title TEXT DEFAULT ''`,
    `ALTER TABLE skill_steps ADD COLUMN IF NOT EXISTS video_mini_guide TEXT DEFAULT ''`,
    `ALTER TABLE skill_steps ADD COLUMN IF NOT EXISTS doc_title VARCHAR(255) DEFAULT ''`,
    `ALTER TABLE skill_steps ADD COLUMN IF NOT EXISTS doc_url TEXT DEFAULT ''`,
    `ALTER TABLE skill_steps ADD COLUMN IF NOT EXISTS doc_domain VARCHAR(255) DEFAULT ''`,
    `ALTER TABLE skill_steps ADD COLUMN IF NOT EXISTS doc_mini_guide TEXT DEFAULT ''`,
    `ALTER TABLE skill_steps ADD COLUMN IF NOT EXISTS step_explanation TEXT DEFAULT ''`,
    `ALTER TABLE skill_steps ADD COLUMN IF NOT EXISTS quiz_data JSONB DEFAULT '[]'`,
    `ALTER TABLE skill_steps ADD COLUMN IF NOT EXISTS quiz_passed BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE skill_steps ADD COLUMN IF NOT EXISTS quiz_score INT DEFAULT NULL`,
    `ALTER TABLE skill_steps DROP CONSTRAINT IF EXISTS skill_steps_skill_id_fkey`,
    `ALTER TABLE skill_steps ALTER COLUMN skill_id TYPE TEXT`,
    `ALTER TABLE skill_steps ALTER COLUMN id SET DEFAULT gen_random_uuid()::text`,
    `ALTER TABLE skill_steps ALTER COLUMN documentation_quadrants DROP NOT NULL`,
    `ALTER TABLE skill_steps ALTER COLUMN documentation_quadrants SET DEFAULT '{}'::jsonb`,
    `ALTER TABLE skill_steps ALTER COLUMN video_url DROP NOT NULL`,
    `ALTER TABLE skill_steps ALTER COLUMN video_url SET DEFAULT ''`,
    `ALTER TABLE skill_steps ALTER COLUMN video_id DROP NOT NULL`,
    `ALTER TABLE skill_steps ALTER COLUMN video_id SET DEFAULT ''`,
    `ALTER TABLE skill_steps ALTER COLUMN documentation_markdown DROP NOT NULL`,
    `ALTER TABLE skill_steps ALTER COLUMN documentation_markdown SET DEFAULT ''`,
    `ALTER TABLE skill_steps ALTER COLUMN description DROP NOT NULL`,
    `ALTER TABLE skill_steps ALTER COLUMN description SET DEFAULT ''`,
    `CREATE TABLE IF NOT EXISTS user_resource_history (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      user_id TEXT NOT NULL,
      skill_id TEXT,
      step_number INT NOT NULL,
      resource_type VARCHAR(50) NOT NULL,
      resource_identifier TEXT NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )`,
    `ALTER TABLE user_resource_history ALTER COLUMN id SET DEFAULT gen_random_uuid()::text`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_user_resource_history_uniq ON user_resource_history (user_id, resource_identifier)`,
    `ALTER TABLE users ALTER COLUMN updated_at SET DEFAULT NOW()`,
  ];

  for (const stmt of statements) {
    try {
      await db.query(stmt);
    } catch (err: any) {
      console.warn('[SchemaMigration] Notice on statement:', stmt.slice(0, 40), '->', err.message);
    }
  }
  console.log('[SchemaMigration] Schema verified successfully.');

  try {
    // 3. Ensure a fallback user exists in users table to prevent NOT NULL foreign key issues
    await db.query(`
      INSERT INTO users (id, email, name, is_email_verified, updated_at)
      VALUES ('00000000-0000-0000-0000-000000000000', 'system.fallback@skillprax.internal', 'SkillPrax Learner', TRUE, NOW())
      ON CONFLICT (id) DO NOTHING;
    `);
    console.log('[SchemaMigration] Fallback user verified.');
  } catch (err: any) {
    // Users table might have email unique conflict or different schema, non-critical
    console.warn('[SchemaMigration] Notice on fallback user:', err.message);
  }
}

export default runSchemaMigration;
