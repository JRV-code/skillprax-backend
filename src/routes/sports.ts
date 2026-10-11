import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import prisma from '../lib/prisma';
import { callGroqWithFallback } from '../lib/ai/pipeline';
import { getEffectiveKeys } from '../lib/keyManager';

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
};

export default sportsRoutes;
