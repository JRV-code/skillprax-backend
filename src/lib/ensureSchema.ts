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

    // 0. Ensure users table exists with identity and geolocation columns
    try {
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS users (
          id VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid()::text,
          email VARCHAR(255) UNIQUE NOT NULL,
          name VARCHAR(255) NOT NULL,
          password_hash VARCHAR(255),
          avatar_url TEXT,
          google_id VARCHAR(255),
          is_email_verified BOOLEAN DEFAULT TRUE,
          gender VARCHAR(50) DEFAULT 'Prefer not to say',
          profession VARCHAR(255) DEFAULT 'Student',
          city VARCHAR(100) DEFAULT 'Ahmedabad',
          state VARCHAR(100) DEFAULT 'Gujarat',
          daily_reminder_enabled BOOLEAN DEFAULT TRUE,
          preferred_reminder_time VARCHAR(20) DEFAULT '19:00',
          timezone VARCHAR(50) DEFAULT 'UTC',
          xp INT DEFAULT 0,
          date_of_birth DATE,
          guardian_name VARCHAR(150),
          guardian_phone VARCHAR(30),
          guardian_email VARCHAR(150),
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
      `);
    } catch (err) {
      console.warn('[Schema] Users table creation notice:', err);
    }

    // 5. XP & User Identity/Demographic/Geolocation columns
    try {
      await prisma.$executeRawUnsafe(`
        ALTER TABLE users 
        ADD COLUMN IF NOT EXISTS xp INT DEFAULT 0,
        ADD COLUMN IF NOT EXISTS date_of_birth DATE,
        ADD COLUMN IF NOT EXISTS guardian_name VARCHAR(150),
        ADD COLUMN IF NOT EXISTS guardian_phone VARCHAR(30),
        ADD COLUMN IF NOT EXISTS guardian_email VARCHAR(150),
        ADD COLUMN IF NOT EXISTS dietary_preference VARCHAR(50) DEFAULT 'Vegetarian',
        ADD COLUMN IF NOT EXISTS medical_conditions TEXT DEFAULT 'None',
        ADD COLUMN IF NOT EXISTS preferred_language VARCHAR(20) DEFAULT 'en',
        ADD COLUMN IF NOT EXISTS total_skills_completed INT DEFAULT 0,
        ADD COLUMN IF NOT EXISTS current_streak INT DEFAULT 0,
        ADD COLUMN IF NOT EXISTS longest_streak INT DEFAULT 0,
        ADD COLUMN IF NOT EXISTS last_active_date DATE DEFAULT CURRENT_DATE,
        ADD COLUMN IF NOT EXISTS city VARCHAR(100) DEFAULT 'Ahmedabad',
        ADD COLUMN IF NOT EXISTS state VARCHAR(100) DEFAULT 'Gujarat',
        ADD COLUMN IF NOT EXISTS google_id VARCHAR(255),
        ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);
      `);
    } catch (err) {
      console.warn('[Schema] Users table alter warning:', err);
    }

    try {
      await prisma.$executeRawUnsafe(`
        ALTER TABLE user_profiles
        ADD COLUMN IF NOT EXISTS city VARCHAR(100) DEFAULT 'Ahmedabad',
        ADD COLUMN IF NOT EXISTS state VARCHAR(100) DEFAULT 'Gujarat';
      `);
    } catch (_) {}

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
        skill_id VARCHAR(255),
        step_number INT,
        resource_type VARCHAR(50) NOT NULL,
        resource_identifier TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id, resource_type, resource_identifier)
      );
    `);
    try {
      await prisma.$executeRawUnsafe(`
        ALTER TABLE skill_steps
        ADD COLUMN IF NOT EXISTS topics JSONB DEFAULT '[]'::jsonb,
        ADD COLUMN IF NOT EXISTS is_sourced BOOLEAN DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS quiz_data JSONB DEFAULT '[]'::jsonb,
        ADD COLUMN IF NOT EXISTS video_title VARCHAR(255),
        ADD COLUMN IF NOT EXISTS video_mini_guide TEXT,
        ADD COLUMN IF NOT EXISTS doc_title VARCHAR(255),
        ADD COLUMN IF NOT EXISTS doc_url TEXT,
        ADD COLUMN IF NOT EXISTS doc_domain VARCHAR(255),
        ADD COLUMN IF NOT EXISTS doc_mini_guide TEXT,
        ADD COLUMN IF NOT EXISTS step_explanation TEXT;
      `);
      await prisma.$executeRawUnsafe(`
        ALTER TABLE user_resource_history
        ADD COLUMN IF NOT EXISTS skill_id VARCHAR(255),
        ADD COLUMN IF NOT EXISTS step_number INT;
      `);
      await prisma.$executeRawUnsafe(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_user_res_hist_uniq 
        ON user_resource_history(user_id, resource_type, resource_identifier);
      `);
      await prisma.$executeRawUnsafe(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_user_res_hist_user_ident
        ON user_resource_history(user_id, resource_identifier);
      `);
    } catch (_) {}

    // 9. reviews (Authentic-Only Reviews Table)
    await prisma.$executeRawUnsafe(`
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
    `);

    // 10. MAIDAN INTEGRATION: sports_player_profiles (Module 8 - Table 1)
    await prisma.$executeRawUnsafe(`
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
    `);

    // 11. MAIDAN INTEGRATION: sports_clubs (Module 8 - Table 2)
    await prisma.$executeRawUnsafe(`
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
    `);

    // 12. MAIDAN INTEGRATION: sports_scouting_requests (Module 8 - Table 3)
    await prisma.$executeRawUnsafe(`
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
    `);

    // 13. MAIDAN INTEGRATION: sports_player_ratings (Module 8 - Table 4)
    await prisma.$executeRawUnsafe(`
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
    `);

    // 14. MAIDAN INTEGRATION: sports_shop_products (Module 8 - Table 5)
    await prisma.$executeRawUnsafe(`
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
    `);

    // 15. MAIDAN INTEGRATION: sports_travel_vans (Module 8 - Table 6)
    await prisma.$executeRawUnsafe(`
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
    `);

    // 16. MAIDAN INTEGRATION: sports_escrow_transactions (Module 8 - Table 7)
    await prisma.$executeRawUnsafe(`
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
    `);

    // Initial Seed: Verified Clubs & Academies
    const clubCountRes: any = await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int as count FROM sports_clubs;`);
    const clubCount = Number(clubCountRes?.[0]?.count || 0);
    if (clubCount === 0) {
      await prisma.$executeRawUnsafe(`
        INSERT INTO sports_clubs (
          club_name, sports_offered, city, address, latitude, longitude, timings,
          competition_level, monthly_fee, discounted_fee, discount_label, facilities,
          coaching_staff, website_url, contact_phone, is_verified
        ) VALUES
        (
          'Gandhinagar Football Academy',
          ARRAY['Football'],
          'Gandhinagar',
          'Sector 21 Stadium Grounds, Near Akshardham Highway, Gandhinagar, Gujarat 382021',
          23.2156, 72.6369,
          '06:00 AM - 09:30 AM, 04:30 PM - 07:30 PM',
          'State',
          2500.00, 2125.00, '15% off admission this month',
          ARRAY['Floodlights', 'FIFA Standard Turf', 'Physiotherapy Center', 'Changing Rooms'],
          '[{"name": "Coach Rajesh Vaghela", "role": "Head Coach", "license": "AFC A-License"}, {"name": "Arjun Patel", "role": "Strength & Conditioning", "license": "CSCS"}]'::jsonb,
          'https://gfa.gujaratfootball.org',
          '+91 79 2322 4110',
          TRUE
        ),
        (
          'Ahmedabad City FC Youth Academy',
          ARRAY['Football'],
          'Ahmedabad',
          'Sindhu Bhavan Road, Bodakdev, Ahmedabad, Gujarat 380054',
          23.0450, 72.5050,
          '06:30 AM - 10:00 AM, 04:00 PM - 08:00 PM',
          'National',
          3500.00, 2975.00, '15% Student Discount',
          ARRAY['Natural Grass Pitch', 'Tactical Video Room', 'Modern Gym', 'Ice Bath Recovery'],
          '[{"name": "Diego Fernandez", "role": "Technical Director", "license": "UEFA Pro"}, {"name": "Karan Shah", "role": "Goalkeeping Coach", "license": "AIFF Level 2"}]'::jsonb,
          'https://ahmedabadcityfc.com',
          '+91 79 4001 8899',
          TRUE
        ),
        (
          'Gujarat Cricket Association Motera Academy',
          ARRAY['Cricket'],
          'Ahmedabad',
          'Narendra Modi Stadium Complex, Motera, Ahmedabad, Gujarat 380005',
          23.0924, 72.5976,
          '06:00 AM - 11:00 AM, 03:30 PM - 07:30 PM',
          'National',
          4500.00, 3825.00, '15% off Summer Camp',
          ARRAY['12 Turf Wickets', 'Indoor Nets with Merlyn Spin Machines', 'Biomechanics Lab', 'Olympic Gym'],
          '[{"name": "Sunil Joshi", "role": "Chief Cricket Mentor", "license": "BCCI Level 3"}, {"name": "Prakash Parmar", "role": "Fast Bowling Specialist", "license": "BCCI Level 2"}]'::jsonb,
          'https://gca.cricket',
          '+91 79 2750 9922',
          TRUE
        ),
        (
          'Gandhinagar Premier Cricket Club',
          ARRAY['Cricket'],
          'Gandhinagar',
          'Sector 7 Sports Complex, Gandhinagar, Gujarat 382007',
          23.2300, 72.6500,
          '06:30 AM - 09:30 AM, 04:00 PM - 07:00 PM',
          'District',
          2200.00, NULL, NULL,
          ARRAY['Concrete & Turf Nets', 'Floodlit Practice Cage', 'Bowling Machine'],
          '[{"name": "Dharmesh Desai", "role": "Head Coach", "license": "BCCI Level 1"}]'::jsonb,
          'https://gpcc-sports.in',
          '+91 98251 33445',
          TRUE
        ),
        (
          'Sardar Patel Aquatic Complex',
          ARRAY['Swimming'],
          'Ahmedabad',
          'Opposite Commerce College, Navrangpura, Ahmedabad, Gujarat 380009',
          23.0370, 72.5580,
          '06:00 AM - 10:00 AM, 04:30 PM - 08:30 PM',
          'State',
          2800.00, 2380.00, '15% Seasonal Pass Discount',
          ARRAY['Olympic 50m 8-Lane Pool', 'Heated 25m Short Course', 'Underwater Stroke Cameras', 'Certified Lifeguards'],
          '[{"name": "Meera Trivedi", "role": "Head Swimming Coach", "license": "FINA Certified Level 2"}]'::jsonb,
          'https://ahmedabadaquatics.org',
          '+91 79 2644 1234',
          TRUE
        ),
        (
          'Surat Hoops Elite Basketball Center',
          ARRAY['Basketball'],
          'Surat',
          'City Light Road, Athwa, Surat, Gujarat 395007',
          21.1702, 72.8311,
          '06:00 AM - 09:30 AM, 05:00 PM - 09:00 PM',
          'State',
          2400.00, NULL, NULL,
          ARRAY['Imported Maple Wood Indoor Court', 'Hydraulic Breakaway Hoops', 'Drish Shooter Machine'],
          '[{"name": "Harshil Patel", "role": "Head Basketball Coach", "license": "FIBA Level 1"}]'::jsonb,
          'https://surathoops.in',
          '+91 261 225 9900',
          TRUE
        ),
        (
          'Bengaluru United Athletics & Tennis Academy',
          ARRAY['Tennis', 'Athletics'],
          'Bengaluru',
          'Kanteerava Sports Center, Kasturba Road, Bengaluru, Karnataka 560001',
          12.9716, 77.5946,
          '06:00 AM - 10:00 AM, 04:00 PM - 08:00 PM',
          'National',
          4000.00, 3400.00, '15% State Champion Concession',
          ARRAY['6 Clay Courts', 'DecoTurf Hard Court', 'Synthetic 400m Track', 'Sports Science Clinic'],
          '[{"name": "Naveen Kumar", "role": "Tennis Director", "license": "ITF Level 2"}]'::jsonb,
          'https://bengaluruunitedsports.in',
          '+91 80 2221 4455',
          TRUE
        );
      `);
    }

    // Initial Seed: Sports Shop Products
    const prodCountRes: any = await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int as count FROM sports_shop_products;`);
    const prodCount = Number(prodCountRes?.[0]?.count || 0);
    if (prodCount === 0) {
      await prisma.$executeRawUnsafe(`
        INSERT INTO sports_shop_products (
          title, sport, category, price, image_url, seller_type, vendor_name, in_stock
        ) VALUES
        (
          'SKILL-TRACK Official Pro Match Football (Size 5)',
          'Football',
          'Equipment',
          1499.00,
          'https://images.unsplash.com/photo-1614632537423-1e6c2e7e0aab?w=500&auto=format&fit=crop&q=80',
          'official',
          NULL,
          TRUE
        ),
        (
          'Apex Strike Elite Turf Studs (FG/AG)',
          'Football',
          'Footwear',
          3499.00,
          'https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=500&auto=format&fit=crop&q=80',
          'vendor',
          'Gujarat Sports Hub',
          TRUE
        ),
        (
          'English Willow Profile Grade-1 Cricket Bat',
          'Cricket',
          'Equipment',
          4999.00,
          'https://images.unsplash.com/photo-1531415074868-036b107e775a?w=500&auto=format&fit=crop&q=80',
          'official',
          NULL,
          TRUE
        ),
        (
          'AeroStream Hydrodynamic Competition Goggles',
          'Swimming',
          'Accessories',
          1299.00,
          'https://images.unsplash.com/photo-1519315901367-f34ff9154487?w=500&auto=format&fit=crop&q=80',
          'vendor',
          'Aquatic Pro Store',
          TRUE
        ),
        (
          'Spalding Precision Grip Indoor Basketball',
          'Basketball',
          'Equipment',
          2199.00,
          'https://images.unsplash.com/photo-1519861531473-9200262188bf?w=500&auto=format&fit=crop&q=80',
          'official',
          NULL,
          TRUE
        ),
        (
          'Wilson Pro Carbon Matrix Tennis Racket',
          'Tennis',
          'Equipment',
          5499.00,
          'https://images.unsplash.com/photo-1617083934555-563d7637841c?w=500&auto=format&fit=crop&q=80',
          'vendor',
          'Smash Tennis Depot',
          TRUE
        );
      `);
    }

    // Initial Seed: Sports Travel Vans
    const vanCountRes: any = await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int as count FROM sports_travel_vans;`);
    const vanCount = Number(vanCountRes?.[0]?.count || 0);
    if (vanCount === 0) {
      await prisma.$executeRawUnsafe(`
        INSERT INTO sports_travel_vans (
          registration_number, driver_name, driver_phone, license_last_four,
          is_driver_verified, route_title, stops, total_seats, available_seats, monthly_fare
        ) VALUES
        (
          'GJ-18-AZ-4921',
          'Ramesh Bhai Patel',
          '+91 98250 12345',
          '3942',
          TRUE,
          'Gandhinagar Sector 21 <-> Motera Stadium Sports Hub',
          ARRAY['Sector 21 Circle', 'Infocity Gate 1', 'Koba Circle', 'Motera Stadium Gate 3'],
          14,
          5,
          1800.00
        ),
        (
          'GJ-01-BK-8812',
          'Vikram Sinh Rathod',
          '+91 97120 44556',
          '7721',
          TRUE,
          'Ahmedabad SG Highway <-> Sardar Patel Aquatic Center',
          ARRAY['Prahlad Nagar Garden', 'ISCON Cross Roads', 'Vastrapur Lake', 'Navrangpura Sports Complex'],
          14,
          8,
          2200.00
        ),
        (
          'GJ-05-CX-6190',
          'Mohammad Farooq',
          '+91 94260 77889',
          '5512',
          TRUE,
          'Surat City Light <-> Indoor Athletics Stadium',
          ARRAY['City Light Road', 'Ghod Dod Road', 'Athwa Gate', 'Lal Bhai Contractor Stadium'],
          14,
          6,
          1500.00
        );
      `);
    }

    // 14. Step Book & History Architecture
    await prisma.$executeRawUnsafe(`ALTER TABLE "SkillStep" ADD COLUMN IF NOT EXISTS "difficultyTier" TEXT;`);
    await prisma.$executeRawUnsafe(`ALTER TABLE "SkillStep" ADD COLUMN IF NOT EXISTS "approachViewedAt" TIMESTAMP;`);

    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS content_documents (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        step_id TEXT UNIQUE,
        resource_id TEXT UNIQUE,
        source_type TEXT NOT NULL,
        source_url TEXT,
        source_title TEXT,
        markdown TEXT,
        quadrants JSONB,
        topic_map JSONB NOT NULL,
        approach_brief JSONB,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await prisma.$executeRawUnsafe(`ALTER TABLE content_translations ADD COLUMN IF NOT EXISTS content_document_id TEXT;`);
    await prisma.$executeRawUnsafe(`ALTER TABLE content_translations ADD COLUMN IF NOT EXISTS topic_map JSONB;`);
    await prisma.$executeRawUnsafe(`ALTER TABLE content_translations ADD COLUMN IF NOT EXISTS approach_brief JSONB;`);
    await prisma.$executeRawUnsafe(`ALTER TABLE content_translations ALTER COLUMN content_id DROP NOT NULL;`);

    // Defensive self-healing: purge orphaned content_translations referencing nonexistent documents
    await prisma.$executeRawUnsafe(`
      DELETE FROM content_translations
      WHERE content_document_id IS NOT NULL
        AND content_document_id::text NOT IN (SELECT id::text FROM content_documents);
    `);

    // Ensure foreign key constraint exists safely
    await prisma.$executeRawUnsafe(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'content_translations_content_document_id_fkey') THEN
          ALTER TABLE content_translations
          ADD CONSTRAINT content_translations_content_document_id_fkey
          FOREIGN KEY (content_document_id)
          REFERENCES content_documents(id)
          ON DELETE CASCADE ON UPDATE CASCADE;
        END IF;
      END $$;
    `);

    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS ui_translations (
        language_code TEXT PRIMARY KEY,
        strings JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS resource_histories (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        profile_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        step_index INT NOT NULL,
        resource_type TEXT NOT NULL,
        identifier TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(workspace_id, identifier)
      );
    `);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_resource_histories_profile ON resource_histories(profile_id);`);

    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS subgenre_caches (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        normalized_skill_name TEXT UNIQUE NOT NULL,
        subgenres JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    console.log('[Schema] All Master Blueprint, Step Book & Maidan Sports schemas verified successfully.');
  } catch (err) {
    console.warn('[Schema] Schema initialization warning (remote DB may differ):', err);
  }
}

export default ensureDatabaseSchema;

