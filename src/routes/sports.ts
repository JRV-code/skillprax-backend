import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import prisma from '../lib/prisma';
import { callGroqWithFallback } from '../lib/ai/pipeline';
import { getEffectiveKeys } from '../lib/keyManager';
import { fetchRealClubs, fetchLocalShops } from '../services/realPlacesService';

export const sportsRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // 1. POST /api/sports/profile — Save or update Physical Assessment Sheet
  fastify.post('/api/sports/profile', async (req, reply) => {
    try {
      const {
        userId,
        sportName = 'Football',
        subGenre = 'Dribbling & Ball Mastery',
        dietaryPreference = 'Vegetarian',
        medicalConditions = 'None',
        trainingGoal = 'Agility & Reflexes',
        dailyPracticeMinutes = 45,
      } = (req.body || {}) as {
        userId?: string;
        sportName: string;
        subGenre: string;
        dietaryPreference: string;
        medicalConditions: string;
        trainingGoal: string;
        dailyPracticeMinutes: number;
      };

      if (!userId) {
        return reply.status(400).send({ error: 'userId is required' });
      }

      // Check if profile exists
      let profile = await prisma.userSportsProfile.findFirst({
        where: { userId, sportName },
      });

      if (profile) {
        profile = await prisma.userSportsProfile.update({
          where: { id: profile.id },
          data: {
            subGenre,
            dietaryPreference,
            medicalConditions,
            trainingGoal,
            dailyPracticeMinutes: Number(dailyPracticeMinutes) || 45,
          },
        });
      } else {
        profile = await prisma.userSportsProfile.create({
          data: {
            userId,
            sportName,
            subGenre,
            dietaryPreference,
            medicalConditions,
            trainingGoal,
            dailyPracticeMinutes: Number(dailyPracticeMinutes) || 45,
          },
        });
      }

      return reply.status(200).send({ success: true, profile });
    } catch (err: any) {
      fastify.log.error(err, '[POST /api/sports/profile] Failed');
      return reply.status(500).send({ error: 'Failed to save sports profile' });
    }
  });

  // 2. POST /api/sports/generate-regimen — AI 7-Day Workout & Diet Engine
  fastify.post('/api/sports/generate-regimen', async (req, reply) => {
    try {
      const {
        userId,
        userSportsId,
        sportName = 'Football',
        subGenre = 'Ball Mastery',
        dietaryPreference = 'Vegetarian',
        medicalConditions = 'None',
        trainingGoal = 'Agility & Reflexes',
        dailyPracticeMinutes = 45,
      } = (req.body || {}) as {
        userId?: string;
        userSportsId?: string;
        sportName: string;
        subGenre: string;
        dietaryPreference: string;
        medicalConditions: string;
        trainingGoal: string;
        dailyPracticeMinutes: number;
      };

      let activeSportsId = userSportsId;

      if (!activeSportsId && userId) {
        const found = await prisma.userSportsProfile.findFirst({
          where: { userId, sportName },
        });
        if (found) {
          activeSportsId = found.id;
        } else {
          const created = await prisma.userSportsProfile.create({
            data: {
              userId,
              sportName,
              subGenre,
              dietaryPreference,
              medicalConditions,
              trainingGoal,
              dailyPracticeMinutes: Number(dailyPracticeMinutes) || 45,
            },
          });
          activeSportsId = created.id;
        }
      }

      if (!activeSportsId) {
        return reply.status(400).send({ error: 'userId or userSportsId is required' });
      }

      const { groqKey } = await getEffectiveKeys();
      const apiKey = groqKey || process.env.GROQ_API_KEY || '';

      // Detailed system prompt enforcing medical gating and dietary restrictions
      const systemPrompt = `You are a world-class Sports Science Physiologist and Athletic Dietitian.
Generate a structured 7-day personalized athletic regimen for:
- Sport: ${sportName}
- Sub-Genre: ${subGenre}
- Training Goal: ${trainingGoal}
- Daily Practice Target: ${dailyPracticeMinutes} minutes
- Dietary Preference: ${dietaryPreference} (STRICT ENFORCEMENT: e.g. if Jain, NO root vegetables like onion, garlic, potato; if Vegetarian, no meat/fish; if Vegan, no dairy/eggs/honey; if Eggetarian, eggs and dairy allowed).
- Medical / Physical Conditions: ${medicalConditions} (STRICT ADAPTATION: e.g. if Knee/ACL Sensitivity, eliminate jump squats/plyometrics and substitute isometric wall-sits or banded lateral walks; if Asthma, adjust rest intervals and pacing cues; if Back strain, eliminate heavy spinal loads).

Output ONLY a JSON array of 7 objects (Day 1 through Day 7) matching this schema:
[
  {
    "dayNumber": 1,
    "title": "Day 1 Focus Title",
    "drills": [
      {
        "id": "drill-1-1",
        "title": "Drill Name",
        "durationMinutes": 15,
        "cues": "2-3 precise biomechanical form cues accounting for ${medicalConditions}",
        "intensity": "Moderate" // "Low" | "Moderate" | "High" | "Recovery"
      }
    ],
    "nutritionPlan": {
      "breakfast": "Detailed morning ignition meal fitting ${dietaryPreference} with macros",
      "preWorkout": "Fast-digesting carbs and electrolytes 30-45 mins before practice",
      "postWorkout": "Targeted recovery protein and restorative nutrients",
      "dinner": "Anti-inflammatory evening meal strictly compliant with ${dietaryPreference}",
      "hydrationLiters": 3.2
    }
  }
]`;

      const aiResponse = await callGroqWithFallback([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Synthesize 7-day athletic drill and fueling plan for ${sportName} (${subGenre}).` },
      ], { apiKey, model: 'llama-3.3-70b-versatile', temperature: 0.3 });

      let daysPlan: any[] = [];
      try {
        const cleaned = (aiResponse.content || '')
          .replace(/```json/g, '')
          .replace(/```/g, '')
          .trim();
        daysPlan = JSON.parse(cleaned);
      } catch (parseErr) {
        fastify.log.warn(parseErr, '[sports] LLM parse error, constructing fallback');
        daysPlan = Array.from({ length: 7 }, (_, i) => ({
          dayNumber: i + 1,
          title: `Day ${i + 1}: ${subGenre} Foundations`,
          drills: [
            {
              id: `drill-${i + 1}-1`,
              title: `${subGenre} Technical Shuttle`,
              durationMinutes: Math.round(dailyPracticeMinutes * 0.4),
              cues: `Maintain balance, engage core, respect condition: ${medicalConditions}`,
              intensity: 'Moderate',
            },
            {
              id: `drill-${i + 1}-2`,
              title: `${trainingGoal} Progressive Circuit`,
              durationMinutes: Math.round(dailyPracticeMinutes * 0.6),
              cues: 'Focus on rhythm and active recovery breaths',
              intensity: 'Moderate',
            },
          ],
          nutritionPlan: {
            breakfast: `${dietaryPreference} High-protein oatmeal with chia seeds and crushed nuts`,
            preWorkout: 'Banana with coconut water or electrolyte infusion',
            postWorkout: 'Recovery protein shake or sprouted bean bowl',
            dinner: 'Steamed greens, quinoa/rice, and anti-inflammatory turmeric soup',
            hydrationLiters: 3.2,
          },
        }));
      }

      // Persist in Neon PostgreSQL sports_daily_plans
      await prisma.sportsDailyPlan.deleteMany({
        where: { userSportsId: activeSportsId },
      });

      for (const d of daysPlan) {
        await prisma.sportsDailyPlan.create({
          data: {
            userSportsId: activeSportsId,
            dayNumber: d.dayNumber || 1,
            drills: d.drills || [],
            nutritionPlan: d.nutritionPlan || {},
            isCompleted: false,
          },
        });
      }

      const savedPlans = await prisma.sportsDailyPlan.findMany({
        where: { userSportsId: activeSportsId },
        orderBy: { dayNumber: 'asc' },
      });

      return reply.status(200).send({
        success: true,
        userSportsId: activeSportsId,
        days: savedPlans,
      });
    } catch (err: any) {
      fastify.log.error(err, '[POST /api/sports/generate-regimen] Failed');
      return reply.status(500).send({ error: 'Failed to generate sports regimen' });
    }
  });

  // 3. GET /api/sports/profile/:userId — Retrieve user sports profile and current 7-day plan
  fastify.get('/api/sports/profile/:userId', async (req, reply) => {
    const { userId } = req.params as { userId: string };
    try {
      const profile = await prisma.userSportsProfile.findFirst({
        where: { userId },
        include: {
          dailyPlans: { orderBy: { dayNumber: 'asc' } },
        },
      });

      if (!profile) {
        return reply.status(200).send({ profile: null, dailyPlans: [] });
      }

      return reply.status(200).send({
        profile,
        dailyPlans: profile.dailyPlans || [],
      });
    } catch (err: any) {
      fastify.log.error(err, '[GET /api/sports/profile/:userId] Failed');
      return reply.status(500).send({ error: 'Failed to retrieve sports profile' });
    }
  });

  // 4. PATCH /api/sports/daily-plan/:id/toggle — Toggle completion status of daily drill
  fastify.patch('/api/sports/daily-plan/:id/toggle', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const plan = await prisma.sportsDailyPlan.findUnique({
        where: { id },
      });

      if (!plan) {
        return reply.status(404).send({ error: 'Daily plan not found' });
      }

      const updated = await prisma.sportsDailyPlan.update({
        where: { id },
        data: { isCompleted: !plan.isCompleted },
      });

      return reply.status(200).send({ success: true, plan: updated });
    } catch (err: any) {
      fastify.log.error(err, '[PATCH /api/sports/daily-plan/:id/toggle] Failed');
      return reply.status(500).send({ error: 'Failed to toggle daily plan' });
    }
  });
  // =========================================================================
  // MODULE 1: ATHLETE SPORTS PROFILE & 3-STEP PRIVACY ENGINE ("ACCEPT-TO-UNLOCK")
  // =========================================================================

  // GET /api/sports/athlete/profile
  fastify.get('/api/sports/athlete/profile', async (req, reply) => {
    try {
      const { userId = 'default-profile', sport = 'Football', viewerClubId } = req.query as {
        userId?: string;
        sport?: string;
        viewerClubId?: string;
      };

      const profileRes: any = await prisma.$queryRawUnsafe(`
        SELECT p.*, u.name as user_name, u.email as user_email
        FROM sports_player_profiles p
        LEFT JOIN users u ON u.id::text = p.user_id
        WHERE p.user_id = $1 AND LOWER(p.sport) = LOWER($2)
        LIMIT 1;
      `, userId, sport);

      let profile = profileRes?.[0];

      if (!profile) {
        // Return default skeleton
        return reply.send({
          success: true,
          profile: {
            userId,
            sport,
            secondarySports: [],
            playingPosition: 'Forward',
            heightCm: 175,
            weightKg: 68,
            achievements: 'District Championship 2025 Runner-up',
            certificates: [
              { title: 'District Sports Federation License', fileUrl: 'https://example.com/cert1.pdf', issuedYear: 2025 }
            ],
            dateOfBirth: '2008-05-14',
            isMinor: true,
            guardianName: 'Sanjay Patel',
            guardianPhone: '+91 98251 98765',
            guardianEmail: 'sanjay.patel@example.com',
            isLocked: false,
          },
        });
      }

      // Check Privacy Gate if accessed by a Club
      let isUnlocked = true;
      if (viewerClubId) {
        const accessCheck: any = await prisma.$queryRawUnsafe(`
          SELECT status, guardian_approved
          FROM sports_scouting_requests
          WHERE club_id::text = $1 AND player_id = $2
          LIMIT 1;
        `, viewerClubId, userId);

        const request = accessCheck?.[0];
        if (!request || request.status !== 'accepted' || (profile.is_minor && !request.guardian_approved)) {
          isUnlocked = false;
        }
      }

      if (!isUnlocked) {
        // Enforce blurred / locked state for private metrics
        return reply.send({
          success: true,
          profile: {
            id: profile.id,
            userId: profile.user_id,
            userName: profile.user_name || 'Verified Athlete',
            sport: profile.sport,
            secondarySports: profile.secondary_sports || [],
            playingPosition: profile.playing_position,
            city: 'Gandhinagar',
            publicBadge: 'Verified Prospect',
            isMinor: profile.is_minor,
            isLocked: true,
            // Locked / Blurred Metrics
            heightCm: null,
            weightKg: null,
            achievements: 'LOCKED: Requires Accepted Scouting Request',
            certificates: [],
            contactDetails: 'LOCKED',
            guardianName: null,
            guardianPhone: null,
          },
        });
      }

      return reply.send({
        success: true,
        profile: {
          id: profile.id,
          userId: profile.user_id,
          userName: profile.user_name || 'Verified Athlete',
          userEmail: profile.user_email,
          sport: profile.sport,
          secondarySports: profile.secondary_sports || [],
          playingPosition: profile.playing_position,
          heightCm: profile.height_cm ? Number(profile.height_cm) : 175,
          weightKg: profile.weight_kg ? Number(profile.weight_kg) : 68,
          achievements: profile.achievements || '',
          certificates: profile.certificates || [],
          dateOfBirth: profile.date_of_birth,
          isMinor: profile.is_minor,
          guardianName: profile.guardian_name,
          guardianPhone: profile.guardian_phone,
          guardianEmail: profile.guardian_email,
          isLocked: false,
        },
      });
    } catch (err: any) {
      fastify.log.error(err, '[GET /api/sports/athlete/profile] Failed');
      return reply.status(500).send({ error: 'Failed to fetch athlete profile' });
    }
  });

  // POST /api/sports/athlete/profile — Update athlete sports profile
  fastify.post('/api/sports/athlete/profile', async (req, reply) => {
    try {
      const body = (req.body || {}) as any;
      const {
        userId = 'default-profile',
        sport = 'Football',
        secondarySports = [],
        playingPosition = 'Forward',
        heightCm,
        weightKg,
        achievements = '',
        certificates = [],
        dateOfBirth = '2008-01-01',
        guardianName = '',
        guardianPhone = '',
        guardianEmail = '',
      } = body;

      // Determine minor status (< 18 years)
      const birthDate = new Date(dateOfBirth);
      const ageDiff = (Date.now() - birthDate.getTime()) / (1000 * 60 * 60 * 24 * 365.25);
      const isMinor = ageDiff < 18;

      await prisma.$executeRawUnsafe(`
        INSERT INTO sports_player_profiles (
          user_id, sport, secondary_sports, playing_position,
          height_cm, weight_kg, achievements, certificates,
          date_of_birth, is_minor, guardian_name, guardian_phone, guardian_email, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::date, $10, $11, $12, $13, NOW()
        )
        ON CONFLICT (user_id, sport) DO UPDATE SET
          secondary_sports = EXCLUDED.secondary_sports,
          playing_position = EXCLUDED.playing_position,
          height_cm = EXCLUDED.height_cm,
          weight_kg = EXCLUDED.weight_kg,
          achievements = EXCLUDED.achievements,
          certificates = EXCLUDED.certificates,
          date_of_birth = EXCLUDED.date_of_birth,
          is_minor = EXCLUDED.is_minor,
          guardian_name = EXCLUDED.guardian_name,
          guardian_phone = EXCLUDED.guardian_phone,
          guardian_email = EXCLUDED.guardian_email,
          updated_at = NOW();
      `,
        userId,
        sport,
        secondarySports,
        playingPosition,
        heightCm ? Number(heightCm) : null,
        weightKg ? Number(weightKg) : null,
        achievements,
        JSON.stringify(certificates),
        dateOfBirth,
        isMinor,
        guardianName,
        guardianPhone,
        guardianEmail
      );

      return reply.send({ success: true, message: 'Athlete profile updated successfully' });
    } catch (err: any) {
      fastify.log.error(err, '[POST /api/sports/athlete/profile] Failed');
      return reply.status(500).send({ error: 'Failed to update athlete profile' });
    }
  });

  // GET /api/sports/athlete/audit — Privacy Access Audit Table
  fastify.get('/api/sports/athlete/audit', async (req, reply) => {
    try {
      const { userId = 'default-profile' } = req.query as { userId?: string };

      const rows: any = await prisma.$queryRawUnsafe(`
        SELECT 
          r.id as request_id,
          r.club_id,
          c.club_name,
          c.city as club_city,
          r.status,
          r.guardian_approved,
          r.created_at,
          r.updated_at
        FROM sports_scouting_requests r
        JOIN sports_clubs c ON c.id = r.club_id
        WHERE r.player_id = $1
        ORDER BY r.updated_at DESC;
      `, userId);

      const auditList = (rows || []).map((row: any) => ({
        requestId: row.request_id,
        clubId: row.club_id,
        clubName: row.club_name,
        clubCity: row.club_city,
        accessLevel: row.status === 'accepted' ? 'Full Private Access' : 'Public Directory Only',
        status: row.status,
        guardianApproved: row.guardian_approved,
        approvedDate: row.updated_at ? new Date(row.updated_at).toLocaleDateString() : 'Pending',
      }));

      return reply.send({ success: true, auditList });
    } catch (err: any) {
      fastify.log.error(err, '[GET /api/sports/athlete/audit] Failed');
      return reply.status(500).send({ error: 'Failed to fetch access audit' });
    }
  });

  // POST /api/sports/athlete/revoke-access — Instant Access Revoke Button
  fastify.post('/api/sports/athlete/revoke-access', async (req, reply) => {
    try {
      const { requestId } = (req.body || {}) as { requestId: string };
      if (!requestId) return reply.status(400).send({ error: 'requestId required' });

      await prisma.$executeRawUnsafe(`
        UPDATE sports_scouting_requests
        SET status = 'declined', updated_at = NOW()
        WHERE id::text = $1;
      `, requestId);

      return reply.send({ success: true, message: 'Club access revoked immediately' });
    } catch (err: any) {
      fastify.log.error(err, '[POST /api/sports/athlete/revoke-access] Failed');
      return reply.status(500).send({ error: 'Failed to revoke club access' });
    }
  });

  // GET /api/sports/athlete/history — History & Rating Tracker (Rating-over-Time Chart)
  fastify.get('/api/sports/athlete/history', async (req, reply) => {
    try {
      const { userId = 'default-profile' } = req.query as { userId?: string };

      // Ratings from clubs
      const ratingsRes: any = await prisma.$queryRawUnsafe(`
        SELECT r.*, c.club_name
        FROM sports_player_ratings r
        JOIN sports_clubs c ON c.id = r.club_id
        WHERE r.player_id = $1
        ORDER BY r.created_at ASC;
      `, userId);

      let ratings = (ratingsRes || []).map((r: any) => ({
        id: r.id,
        clubName: r.club_name,
        overallRating: Number(r.overall_rating),
        technicalScore: r.technical_score,
        agilityScore: r.agility_score,
        notes: r.notes,
        date: new Date(r.created_at).toLocaleDateString(),
      }));

      // Default sample trajectory if none exist yet
      if (ratings.length === 0) {
        ratings = [
          { id: '1', clubName: 'District Selection Trials', overallRating: 3.2, technicalScore: 65, agilityScore: 70, notes: 'Good first touch, needs endurance tuning.', date: 'Jan 2026' },
          { id: '2', clubName: 'State Championship Scouting', overallRating: 3.8, technicalScore: 78, agilityScore: 82, notes: 'Sharp tactical positioning and pace.', date: 'Feb 2026' },
          { id: '3', clubName: 'Gandhinagar FA Invitational', overallRating: 4.4, technicalScore: 88, agilityScore: 90, notes: 'Dominant ball control and playmaking vision.', date: 'Mar 2026' },
        ];
      }

      // Attendance records
      const attendance = [
        { session: 'Match Speed Drills', date: 'Yesterday', status: 'Present', duration: '90 mins' },
        { session: 'Tactical Shadowing', date: '3 days ago', status: 'Present', duration: '75 mins' },
        { session: 'Recovery & Mobility', date: '5 days ago', status: 'Present', duration: '45 mins' },
      ];

      return reply.send({ success: true, ratings, attendance });
    } catch (err: any) {
      fastify.log.error(err, '[GET /api/sports/athlete/history] Failed');
      return reply.status(500).send({ error: 'Failed to fetch player history' });
    }
  });

  // =========================================================================
  // MODULE 4: REAL CLUBS & LOCAL SPORTS SHOPS (GOOGLE MAPS & TAVILY PIPELINE)
  // =========================================================================

  // 1. GET /api/sports/real-clubs — Discover authentic clubs & academies via Tavily + Groq
  fastify.get('/api/sports/real-clubs', async (req, reply) => {
    try {
      const {
        sport = 'Football',
        city = 'Ahmedabad',
        state = 'Gujarat',
        ageCategory = 'ALL',
      } = req.query as {
        sport?: string;
        city?: string;
        state?: string;
        ageCategory?: string;
      };

      const clubs = await fetchRealClubs(sport, city, state, ageCategory);
      return reply.status(200).send({
        success: true,
        city,
        state,
        sport,
        ageCategory,
        clubs,
      });
    } catch (err: any) {
      fastify.log.error(err, '[GET /api/sports/real-clubs] Failed');
      return reply.status(500).send({ error: 'Failed to retrieve real sports clubs.' });
    }
  });

  // 2. GET /api/sports/local-shops — Discover brick-and-mortar sports equipment stores
  fastify.get('/api/sports/local-shops', async (req, reply) => {
    try {
      const {
        city = 'Ahmedabad',
        state = 'Gujarat',
        sport = '',
      } = req.query as {
        city?: string;
        state?: string;
        sport?: string;
      };

      const shops = await fetchLocalShops(city, state, sport);
      return reply.status(200).send({
        success: true,
        city,
        state,
        shops,
      });
    } catch (err: any) {
      fastify.log.error(err, '[GET /api/sports/local-shops] Failed');
      return reply.status(500).send({ error: 'Failed to retrieve local sports shops.' });
    }
  });

  // =========================================================================
  // MODULE 2: "CLUBS NEAR ME" REAL-TIME DISCOVERY ENGINE (`/sports/explore`)
  // =========================================================================

  function calculateDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371;
    const dLat = (lat2 - lat1) * (Math.PI / 180);
    const dLon = (lon2 - lon1) * (Math.PI / 180);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return Math.round((R * c) * 10) / 10;
  }

  // GET /api/sports/clubs/explore
  fastify.get('/api/sports/clubs/explore', async (req, reply) => {
    try {
      const {
        sport = '',
        competitionLevel = '',
        minFee,
        maxFee,
        radiusKm = 50,
        userLat = 23.2156, // Default Gandhinagar/Ahmedabad
        userLng = 72.6369,
        verifiedOnly = 'false',
        discountOnly = 'false',
      } = req.query as any;

      const clubs: any[] = await prisma.$queryRawUnsafe(`
        SELECT * FROM sports_clubs
        ORDER BY created_at DESC;
      `);

      const originLat = Number(userLat) || 23.2156;
      const originLng = Number(userLng) || 72.6369;
      const maxRadius = Number(radiusKm) || 50;

      // 1. Strict Sport-First & Combinable Filters
      const filtered = clubs
        .map((c) => {
          const dist = calculateDistanceKm(originLat, originLng, Number(c.latitude), Number(c.longitude));
          return {
            ...c,
            distanceKm: dist,
            monthlyFee: Number(c.monthly_fee),
            discountedFee: c.discounted_fee ? Number(c.discounted_fee) : null,
            discountLabel: c.discount_label,
            sportsOffered: c.sports_offered || [],
            facilities: c.facilities || [],
            coachingStaff: c.coaching_staff || [],
            isVerified: Boolean(c.is_verified),
          };
        })
        .filter((c) => {
          // Strict sport check: if sport filter is set, must offer that sport strictly
          if (sport && sport.trim() !== '' && sport.toLowerCase() !== 'all') {
            const hasSport = c.sportsOffered.some((s: string) => s.toLowerCase() === sport.toLowerCase());
            if (!hasSport) return false;
          }

          if (competitionLevel && competitionLevel !== 'All' && c.competition_level !== competitionLevel) {
            return false;
          }

          if (minFee && c.monthlyFee < Number(minFee)) return false;
          if (maxFee && c.monthlyFee > Number(maxFee)) return false;

          if (verifiedOnly === 'true' && !c.isVerified) return false;
          if (discountOnly === 'true' && !c.discountedFee) return false;

          if (c.distanceKm > maxRadius) return false;

          return true;
        })
        .sort((a, b) => a.distanceKm - b.distanceKm);

      // 2. Best Alternatives Fallback Engine
      let bestAlternatives: any[] = [];
      if (filtered.length === 0) {
        bestAlternatives = clubs
          .map((c) => {
            const dist = calculateDistanceKm(originLat, originLng, Number(c.latitude), Number(c.longitude));
            return {
              ...c,
              distanceKm: dist,
              monthlyFee: Number(c.monthly_fee),
              discountedFee: c.discounted_fee ? Number(c.discounted_fee) : null,
              discountLabel: c.discount_label,
              sportsOffered: c.sports_offered || [],
              facilities: c.facilities || [],
              coachingStaff: c.coaching_staff || [],
              isVerified: Boolean(c.is_verified),
            };
          })
          .filter((c) => {
            if (sport && sport.trim() !== '' && sport.toLowerCase() !== 'all') {
              return c.sportsOffered.some((s: string) => s.toLowerCase() === sport.toLowerCase());
            }
            return true;
          })
          .sort((a, b) => a.distanceKm - b.distanceKm)
          .slice(0, 4);
      }

      return reply.send({
        success: true,
        count: filtered.length,
        clubs: filtered,
        bestAlternatives,
      });
    } catch (err: any) {
      fastify.log.error(err, '[GET /api/sports/clubs/explore] Failed');
      return reply.status(500).send({ error: 'Failed to explore sports clubs' });
    }
  });

  // GET /api/sports/clubs/:id — Club Profile Modal
  fastify.get('/api/sports/clubs/:id', async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const res: any = await prisma.$queryRawUnsafe(`
        SELECT * FROM sports_clubs WHERE id::text = $1 LIMIT 1;
      `, id);

      const club = res?.[0];
      if (!club) return reply.status(404).send({ error: 'Club not found' });

      return reply.send({
        success: true,
        club: {
          ...club,
          monthlyFee: Number(club.monthly_fee),
          discountedFee: club.discounted_fee ? Number(club.discounted_fee) : null,
          sportsOffered: club.sports_offered || [],
          facilities: club.facilities || [],
          coachingStaff: club.coaching_staff || [],
          isVerified: Boolean(club.is_verified),
        },
      });
    } catch (err: any) {
      fastify.log.error(err, '[GET /api/sports/clubs/:id] Failed');
      return reply.status(500).send({ error: 'Failed to fetch club' });
    }
  });



  // =========================================================================
  // MODULE 4: SPORTS GEAR MARKETPLACE ("SPORTS SHOP") (`/sports/shop`)
  // =========================================================================

  // GET /api/sports/shop/products
  fastify.get('/api/sports/shop/products', async (req, reply) => {
    try {
      const { sport, category } = req.query as { sport?: string; category?: string };

      let query = `SELECT * FROM sports_shop_products WHERE in_stock = TRUE`;
      const params: any[] = [];

      if (sport && sport !== 'All') {
        params.push(sport);
        query += ` AND LOWER(sport) = LOWER($${params.length})`;
      }

      if (category && category !== 'All') {
        params.push(category);
        query += ` AND LOWER(category) = LOWER($${params.length})`;
      }

      query += ` ORDER BY created_at DESC;`;

      const products: any[] = await prisma.$queryRawUnsafe(query, ...params);

      const formatted = (products || []).map((p: any) => ({
        id: p.id,
        title: p.title,
        sport: p.sport,
        category: p.category,
        price: Number(p.price),
        imageUrl: p.image_url,
        sellerType: p.seller_type, // 'official' vs 'vendor'
        vendorName: p.seller_type === 'official' ? 'SKILL-TRACK Direct' : (p.vendor_name || 'Verified Vendor'),
        inStock: p.in_stock,
      }));

      return reply.send({ success: true, products: formatted });
    } catch (err: any) {
      fastify.log.error(err, '[GET /api/sports/shop/products] Failed');
      return reply.status(500).send({ error: 'Failed to fetch sports products' });
    }
  });


  // POST /api/sports/drills/generate — Dynamic Sport Drill Generation via Groq
  fastify.post('/api/sports/drills/generate', async (req, reply) => {
    try {
      const {
        sportName = 'Football',
        subGenre = 'Dribbling & Ball Mastery',
        stepNumber = 1,
        stepTitle = 'Foundations & Balance',
        preferredLanguage = 'en',
      } = (req.body || {}) as {
        sportName?: string;
        subGenre?: string;
        stepNumber?: number;
        stepTitle?: string;
        preferredLanguage?: string;
      };

      const { groqKey } = await getEffectiveKeys();
      const apiKey = groqKey || process.env.GROQ_API_KEY || '';

      const langMap: Record<string, string> = {
        en: 'English',
        hi: 'Hindi',
        gu: 'Gujarati',
        mr: 'Marathi',
        kn: 'Kannada',
        ta: 'Tamil',
        te: 'Telugu',
        fr: 'French',
        es: 'Spanish',
        de: 'German',
      };
      const langName = langMap[preferredLanguage] || 'English';

      if (apiKey) {
        try {
          const systemPrompt = `You are an Olympic-tier Sports Performance Director and Biomechanical Coach.
Generate exactly 3 progressive physical drills strictly calibrated for:
- Sport: "${sportName}"
- Specialty / Sub-Genre: "${subGenre}"
- Step Level: Step ${stepNumber} — "${stepTitle}"
- Target Language: ${langName}

STRICT DRILL MANDATE:
1. Every drill must be a pure physical execution exercise with biomechanical focus.
2. DO NOT include any multiple-choice questions, quizzes, or text exams.
3. Include explicit duration (between 10 and 20 minutes) and intensity level ("Low", "Medium", or "High").
4. Output strictly a JSON array of 3 drill objects:
[
  {
    "id": "drill-1",
    "title": "Drill Title (e.g. In-Step Low Drive Technique)",
    "objective": "Clear mechanical objective",
    "biomechanicalFocus": "Exact posture, joint angle, and kinetic sequence cues",
    "instructions": [
      "Step 1 cue",
      "Step 2 cue",
      "Step 3 cue",
      "Step 4 cue"
    ],
    "recommendedSets": "e.g. 4 Sets x 10 Reps (12 Mins)",
    "durationMinutes": 12,
    "intensityLevel": "High"
  }
]`;

          const aiRes = await callGroqWithFallback(
            [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: `Generate the 3 calibrated drills in ${langName} now.` },
            ],
            { apiKey, model: 'llama-3.3-70b-versatile', temperature: 0.25, jsonMode: true }
          );

          let parsed = JSON.parse(aiRes.content);
          if (parsed && !Array.isArray(parsed) && Array.isArray(parsed.drills)) {
            parsed = parsed.drills;
          }

          if (Array.isArray(parsed) && parsed.length > 0) {
            const formatted = parsed.slice(0, 3).map((d: any, idx: number) => {
              const dur = Math.max(5, Math.min(30, Number(d.durationMinutes) || 12));
              return {
                id: d.id || `drill-${sportName.toLowerCase().replace(/\s+/g, '-')}-${stepNumber}-${idx + 1}`,
                title: d.title || `${sportName} Step ${stepNumber} Drill ${idx + 1}`,
                objective: d.objective || `Refine core kinetic alignment for ${stepTitle}`,
                biomechanicalFocus: d.biomechanicalFocus || `Maintain neutral spine and explosive ground reaction force`,
                instructions: Array.isArray(d.instructions) && d.instructions.length > 0
                  ? d.instructions
                  : [
                      'Establish balanced foundational stance with center of gravity lowered.',
                      'Initiate dynamic kinetic drive through targeted muscle groups.',
                      'Hold decisive deceleration form at full extension.',
                      'Reset to neutral athletic base within 3 seconds.',
                    ],
                recommendedSets: d.recommendedSets || `4 Sets x 12 Reps (${dur} Mins)`,
                durationMinutes: dur,
                durationSeconds: dur * 60,
                intensityLevel: ['Low', 'Medium', 'High'].includes(d.intensityLevel) ? d.intensityLevel : 'Medium',
                focusPoints: Array.isArray(d.instructions) ? d.instructions.slice(0, 3) : ['Kinetic sequencing', 'Dynamic balance', 'Consistent tempo'],
                completed: false,
              };
            });

            return reply.send({ success: true, drills: formatted });
          }
        } catch (aiErr) {
          fastify.log.warn({ err: aiErr }, '[POST /api/sports/drills/generate] AI generation fallback');
        }
      }

      // High-quality dynamic fallback calibrated specifically to the requested sport and step level
      const stepDurations = [12, 15, 18];
      const intensityLevels: Array<'Low' | 'Medium' | 'High'> = ['Low', 'Medium', 'High'];
      const defaultDrills = [
        {
          id: `drill-${sportName.toLowerCase().replace(/\s+/g, '-')}-${stepNumber}-1`,
          title: `${sportName} ${stepTitle} — Foundational Form & Alignment`,
          objective: `Establish repeatable athletic posture and neuromuscular readiness for ${subGenre}.`,
          biomechanicalFocus: `Even weight distribution, core engagement, and zero joint locking during movement initiation.`,
          instructions: [
            `Assume foundational athletic stance with feet shoulder-width apart.`,
            `Perform 10 controlled repetitions at 60% velocity, feeling ground force connection.`,
            `Verify mirror alignment or partner checkpoint at peak extension.`,
            `Recover for 30 seconds between sets with steady nasal breathing.`,
          ],
          recommendedSets: `3 Sets x 10 Reps (10 Mins)`,
          durationMinutes: 10,
          durationSeconds: 600,
          intensityLevel: 'Low',
          focusPoints: ['Neutral posture alignment', 'Ground reaction force', 'Active breathing pacing'],
          completed: false,
        },
        {
          id: `drill-${sportName.toLowerCase().replace(/\s+/g, '-')}-${stepNumber}-2`,
          title: `${sportName} ${stepTitle} — Dynamic Kinetic Sequencing`,
          objective: `Accelerate movement execution to match match-pace tempo in ${sportName}.`,
          biomechanicalFocus: `Rapid kinetic energy transfer from lower chain through upper levers without energy dissipation.`,
          instructions: [
            `Set up active 5-meter practice zone with directional cues.`,
            `Execute explosive acceleration burst into the core technical movement.`,
            `Decelerate sharply within 2 paces to train joint stabilization.`,
            `Repeat across 4 sets with 45-second active recovery walks.`,
          ],
          recommendedSets: `4 Sets x 8 Reps (15 Mins)`,
          durationMinutes: 15,
          durationSeconds: 900,
          intensityLevel: 'High',
          focusPoints: ['Explosive initiation', 'Deceleration brake', 'Energy transfer fluidity'],
          completed: false,
        },
        {
          id: `drill-${sportName.toLowerCase().replace(/\s+/g, '-')}-${stepNumber}-3`,
          title: `${sportName} ${stepTitle} — Pressure Integration & Endurance`,
          objective: `Sustain precise biomechanical mechanics under simulated game fatigue.`,
          biomechanicalFocus: `Preserve posture consistency and technical crispness despite elevated heart rate.`,
          instructions: [
            `Perform continuous cyclical reps for 90-second work intervals.`,
            `Maintain focus on technical checkpoints rather than rushed reps.`,
            `Record any early fatigue signs (e.g. rounded shoulders or delayed recovery).`,
            `Finish with a 3-minute restorative cooldown mobility sequence.`,
          ],
          recommendedSets: `3 Sets x 90s Intervals (12 Mins)`,
          durationMinutes: 12,
          durationSeconds: 720,
          intensityLevel: 'Medium',
          focusPoints: ['Fatigue resistance', 'Technical fidelity under pressure', 'Postural stability'],
          completed: false,
        },
      ];

      return reply.send({ success: true, drills: defaultDrills });
    } catch (err: any) {
      fastify.log.error(err, '[POST /api/sports/drills/generate] Fatal error');
      return reply.status(500).send({ error: 'Failed to generate sport drills' });
    }
  });

  // POST /api/sports/drills/complete-day — Complete daily drill session & sync practice calendar
  fastify.post('/api/sports/drills/complete-day', async (req, reply) => {
    try {
      const { skillId, stepNumber, drillTitle, userId } = (req.body || {}) as {
        skillId?: string;
        stepNumber?: number;
        drillTitle?: string;
        userId?: string;
      };

      if (!skillId) {
        return reply.status(400).send({ error: 'skillId is required' });
      }

      const num = Number(stepNumber) || 1;

      // Increment practice_days_completed in skill_steps table
      let step: any = null;
      try {
        const rows: any[] = await prisma.$queryRawUnsafe(`
          UPDATE skill_steps 
          SET practice_days_completed = practice_days_completed + 1
          WHERE skill_id = $1 AND step_number = $2
          RETURNING *;
        `, skillId, num);
        if (rows && rows.length > 0) {
          step = rows[0];
        }
      } catch (err) {
        fastify.log.warn({ err }, '[POST /api/sports/drills/complete-day] raw sql increment notice');
      }

      const completed = step ? Number(step.practice_days_completed) : 1;
      const required = step ? Number(step.required_practice_days) : 3;
      const isCalendarComplete = completed >= required;

      // Log activity minutes to user daily activity if userId present
      if (userId) {
        try {
          const today = new Date().toISOString().split('T')[0];
          await prisma.dailyActivityLog.upsert({
            where: { userProfileId_date: { userProfileId: userId, date: today } },
            create: {
              userProfileId: userId,
              date: today,
              minutesSpent: 15,
            },
            update: {
              minutesSpent: { increment: 15 },
            },
          });
        } catch (_) {}
      }

      return reply.send({
        success: true,
        stepNumber: num,
        practiceDaysCompleted: completed,
        requiredPracticeDays: required,
        isCalendarComplete,
        message: 'Drill session logged with green timestamped checkmark. Calendar updated successfully.',
      });
    } catch (err: any) {
      fastify.log.error(err, '[POST /api/sports/drills/complete-day] Failed');
      return reply.status(500).send({ error: 'Failed to record drill completion' });
    }
  });
};

export default sportsRoutes;
