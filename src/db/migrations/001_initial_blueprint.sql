-- ============================================================================
-- 001_initial_blueprint.sql
-- Master Architecture Blueprint: Database Persistence & User Identity Synchronization
-- ============================================================================

-- 1. Ensure users table exists and has identity & demographic fields
CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  email VARCHAR(255) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  avatar_url TEXT,
  google_id VARCHAR(255),
  is_email_verified BOOLEAN DEFAULT TRUE,
  gender VARCHAR(50) DEFAULT 'Prefer not to say',
  profession VARCHAR(255) DEFAULT 'Student',
  daily_reminder_enabled BOOLEAN DEFAULT TRUE,
  preferred_reminder_time VARCHAR(20) DEFAULT '19:00',
  timezone VARCHAR(50) DEFAULT 'UTC',
  last_reminder_sent_at TIMESTAMP,
  last_practice_date VARCHAR(50),
  xp INT DEFAULT 0,
  dietary_preference VARCHAR(50) DEFAULT 'Vegetarian',
  medical_conditions TEXT DEFAULT 'None',
  preferred_language VARCHAR(20) DEFAULT 'en',
  total_skills_completed INT DEFAULT 0,
  current_streak INT DEFAULT 0,
  longest_streak INT DEFAULT 0,
  last_active_date DATE DEFAULT CURRENT_DATE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Ensure demographic columns exist if users table already pre-existed
ALTER TABLE users 
ADD COLUMN IF NOT EXISTS dietary_preference VARCHAR(50) DEFAULT 'Vegetarian',
ADD COLUMN IF NOT EXISTS medical_conditions TEXT DEFAULT 'None',
ADD COLUMN IF NOT EXISTS preferred_language VARCHAR(20) DEFAULT 'en',
ADD COLUMN IF NOT EXISTS total_skills_completed INT DEFAULT 0,
ADD COLUMN IF NOT EXISTS current_streak INT DEFAULT 0,
ADD COLUMN IF NOT EXISTS longest_streak INT DEFAULT 0,
ADD COLUMN IF NOT EXISTS last_active_date DATE DEFAULT CURRENT_DATE;

-- 2. User Skills & Progression Tree
CREATE TABLE IF NOT EXISTS user_skills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(255),
  skill_name VARCHAR(150) NOT NULL,
  skill_category VARCHAR(50) NOT NULL, -- 'cognitive' OR 'physical'
  sub_genre VARCHAR(150) NOT NULL,
  target_mastery_level VARCHAR(50) NOT NULL, -- 'Beginner', 'Intermediate', 'Advanced', 'Mastery'
  total_steps INT NOT NULL DEFAULT 5,
  current_step INT NOT NULL DEFAULT 1,
  is_completed BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- 3. Step Content & Anti-Repetition Registry
CREATE TABLE IF NOT EXISTS skill_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id UUID REFERENCES user_skills(id) ON DELETE CASCADE,
  step_number INT NOT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  required_practice_days INT DEFAULT 1, -- Set dynamically for physical skills
  practice_days_completed INT DEFAULT 0,
  quiz_passed BOOLEAN DEFAULT FALSE,
  quiz_score INT DEFAULT NULL,
  video_url TEXT NOT NULL,
  video_id VARCHAR(100) NOT NULL,
  documentation_markdown TEXT NOT NULL,
  documentation_source_url TEXT,
  documentation_quadrants JSONB NOT NULL,
  daily_diet_plan JSONB DEFAULT NULL, -- Daily athletic fueling for physical skills
  is_unlocked BOOLEAN DEFAULT FALSE,
  is_completed BOOLEAN DEFAULT FALSE,
  UNIQUE(skill_id, step_number)
);

-- 4. Global Anti-Duplication Vault (Prevents repeated videos, links, or questions)
CREATE TABLE IF NOT EXISTS user_resource_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(255),
  skill_id VARCHAR(255),
  step_number INT,
  resource_type VARCHAR(50) NOT NULL, -- 'video_id', 'doc_url', 'quiz_question_hash'
  resource_identifier TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, resource_type, resource_identifier)
);

ALTER TABLE user_resource_history
ADD COLUMN IF NOT EXISTS skill_id VARCHAR(255),
ADD COLUMN IF NOT EXISTS step_number INT;

-- 5. Authentic Reviews Table
CREATE TABLE IF NOT EXISTS reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(255),
  profile_id VARCHAR(255),
  user_name VARCHAR(150) NOT NULL,
  user_avatar TEXT,
  skill_tag VARCHAR(100),
  rating INT CHECK (rating >= 1 AND rating <= 5),
  comment TEXT,
  review_text TEXT,
  status VARCHAR(50) DEFAULT 'published',
  is_verified BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
