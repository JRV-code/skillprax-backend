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

    // 5. XP columns
    try {
      await prisma.$executeRawUnsafe(`
        ALTER TABLE users ADD COLUMN IF NOT EXISTS xp INT DEFAULT 0;
      `);
    } catch {}

    console.log('[Schema] Module 7 database schema verified successfully.');
  } catch (err) {
    console.warn('[Schema] Schema initialization warning (remote DB may differ):', err);
  }
}

export default ensureDatabaseSchema;
