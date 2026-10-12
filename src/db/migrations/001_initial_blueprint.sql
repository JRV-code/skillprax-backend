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

-- 6. MAIDAN INTEGRATION: Sports Player Biometrics & Guardian Linking
CREATE TABLE IF NOT EXISTS sports_player_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(255),
  sport VARCHAR(100) NOT NULL,
  secondary_sports TEXT[] DEFAULT '{}',
  playing_position VARCHAR(100) NOT NULL,
  height_cm NUMERIC(5,2),
  weight_kg NUMERIC(5,2),
  achievements TEXT,
  certificates JSONB DEFAULT '[]',
  date_of_birth DATE NOT NULL DEFAULT '2008-01-01',
  is_minor BOOLEAN DEFAULT FALSE,
  guardian_name VARCHAR(150),
  guardian_phone VARCHAR(30),
  guardian_email VARCHAR(150),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, sport)
);

-- 7. MAIDAN INTEGRATION: Sports Clubs & Academies
CREATE TABLE IF NOT EXISTS sports_clubs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  club_name VARCHAR(200) NOT NULL,
  sports_offered TEXT[] NOT NULL,
  city VARCHAR(100) NOT NULL,
  address TEXT NOT NULL,
  latitude NUMERIC(10, 7) NOT NULL,
  longitude NUMERIC(10, 7) NOT NULL,
  timings VARCHAR(100) NOT NULL,
  competition_level VARCHAR(50) NOT NULL,
  monthly_fee NUMERIC(10, 2) NOT NULL,
  discounted_fee NUMERIC(10, 2) DEFAULT NULL,
  discount_label VARCHAR(100) DEFAULT NULL,
  facilities TEXT[] DEFAULT '{}',
  coaching_staff JSONB DEFAULT '[]',
  website_url TEXT,
  contact_phone VARCHAR(30),
  is_verified BOOLEAN DEFAULT FALSE,
  verification_docs JSONB DEFAULT '[]',
  created_at TIMESTAMP DEFAULT NOW()
);

-- 8. MAIDAN INTEGRATION: Scouting Requests & Privacy Unlock Matrix
CREATE TABLE IF NOT EXISTS sports_scouting_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id UUID REFERENCES sports_clubs(id) ON DELETE CASCADE,
  player_id VARCHAR(255) NOT NULL,
  status VARCHAR(30) DEFAULT 'pending',
  guardian_approved BOOLEAN DEFAULT FALSE,
  message TEXT,
  trial_date TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(club_id, player_id)
);

-- 9. MAIDAN INTEGRATION: Player Ratings & History
CREATE TABLE IF NOT EXISTS sports_player_ratings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id VARCHAR(255) NOT NULL,
  club_id UUID REFERENCES sports_clubs(id) ON DELETE CASCADE,
  overall_rating NUMERIC(3, 1) CHECK (overall_rating >= 1.0 AND overall_rating <= 5.0),
  technical_score INT,
  agility_score INT,
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 10. MAIDAN INTEGRATION: Sports Shop Catalog & Orders
CREATE TABLE IF NOT EXISTS sports_shop_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(200) NOT NULL,
  sport VARCHAR(100) NOT NULL,
  category VARCHAR(100) NOT NULL,
  price NUMERIC(10, 2) NOT NULL,
  image_url TEXT NOT NULL,
  seller_type VARCHAR(50) DEFAULT 'official',
  vendor_name VARCHAR(150),
  in_stock BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 11. MAIDAN INTEGRATION: Managed Travel Vans & Bookings
CREATE TABLE IF NOT EXISTS sports_travel_vans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  registration_number VARCHAR(50) NOT NULL,
  driver_name VARCHAR(150) NOT NULL,
  driver_phone VARCHAR(30) NOT NULL,
  license_last_four VARCHAR(4) NOT NULL,
  is_driver_verified BOOLEAN DEFAULT FALSE,
  route_title VARCHAR(255) NOT NULL,
  stops TEXT[] NOT NULL,
  total_seats INT NOT NULL DEFAULT 14,
  available_seats INT NOT NULL DEFAULT 14,
  monthly_fare NUMERIC(10, 2) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 12. MAIDAN INTEGRATION: Escrow Transactions
CREATE TABLE IF NOT EXISTS sports_escrow_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(255) NOT NULL,
  transaction_type VARCHAR(50) NOT NULL,
  reference_id VARCHAR(255) NOT NULL,
  amount NUMERIC(10, 2) NOT NULL,
  razorpay_payment_id VARCHAR(150),
  escrow_status VARCHAR(30) DEFAULT 'held',
  payout_released_at TIMESTAMP,
  refunded_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

