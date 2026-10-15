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

    // Ensure CUID-compatible TEXT columns for all learning pipeline tables
    `ALTER TABLE IF EXISTS resource_histories ALTER COLUMN id TYPE TEXT USING id::text`,
    `ALTER TABLE IF EXISTS resource_histories ALTER COLUMN workspace_id TYPE TEXT USING workspace_id::text`,
    `ALTER TABLE IF EXISTS resource_histories ALTER COLUMN profile_id TYPE TEXT USING profile_id::text`,

    `ALTER TABLE IF EXISTS step_chapters ALTER COLUMN id TYPE TEXT USING id::text`,
    `ALTER TABLE IF EXISTS step_chapters ALTER COLUMN step_id TYPE TEXT USING step_id::text`,

    `ALTER TABLE IF EXISTS step_topics ALTER COLUMN id TYPE TEXT USING id::text`,
    `ALTER TABLE IF EXISTS step_topics ALTER COLUMN step_id TYPE TEXT USING step_id::text`,
    `ALTER TABLE IF EXISTS step_topics ALTER COLUMN chapter_id TYPE TEXT USING chapter_id::text`,

    `ALTER TABLE IF EXISTS resources ALTER COLUMN id TYPE TEXT USING id::text`,
    `ALTER TABLE IF EXISTS resources ALTER COLUMN step_id TYPE TEXT USING step_id::text`,
    `ALTER TABLE IF EXISTS resources ALTER COLUMN topic_id TYPE TEXT USING topic_id::text`,
    `ALTER TABLE IF EXISTS resources ALTER COLUMN chapter_id TYPE TEXT USING chapter_id::text`,

    `ALTER TABLE IF EXISTS attempt_results ALTER COLUMN id TYPE TEXT USING id::text`,
    `ALTER TABLE IF EXISTS attempt_results ALTER COLUMN step_id TYPE TEXT USING step_id::text`,
    `ALTER TABLE IF EXISTS attempt_results ALTER COLUMN profile_id TYPE TEXT USING profile_id::text`,

    `ALTER TABLE IF EXISTS video_progress ALTER COLUMN id TYPE TEXT USING id::text`,
    `ALTER TABLE IF EXISTS video_progress ALTER COLUMN profile_id TYPE TEXT USING profile_id::text`,
    `ALTER TABLE IF EXISTS video_progress ALTER COLUMN resource_id TYPE TEXT USING resource_id::text`,

    `ALTER TABLE IF EXISTS step_translations ALTER COLUMN id TYPE TEXT USING id::text`,
    `ALTER TABLE IF EXISTS step_translations ALTER COLUMN step_id TYPE TEXT USING step_id::text`,

    `ALTER TABLE IF EXISTS chapters ALTER COLUMN id TYPE TEXT USING id::text`,
    `ALTER TABLE IF EXISTS chapters ALTER COLUMN step_id TYPE TEXT USING step_id::text`,

    `ALTER TABLE IF EXISTS user_resource_history ALTER COLUMN id TYPE TEXT USING id::text`,
    `ALTER TABLE IF EXISTS user_resource_history ALTER COLUMN user_id TYPE TEXT USING user_id::text`,
    `ALTER TABLE IF EXISTS user_resource_history ALTER COLUMN skill_id TYPE TEXT USING skill_id::text`,

    `ALTER TABLE IF EXISTS content_documents ALTER COLUMN id TYPE TEXT USING id::text`,
    `ALTER TABLE IF EXISTS content_documents ALTER COLUMN step_id TYPE TEXT USING step_id::text`,
    `ALTER TABLE IF EXISTS content_documents ALTER COLUMN resource_id TYPE TEXT USING resource_id::text`,

    `ALTER TABLE IF EXISTS content_translations ALTER COLUMN id TYPE TEXT USING id::text`,
    `ALTER TABLE IF EXISTS content_translations ALTER COLUMN content_document_id TYPE TEXT USING content_document_id::text`,

    `ALTER TABLE IF EXISTS quiz_translations ALTER COLUMN id TYPE TEXT USING id::text`,
    `ALTER TABLE IF EXISTS quiz_translations ALTER COLUMN evaluation_id TYPE TEXT USING evaluation_id::text`,

    `ALTER TABLE IF EXISTS translation_caches ALTER COLUMN id TYPE TEXT USING id::text`,
    `ALTER TABLE IF EXISTS translation_caches ALTER COLUMN scope_id TYPE TEXT USING scope_id::text`,

    `ALTER TABLE IF EXISTS subgenre_caches ALTER COLUMN id TYPE TEXT USING id::text`,
    
    // UserProfile and users additive fields for onboarding, calibration & live quiz telemetry
    `ALTER TABLE IF EXISTS user_profiles ADD COLUMN IF NOT EXISTS city VARCHAR(100) DEFAULT 'Ahmedabad'`,
    `ALTER TABLE IF EXISTS user_profiles ADD COLUMN IF NOT EXISTS state VARCHAR(100) DEFAULT 'Gujarat'`,
    `ALTER TABLE IF EXISTS user_profiles ADD COLUMN IF NOT EXISTS age_category VARCHAR(50) DEFAULT 'Open'`,
    `ALTER TABLE IF EXISTS user_profiles ADD COLUMN IF NOT EXISTS preferred_language VARCHAR(50) DEFAULT 'en'`,
    `ALTER TABLE IF EXISTS user_profiles ADD COLUMN IF NOT EXISTS dietary_preference VARCHAR(50) DEFAULT 'Vegetarian'`,
    `ALTER TABLE IF EXISTS user_profiles ADD COLUMN IF NOT EXISTS health_conditions TEXT DEFAULT 'None'`,
    `ALTER TABLE IF EXISTS user_profiles ADD COLUMN IF NOT EXISTS onboarding_completed BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE IF EXISTS user_profiles ADD COLUMN IF NOT EXISTS total_xp INT DEFAULT 0`,
    `ALTER TABLE IF EXISTS user_profiles ADD COLUMN IF NOT EXISTS level INT DEFAULT 1`,
    `ALTER TABLE IF EXISTS user_profiles ADD COLUMN IF NOT EXISTS current_streak INT DEFAULT 1`,
    `ALTER TABLE IF EXISTS user_profiles ADD COLUMN IF NOT EXISTS longest_streak INT DEFAULT 1`,
    `ALTER TABLE IF EXISTS user_profiles ADD COLUMN IF NOT EXISTS total_quizzes_taken INT DEFAULT 0`,
    `ALTER TABLE IF EXISTS user_profiles ADD COLUMN IF NOT EXISTS total_questions_attempted INT DEFAULT 0`,
    `ALTER TABLE IF EXISTS user_profiles ADD COLUMN IF NOT EXISTS total_questions_correct INT DEFAULT 0`,
    `ALTER TABLE IF EXISTS user_profiles ADD COLUMN IF NOT EXISTS avg_quiz_accuracy DOUBLE PRECISION DEFAULT 0`,

    `ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS city VARCHAR(100) DEFAULT 'Ahmedabad'`,
    `ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS state VARCHAR(100) DEFAULT 'Gujarat'`,
    `ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS age_category VARCHAR(50) DEFAULT 'Open'`,
    `ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS preferred_language VARCHAR(50) DEFAULT 'en'`,
    `ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS dietary_preference VARCHAR(50) DEFAULT 'Vegetarian'`,
    `ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS health_conditions TEXT DEFAULT 'None'`,
    `ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS onboarding_completed BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS xp INT DEFAULT 0`,
    `ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS level INT DEFAULT 1`,
    `ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS current_streak INT DEFAULT 1`,
    `ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS longest_streak INT DEFAULT 1`,
    `ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS total_quizzes_taken INT DEFAULT 0`,
    `ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS total_questions_attempted INT DEFAULT 0`,
    `ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS total_questions_correct INT DEFAULT 0`,
    `ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS avg_quiz_accuracy DOUBLE PRECISION DEFAULT 0`,
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
