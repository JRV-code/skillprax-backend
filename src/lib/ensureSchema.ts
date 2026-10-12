import prisma from './prisma';

export async function ensureDatabaseSchema() {
  try {
    console.log('[Schema] Checking and initializing Module 7 database schema...');

    // 1. user_sports_profiles
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS user_sports_profiles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id VARCHAR(255),
        sport_name VARCHAR(100) NOT NULL,
        sub_genre VARCHAR(100) NOT NULL,
        dietary_preference VARCHAR(50) NOT NULL DEFAULT 'Vegetarian',
        medical_conditions TEXT DEFAULT 'None',
        training_goal VARCHAR(100) DEFAULT 'Agility & Reflexes',
        daily_practice_minutes INT DEFAULT 45,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // 2. sports_daily_plans
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS sports_daily_plans (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_sports_id UUID REFERENCES user_sports_profiles(id) ON DELETE CASCADE,
        day_number INT NOT NULL,
        drills JSONB NOT NULL,
        nutrition_plan JSONB NOT NULL,
        is_completed BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // 3. user_milestones
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS user_milestones (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id VARCHAR(255) NOT NULL,
        skill_id VARCHAR(100) NOT NULL,
        milestone_order INT NOT NULL,
        title VARCHAR(255) NOT NULL,
        status VARCHAR(30) DEFAULT 'locked',
        quiz_score INT DEFAULT NULL,
        unlocked_at TIMESTAMP,
        completed_at TIMESTAMP,
        UNIQUE(user_id, skill_id, milestone_order)
      );
    `);

    // 4. content_translations
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS content_translations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        content_id VARCHAR(255) NOT NULL,
        language_code VARCHAR(10) NOT NULL,
        translated_quadrants JSONB NOT NULL,
        translated_markdown TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(content_id, language_code)
      );
    `);

    // 5. XP & User Identity/Demographic columns
    try {
      await prisma.$executeRawUnsafe(`
        ALTER TABLE users 
        ADD COLUMN IF NOT EXISTS xp INT DEFAULT 0,
        ADD COLUMN IF NOT EXISTS dietary_preference VARCHAR(50) DEFAULT 'Vegetarian',
        ADD COLUMN IF NOT EXISTS medical_conditions TEXT DEFAULT 'None',
        ADD COLUMN IF NOT EXISTS preferred_language VARCHAR(20) DEFAULT 'en',
        ADD COLUMN IF NOT EXISTS total_skills_completed INT DEFAULT 0,
        ADD COLUMN IF NOT EXISTS current_streak INT DEFAULT 0,
        ADD COLUMN IF NOT EXISTS longest_streak INT DEFAULT 0,
        ADD COLUMN IF NOT EXISTS last_active_date DATE DEFAULT CURRENT_DATE;
      `);
    } catch (err) {
      console.warn('[Schema] Users table alter warning:', err);
    }

    // 6. user_skills (Master Blueprint Section 1)
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS user_skills (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id VARCHAR(255),
        skill_name VARCHAR(150) NOT NULL,
        skill_category VARCHAR(50) NOT NULL,
        sub_genre VARCHAR(150) NOT NULL,
        target_mastery_level VARCHAR(50) NOT NULL,
        total_steps INT NOT NULL DEFAULT 5,
        current_step INT NOT NULL DEFAULT 1,
        is_completed BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // 7. skill_steps (Master Blueprint Section 1)
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS skill_steps (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        skill_id UUID REFERENCES user_skills(id) ON DELETE CASCADE,
        step_number INT NOT NULL,
        title VARCHAR(255) NOT NULL,
        description TEXT NOT NULL,
        required_practice_days INT DEFAULT 1,
        practice_days_completed INT DEFAULT 0,
        quiz_passed BOOLEAN DEFAULT FALSE,
        quiz_score INT DEFAULT NULL,
        video_url TEXT NOT NULL,
        video_id VARCHAR(100) NOT NULL,
        documentation_markdown TEXT NOT NULL,
        documentation_source_url TEXT,
        documentation_quadrants JSONB NOT NULL,
        daily_diet_plan JSONB DEFAULT NULL,
        is_unlocked BOOLEAN DEFAULT FALSE,
        is_completed BOOLEAN DEFAULT FALSE,
        UNIQUE(skill_id, step_number)
      );
    `);

    // 8. user_resource_history (Global Anti-Duplication Vault)
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS user_resource_history (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id VARCHAR(255),
        resource_type VARCHAR(50) NOT NULL,
        resource_identifier TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id, resource_type, resource_identifier)
      );
    `);

    console.log('[Schema] All Master Blueprint schemas verified successfully.');
  } catch (err) {
    console.warn('[Schema] Schema initialization warning (remote DB may differ):', err);
  }
}

export default ensureDatabaseSchema;
