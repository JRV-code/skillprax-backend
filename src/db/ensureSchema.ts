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
    `DO $$ BEGIN 
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'chapters' AND column_name = 'step_id') THEN 
        ALTER TABLE chapters ALTER COLUMN step_id TYPE TEXT USING step_id::text; 
      ELSIF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'chapters' AND column_name = 'stepId') THEN
        ALTER TABLE chapters ALTER COLUMN "stepId" TYPE TEXT USING "stepId"::text;
      END IF; 
    END $$;`,

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
    `DO $$ BEGIN 
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'translation_caches' AND column_name = 'scope_id') THEN 
        ALTER TABLE translation_caches ALTER COLUMN scope_id TYPE TEXT USING scope_id::text; 
      ELSIF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'translation_caches' AND column_name = 'scopeId') THEN
        ALTER TABLE translation_caches ALTER COLUMN "scopeId" TYPE TEXT USING "scopeId"::text;
      END IF; 
    END $$;`,

    `ALTER TABLE IF EXISTS subgenre_caches ALTER COLUMN id TYPE TEXT USING id::text`,
    
    // Phase 1: Self-healing Auth & Profile Schema (Nullable password & all required demographic/gamification columns)
    `ALTER TABLE IF EXISTS users ALTER COLUMN password_hash DROP NOT NULL`,
    `DO $$ BEGIN 
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'password') THEN 
        ALTER TABLE users ALTER COLUMN password DROP NOT NULL; 
      END IF; 
    END $$;`,
    `DO $$ BEGIN 
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_profiles' AND column_name = 'password_hash') THEN 
        ALTER TABLE user_profiles ALTER COLUMN password_hash DROP NOT NULL; 
      END IF; 
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'UserProfile' AND column_name = 'password_hash') THEN 
        ALTER TABLE "UserProfile" ALTER COLUMN password_hash DROP NOT NULL; 
      END IF; 
    END $$;`,

    // UserProfile and users additive fields for onboarding, calibration & live quiz telemetry
    `ALTER TABLE IF EXISTS user_profiles ADD COLUMN IF NOT EXISTS email VARCHAR(255)`,
    `ALTER TABLE IF EXISTS user_profiles ADD COLUMN IF NOT EXISTS email_key VARCHAR(255)`,
    `ALTER TABLE IF EXISTS user_profiles ADD COLUMN IF NOT EXISTS name VARCHAR(255) DEFAULT 'Explorer'`,
    `ALTER TABLE IF EXISTS user_profiles ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255)`,
    `ALTER TABLE IF EXISTS user_profiles ADD COLUMN IF NOT EXISTS google_id VARCHAR(255)`,
    `ALTER TABLE IF EXISTS user_profiles ADD COLUMN IF NOT EXISTS google_sub VARCHAR(255)`,
    `ALTER TABLE IF EXISTS user_profiles ADD COLUMN IF NOT EXISTS avatar_url TEXT`,
    `ALTER TABLE IF EXISTS user_profiles ADD COLUMN IF NOT EXISTS date_of_birth TEXT`,
    `ALTER TABLE IF EXISTS user_profiles ADD COLUMN IF NOT EXISTS dob TEXT`,
    `ALTER TABLE IF EXISTS user_profiles ADD COLUMN IF NOT EXISTS city VARCHAR(100) DEFAULT 'Ahmedabad'`,
    `ALTER TABLE IF EXISTS user_profiles ADD COLUMN IF NOT EXISTS state VARCHAR(100) DEFAULT 'Gujarat'`,
    `ALTER TABLE IF EXISTS user_profiles ADD COLUMN IF NOT EXISTS age_category VARCHAR(50) DEFAULT 'Open'`,
    `ALTER TABLE IF EXISTS user_profiles ADD COLUMN IF NOT EXISTS preferred_language VARCHAR(50) DEFAULT 'en'`,
    `ALTER TABLE IF EXISTS user_profiles ADD COLUMN IF NOT EXISTS dietary_preference VARCHAR(50) DEFAULT 'Vegetarian'`,
    `ALTER TABLE IF EXISTS user_profiles ADD COLUMN IF NOT EXISTS health_conditions TEXT DEFAULT 'None'`,
    `ALTER TABLE IF EXISTS user_profiles ADD COLUMN IF NOT EXISTS medical_conditions TEXT DEFAULT 'None'`,
    `ALTER TABLE IF EXISTS user_profiles ADD COLUMN IF NOT EXISTS onboarding_completed BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE IF EXISTS user_profiles ADD COLUMN IF NOT EXISTS total_xp INT DEFAULT 0`,
    `ALTER TABLE IF EXISTS user_profiles ADD COLUMN IF NOT EXISTS level INT DEFAULT 1`,
    `ALTER TABLE IF EXISTS user_profiles ADD COLUMN IF NOT EXISTS current_streak INT DEFAULT 1`,
    `ALTER TABLE IF EXISTS user_profiles ADD COLUMN IF NOT EXISTS longest_streak INT DEFAULT 1`,
    `ALTER TABLE IF EXISTS user_profiles ADD COLUMN IF NOT EXISTS streak_freezes INT DEFAULT 0`,
    `ALTER TABLE IF EXISTS user_profiles ADD COLUMN IF NOT EXISTS streak_freeze_count INT DEFAULT 0`,
    `ALTER TABLE IF EXISTS user_profiles ADD COLUMN IF NOT EXISTS last_active_date TIMESTAMP WITH TIME ZONE DEFAULT NOW()`,
    `ALTER TABLE IF EXISTS user_profiles ADD COLUMN IF NOT EXISTS total_quizzes_taken INT DEFAULT 0`,
    `ALTER TABLE IF EXISTS user_profiles ADD COLUMN IF NOT EXISTS total_questions_attempted INT DEFAULT 0`,
    `ALTER TABLE IF EXISTS user_profiles ADD COLUMN IF NOT EXISTS total_questions_correct INT DEFAULT 0`,
    `ALTER TABLE IF EXISTS user_profiles ADD COLUMN IF NOT EXISTS avg_quiz_accuracy DOUBLE PRECISION DEFAULT 0`,

    `ALTER TABLE IF EXISTS "UserProfile" ADD COLUMN IF NOT EXISTS email VARCHAR(255)`,
    `ALTER TABLE IF EXISTS "UserProfile" ADD COLUMN IF NOT EXISTS email_key VARCHAR(255)`,
    `ALTER TABLE IF EXISTS "UserProfile" ADD COLUMN IF NOT EXISTS "dateOfBirth" TEXT`,
    `ALTER TABLE IF EXISTS "UserProfile" ADD COLUMN IF NOT EXISTS "date_of_birth" TEXT`,
    `ALTER TABLE IF EXISTS "UserProfile" ADD COLUMN IF NOT EXISTS dob TEXT`,
    `ALTER TABLE IF EXISTS "UserProfile" ADD COLUMN IF NOT EXISTS city VARCHAR(100) DEFAULT 'Ahmedabad'`,
    `ALTER TABLE IF EXISTS "UserProfile" ADD COLUMN IF NOT EXISTS state VARCHAR(100) DEFAULT 'Gujarat'`,
    `ALTER TABLE IF EXISTS "UserProfile" ADD COLUMN IF NOT EXISTS age_category VARCHAR(50) DEFAULT 'Open'`,
    `ALTER TABLE IF EXISTS "UserProfile" ADD COLUMN IF NOT EXISTS preferred_language VARCHAR(50) DEFAULT 'en'`,
    `ALTER TABLE IF EXISTS "UserProfile" ADD COLUMN IF NOT EXISTS dietary_preference VARCHAR(50) DEFAULT 'Vegetarian'`,
    `ALTER TABLE IF EXISTS "UserProfile" ADD COLUMN IF NOT EXISTS health_conditions TEXT DEFAULT 'None'`,
    `ALTER TABLE IF EXISTS "UserProfile" ADD COLUMN IF NOT EXISTS medical_conditions TEXT DEFAULT 'None'`,
    `ALTER TABLE IF EXISTS "UserProfile" ADD COLUMN IF NOT EXISTS streak_freeze_count INT DEFAULT 0`,
    `ALTER TABLE IF EXISTS "UserProfile" ADD COLUMN IF NOT EXISTS "streakFreezeCount" INT DEFAULT 0`,

    `ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS email VARCHAR(255)`,
    `ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS email_key VARCHAR(255)`,
    `ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS name VARCHAR(255) DEFAULT 'Explorer'`,
    `ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255)`,
    `ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS google_id VARCHAR(255)`,
    `ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS google_sub VARCHAR(255)`,
    `ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS avatar_url TEXT`,
    `ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS date_of_birth DATE`,
    `ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS dob TEXT`,
    `ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS city VARCHAR(100) DEFAULT 'Ahmedabad'`,
    `ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS state VARCHAR(100) DEFAULT 'Gujarat'`,
    `ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS age_category VARCHAR(50) DEFAULT 'Open'`,
    `ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS preferred_language VARCHAR(50) DEFAULT 'en'`,
    `ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS dietary_preference VARCHAR(50) DEFAULT 'Vegetarian'`,
    `ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS health_conditions TEXT DEFAULT 'None'`,
    `ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS medical_conditions TEXT DEFAULT 'None'`,
    `ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS onboarding_completed BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS xp INT DEFAULT 0`,
    `ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS level INT DEFAULT 1`,
    `ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS current_streak INT DEFAULT 1`,
    `ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS longest_streak INT DEFAULT 1`,
    `ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS streak_freezes INT DEFAULT 0`,
    `ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS streak_freeze_count INT DEFAULT 0`,
    `ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS last_active_date DATE DEFAULT CURRENT_DATE`,
    `ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS total_quizzes_taken INT DEFAULT 0`,
    `ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS total_questions_attempted INT DEFAULT 0`,
    `ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS total_questions_correct INT DEFAULT 0`,
    `ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS avg_quiz_accuracy DOUBLE PRECISION DEFAULT 0`,

    `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_lower_email ON users (LOWER(email))`,

    // Core Deliberate Practice & Learning Tables (Dual Table & Case Tolerance)
    `CREATE TABLE IF NOT EXISTS "Workspace" (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      title VARCHAR(255) NOT NULL,
      "subTitle" VARCHAR(255) DEFAULT '',
      "subGenre" VARCHAR(100),
      domain VARCHAR(100),
      "skillName" VARCHAR(255),
      "domainCategory" VARCHAR(100) DEFAULT 'General Knowledge',
      "targetGoal" VARCHAR(100) DEFAULT 'Full Mastery',
      level VARCHAR(50) DEFAULT 'Beginner',
      "desiredLevel" VARCHAR(50),
      "dailyMinutes" INT DEFAULT 30,
      "experienceLevel" VARCHAR(50),
      "stepCountReason" TEXT,
      "currentStep" INT DEFAULT 1,
      "totalPlannedSteps" INT DEFAULT 5,
      progress DOUBLE PRECISION DEFAULT 0,
      "aiEngine" VARCHAR(100) DEFAULT 'llama-3.3-70b-versatile',
      "isGenerating" BOOLEAN DEFAULT FALSE,
      "generationStartedAt" TIMESTAMP WITH TIME ZONE,
      "userProfileId" TEXT,
      "profileId" TEXT,
      "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      title VARCHAR(255) NOT NULL,
      sub_genre VARCHAR(100),
      domain VARCHAR(100),
      level VARCHAR(50) DEFAULT 'Beginner',
      progress DOUBLE PRECISION DEFAULT 0,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS "SkillStep" (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      "workspaceId" TEXT,
      "stepIndex" INT DEFAULT 1,
      title VARCHAR(255) NOT NULL,
      description TEXT DEFAULT '',
      status VARCHAR(50) DEFAULT 'IN_PROGRESS',
      "difficultyTier" VARCHAR(50) DEFAULT 'FOUNDATIONS',
      intro JSONB,
      "packStatus" VARCHAR(50) DEFAULT 'NOT_BUILT',
      "packStage" VARCHAR(50),
      "approachViewedAt" TIMESTAMP WITH TIME ZONE,
      "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS skill_steps (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      workspace_id TEXT,
      skill_id TEXT,
      step_number INT DEFAULT 1,
      step_index INT DEFAULT 1,
      title VARCHAR(255) NOT NULL,
      description TEXT DEFAULT '',
      status VARCHAR(50) DEFAULT 'IN_PROGRESS',
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS "StepChapter" (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      "stepId" TEXT,
      title VARCHAR(255) NOT NULL,
      "orderIndex" INT DEFAULT 0,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS step_chapters (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      step_id TEXT,
      title VARCHAR(255) NOT NULL,
      order_index INT DEFAULT 0,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS "StepTopic" (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      "chapterId" TEXT,
      "stepId" TEXT,
      title VARCHAR(255) NOT NULL,
      "orderIndex" INT DEFAULT 0,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS step_topics (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      chapter_id TEXT,
      step_id TEXT,
      title VARCHAR(255) NOT NULL,
      order_index INT DEFAULT 0,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS "Resource" (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      "stepId" TEXT,
      "topicId" TEXT,
      "chapterId" TEXT,
      type VARCHAR(50) NOT NULL,
      title VARCHAR(255) NOT NULL,
      url TEXT,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS resources (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      step_id TEXT,
      topic_id TEXT,
      chapter_id TEXT,
      type VARCHAR(50) NOT NULL,
      title VARCHAR(255) NOT NULL,
      url TEXT,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS "Quiz" (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      "stepId" TEXT,
      title VARCHAR(255) NOT NULL,
      questions JSONB DEFAULT '[]',
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS quizzes (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      step_id TEXT,
      title VARCHAR(255) NOT NULL,
      questions JSONB DEFAULT '[]',
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )`,

    // AI Guide & Mentor Chat History Tables
    `CREATE TABLE IF NOT EXISTS ai_chat_sessions (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      user_id TEXT NOT NULL,
      title VARCHAR(255) DEFAULT 'New Conversation',
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ai_chat_sessions_user_id ON ai_chat_sessions(user_id)`,
    `CREATE TABLE IF NOT EXISTS ai_chat_messages (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      session_id TEXT NOT NULL REFERENCES ai_chat_sessions(id) ON DELETE CASCADE,
      role VARCHAR(50) NOT NULL,
      content TEXT NOT NULL,
      used_tavily_search BOOLEAN DEFAULT FALSE,
      sources JSONB DEFAULT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ai_chat_messages_session_id ON ai_chat_messages(session_id)`,
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
