import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import jwt from 'jsonwebtoken';
import prisma from '../lib/prisma';
import { db } from '../lib/db';
import { getEffectiveKeys } from '../lib/keyManager';
import { callGroqWithFallback } from '../lib/ai/pipeline';
import {
  estimateDynamicCurriculum,
  researchAndSynthesizeStepContent,
} from '../services/aiOrchestrator';
import {
  fetchAndSynthesizeStepDocumentation,
  getDifficultyTier,
} from '../services/documentationService';
import { fetchVerifiedStepVideos } from '../services/videoService';
import { generateAthleticFuelingPlan } from '../services/nutritionEngine';
import { sourceStepContent, sourceStepContentFast } from '../services/resourceSourcingService';
import { generateStepQuiz, evaluateQuizSubmission } from '../services/quizService';

import { callGroqJson } from '../lib/foundation';
import { LEARNING_CONFIG } from '../config/learning';

// Compound in-memory cache: skill:${skillId}:step:${stepNumber}:lang:${language}
const stepResourceMemoryCache = new Map<string, { data: any; cachedAt: number }>();

export const skillsRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // POST /api/skills/suggest-subgenres — Dynamic Sub-Genre Engine
  fastify.post('/api/skills/suggest-subgenres', async (req, reply) => {
    const { skill } = (req.body || {}) as { skill?: string };
    if (!skill || typeof skill !== 'string') {
      return reply.status(400).send({ error: 'skill is required' });
    }

    const trimmed = skill.trim();
    if (trimmed.length < 3 || trimmed.length > 80) {
      return reply.status(400).send({ error: 'Skill name must be between 3 and 80 characters' });
    }

    const normalized = trimmed.toLowerCase().replace(/\s+/g, ' ');

    try {
      const cached = await prisma.subgenreCache.findUnique({
        where: { normalizedSkillName: normalized },
      });

      if (cached && Array.isArray(cached.subgenres)) {
        return reply.send({ subgenres: cached.subgenres, cached: true });
      }

      const prompt = `You are a Principal Curriculum Taxonomist. A user wants to learn the skill: "${trimmed}". Return 4 to 6 specific professional sub-genres or specializations of THIS skill. Do not return levels like Beginner/Advanced/Intermediate. Return JSON: {"subgenres": ["..."]}`;

      const res = await callGroqJson<{ subgenres: string[] }>(
        'You are a Principal Curriculum Taxonomist. Return strictly JSON.',
        prompt,
        {
          validate: (v: any) => {
            if (!Array.isArray(v?.subgenres)) return false;
            if (v.subgenres.length < 4 || v.subgenres.length > 6) return false;
            const seen = new Set<string>();
            for (const s of v.subgenres) {
              if (typeof s !== 'string') return false;
              const clean = s.trim();
              if (clean.length < 3 || clean.length > 60) return false;
              if (/^(beginner|intermediate|advanced|basic|expert)$/i.test(clean)) return false;
              const lower = clean.toLowerCase();
              if (seen.has(lower)) return false;
              seen.add(lower);
            }
            return true;
          },
          maxTokens: 500,
          temperature: 0.3,
        }
      );

      const cleanedSubgenres = res.subgenres.map((s) => s.trim());

      await prisma.subgenreCache.upsert({
        where: { normalizedSkillName: normalized },
        create: {
          normalizedSkillName: normalized,
          subgenres: cleanedSubgenres as any,
        },
        update: {
          subgenres: cleanedSubgenres as any,
        },
      });

      return reply.send({ subgenres: cleanedSubgenres, cached: false });
    } catch (err: any) {
      fastify.log.error(err, '[SuggestSubgenres] Failed');
      return reply.status(500).send({ error: 'Failed to suggest subgenres' });
    }
  });

  // 1. POST /api/skills/generate — Create dynamic curriculum using Tavily + Groq
  fastify.post('/api/skills/generate', async (req, reply) => {
    try {
      const body = (req.body || {}) as {
        userId?: string;
        skillName: string;
        subGenre?: string;
        skillCategory?: 'cognitive' | 'physical';
        targetMastery?: string;
        dietaryPreference?: string;
        medicalConditions?: string;
        preferredLanguage?: string;
      };

      if (!body.skillName || !body.skillName.trim()) {
        return reply.status(400).send({ error: 'skillName is required' });
      }

      const skillName = body.skillName.trim();
      const subGenre = (body.subGenre || 'Core Foundations').trim();
      const skillCategory = body.skillCategory || 'cognitive';
      const targetMastery = body.targetMastery || 'Intermediate';
      const preferredLanguage = body.preferredLanguage || 'en';
      const userId = body.userId || undefined;

      // Stage A: Dynamic Step Estimation (Groq)
      const curriculum = await estimateDynamicCurriculum({
        skillName,
        subGenre,
        skillCategory,
        targetMastery,
        preferredLanguage,
      });

      // Insert user_skills record
      const skillRows: any[] = await prisma.$queryRawUnsafe(`
        INSERT INTO user_skills (
          user_id,
          skill_name,
          skill_category,
          sub_genre,
          target_mastery_level,
          total_steps,
          current_step,
          is_completed,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, 1, FALSE, NOW(), NOW())
        RETURNING *;
      `, userId || null, skillName, skillCategory, subGenre, targetMastery, curriculum.totalSteps);

      const userSkill = skillRows[0];
      const skillId = userSkill.id;

      // Stage B: Initialize Step 1 (Unlocked, un-sourced for sub-second trajectory enrollment)
      const step1Plan = curriculum.steps[0] || {
        title: `${skillName}: Foundations & Invariants`,
        description: `Master core foundational mechanics and first principles.`,
        requiredPracticeDays: 1,
      };

      // Insert Step 1 (Unlocked)
      await prisma.$executeRawUnsafe(`
        INSERT INTO skill_steps (
          skill_id,
          step_number,
          title,
          description,
          required_practice_days,
          practice_days_completed,
          quiz_passed,
          quiz_score,
          video_url,
          video_id,
          documentation_markdown,
          documentation_source_url,
          documentation_quadrants,
          is_unlocked,
          is_completed
        )
        VALUES ($1, $2, $3, $4, $5, 0, FALSE, NULL, '', '', '', '', '[]'::jsonb, TRUE, FALSE)
        ON CONFLICT (skill_id, step_number) DO NOTHING;
      `,
        skillId,
        1,
        step1Plan.title,
        step1Plan.description || `Master foundational principles of ${skillName}`,
        step1Plan.requiredPracticeDays || 1
      );

      // Pre-populate remaining steps (Locked)
      for (let i = 1; i < curriculum.steps.length; i++) {
        const p = curriculum.steps[i];
        await prisma.$executeRawUnsafe(`
          INSERT INTO skill_steps (
            skill_id,
            step_number,
            title,
            description,
            required_practice_days,
            practice_days_completed,
            quiz_passed,
            video_url,
            video_id,
            documentation_markdown,
            documentation_source_url,
            documentation_quadrants,
            is_unlocked,
            is_completed
          )
          VALUES ($1, $2, $3, $4, $5, 0, FALSE, '', '', '', '', '[]'::jsonb, FALSE, FALSE)
          ON CONFLICT (skill_id, step_number) DO NOTHING;
        `, skillId, p.stepNumber, p.title, p.description, p.requiredPracticeDays);
      }

      // Fetch created steps
      const steps: any[] = await prisma.$queryRawUnsafe(`
        SELECT * FROM skill_steps WHERE skill_id = $1 ORDER BY step_number ASC;
      `, skillId);

      return reply.status(201).send({
        skill: userSkill,
        overview: curriculum.roadmapOverview,
        steps,
        currentStepContent: null,
      });
    } catch (err: any) {
      fastify.log.error(err, '[POST /api/skills/generate] Failed');
      return reply.status(500).send({ error: 'Failed to synthesize curriculum roadmap' });
    }
  });

  // 2. GET /api/skills/:skillId — Fetch skill and step progression
  fastify.get('/api/skills/:skillId', async (req, reply) => {
    try {
      const { skillId } = req.params as { skillId: string };
      const skillRows: any[] = await prisma.$queryRawUnsafe(`
        SELECT * FROM user_skills WHERE id = $1 LIMIT 1;
      `, skillId);

      if (!skillRows || skillRows.length === 0) {
        return reply.status(404).send({ error: 'Skill not found' });
      }

      const skill = skillRows[0];
      const steps: any[] = await prisma.$queryRawUnsafe(`
        SELECT * FROM skill_steps WHERE skill_id = $1 ORDER BY step_number ASC;
      `, skillId);

      return reply.status(200).send({ skill, steps });
    } catch (err: any) {
      fastify.log.error(err, '[GET /api/skills/:skillId] Failed');
      return reply.status(500).send({ error: 'Failed to load skill' });
    }
  });

  // 2b. GET /api/skills/:skillId/step/:stepNumber — Isolated Step Resource Route (Strict Progressive Difficulty & Zero Repetition)
  fastify.get('/api/skills/:skillId/step/:stepNumber', async (req, reply) => {
    try {
      const { skillId, stepNumber } = req.params as { skillId: string; stepNumber: string };
      const stepNum = parseInt(stepNumber, 10);
      const queryParams = (req.query || {}) as { language?: string; userId?: string };
      const language = (queryParams.language || 'en').toLowerCase().trim();

      if (isNaN(stepNum) || stepNum < 1) {
        return reply.status(400).send({ error: 'Valid positive stepNumber is required.' });
      }

      // 1. Compound in-memory cache check (Never share resources between step 1 and step 2)
      const cacheKey = `skill:${skillId}:step:${stepNum}:lang:${language}`;
      const cachedEntry = stepResourceMemoryCache.get(cacheKey);
      if (cachedEntry && Date.now() - cachedEntry.cachedAt < 1000 * 60 * 30) {
        return reply.status(200).send(cachedEntry.data);
      }

      // 2. Fetch skill from database
      const skillRows: any[] = await prisma.$queryRawUnsafe(`
        SELECT * FROM user_skills WHERE id = $1 LIMIT 1;
      `, skillId);

      if (!skillRows || skillRows.length === 0) {
        return reply.status(404).send({ error: 'Skill not found' });
      }

      const skill = skillRows[0];
      const userId = queryParams.userId || skill.user_id || undefined;

      // 3. Fetch step row strictly keyed by (skill_id, step_number)
      let stepRows: any[] = await prisma.$queryRawUnsafe(`
        SELECT * FROM skill_steps 
        WHERE skill_id = $1 AND step_number = $2 
        LIMIT 1;
      `, skillId, stepNum);

      let step = stepRows && stepRows.length > 0 ? stepRows[0] : null;

      // Initialize step row if missing
      if (!step) {
        const diffTier = getDifficultyTier(stepNum);
        const title = `Step ${stepNum}: ${diffTier.difficultyLevel}`;
        const desc = diffTier.focus;
        await prisma.$executeRawUnsafe(`
          INSERT INTO skill_steps (
            skill_id, step_number, title, description,
            required_practice_days, practice_days_completed,
            quiz_passed, video_url, video_id, documentation_markdown,
            documentation_source_url, documentation_quadrants, is_unlocked, is_completed
          )
          VALUES ($1, $2, $3, $4, 1, 0, FALSE, '', '', '', '', '[]'::jsonb, $5, FALSE)
          ON CONFLICT (skill_id, step_number) DO NOTHING;
        `, skillId, stepNum, title, desc, stepNum === 1);

        stepRows = await prisma.$queryRawUnsafe(`
          SELECT * FROM skill_steps WHERE skill_id = $1 AND step_number = $2 LIMIT 1;
        `, skillId, stepNum);
        step = stepRows[0];
      }

      // 4. Non-blocking GET: Return step data immediately without slow synchronous synthesis
      const isSourced = Boolean(step.is_sourced || (step.video_id && (step.documentation_markdown || step.topics)));

      // 5. Structure payload
      const responsePayload = {
        success: true,
        skillId,
        stepNumber: stepNum,
        step: {
          ...step,
          is_sourced: isSourced,
        },
        videos: step.video_id ? [
          {
            id: step.video_id,
            videoId: step.video_id,
            url: step.video_url || `https://www.youtube.com/watch?v=${step.video_id}`,
            title: `${step.title} - Video Walkthrough`,
            subtitle: step.description,
            type: 'youtube',
          },
        ] : [],
        documentation: step.documentation_markdown ? {
          title: `${step.title} - Technical Guide`,
          markdown: step.documentation_markdown,
          sourceUrl: step.documentation_source_url,
          quadrants: step.documentation_quadrants,
          type: 'doc',
        } : null,
      };

      // Cache compound key only if the step has already been sourced
      if (isSourced) {
        stepResourceMemoryCache.set(cacheKey, {
          data: responsePayload,
          cachedAt: Date.now(),
        });
      }

      return reply.status(200).send(responsePayload);
    } catch (err: any) {
      fastify.log.error(err, '[GET /api/skills/:skillId/step/:stepNumber] Failed');
      return reply.status(500).send({ error: 'Failed to load step resources' });
    }
  });

  // 2c. POST /api/skills/:skillId/step/:stepNumber/source — On-Demand Topic Sourcing & Study Guides
  fastify.post('/api/skills/:skillId/step/:stepNumber/source', async (req, reply) => {
    try {
      const { skillId, stepNumber } = req.params as { skillId: string; stepNumber: string };
      const stepNum = parseInt(stepNumber, 10);
      const body = (req.body || {}) as { userId?: string };

      if (isNaN(stepNum) || stepNum < 1) {
        return reply.status(400).send({ error: 'Valid positive stepNumber is required.' });
      }

      // 1. Resolve User ID safely (handles JWT, session, or body fallback)
      let userId = (req as any).user?.id || body.userId;
      if (!userId) {
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
          try {
            const decoded: any = jwt.verify(
              authHeader.split(' ')[1],
              process.env.JWT_SECRET || 'skilltrack_enterprise_jwt_secret_2026'
            );
            userId = decoded.userId || decoded.id;
          } catch (_) {}
        }
      }

      if (!userId) {
        try {
          const fallbackUser = await db.query('SELECT id FROM users LIMIT 1');
          userId = fallbackUser.rows[0]?.id || '00000000-0000-0000-0000-000000000000';
        } catch (_) {
          userId = '00000000-0000-0000-0000-000000000000';
        }
      }

      const sourced = await sourceStepContentFast(userId, skillId, stepNum);

      // Invalidate memory cache for this step across languages so subsequent GET calls return fresh data
      for (const lang of ['en', 'hi', 'es', 'fr', 'de']) {
        const cKey = `skill:${skillId}:step:${stepNum}:lang:${lang}`;
        stepResourceMemoryCache.delete(cKey);
      }

      return reply.status(200).send({
        success: true,
        step: sourced,
        ...sourced,
      });
    } catch (err: any) {
      fastify.log.error(err, '[POST /api/skills/:skillId/step/:stepNumber/source] Failed');
      return reply.status(500).send({
        success: false,
        error: err.message || 'Internal resource synthesis failure',
      });
    }
  });

  // 2d. POST /api/skills/:skillId/step/:stepNumber/quiz/generate — Resource-grounded Socratic Quiz
  fastify.post('/api/skills/:skillId/step/:stepNumber/quiz/generate', async (req, reply) => {
    try {
      const { skillId, stepNumber } = req.params as { skillId: string; stepNumber: string };
      const stepNum = parseInt(stepNumber, 10);
      const body = (req.body || {}) as { userId?: string };

      if (isNaN(stepNum) || stepNum < 1) {
        return reply.status(400).send({ error: 'Valid positive stepNumber is required.' });
      }

      let userId = body.userId;
      if (!userId) {
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
          try {
            const decoded: any = jwt.verify(
              authHeader.split(' ')[1],
              process.env.JWT_SECRET || 'skilltrack_enterprise_jwt_secret_2026'
            );
            userId = decoded.userId || decoded.id;
          } catch (_) {}
        }
      }

      if (!userId) {
        userId = 'default-user';
      }

      const questions = await generateStepQuiz(userId, skillId, stepNum);
      return reply.status(200).send({
        success: true,
        questions,
        questionCount: questions.length,
        passingThreshold: 70,
      });
    } catch (err: any) {
      fastify.log.error(err, '[POST /api/skills/:skillId/step/:stepNumber/quiz/generate] Failed');
      return reply.status(500).send({ error: err.message || 'Failed to generate step quiz' });
    }
  });

  // 2e. POST /api/skills/:skillId/step/:stepNumber/quiz/evaluate — Strict 70% Pass Gate Evaluator
  fastify.post('/api/skills/:skillId/step/:stepNumber/quiz/evaluate', async (req, reply) => {
    try {
      const { skillId, stepNumber } = req.params as { skillId: string; stepNumber: string };
      const stepNum = parseInt(stepNumber, 10);
      const body = (req.body || {}) as { userId?: string; answers?: number[] };

      if (isNaN(stepNum) || stepNum < 1) {
        return reply.status(400).send({ error: 'Valid positive stepNumber is required.' });
      }

      let userId = body.userId;
      if (!userId) {
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
          try {
            const decoded: any = jwt.verify(
              authHeader.split(' ')[1],
              process.env.JWT_SECRET || 'skilltrack_enterprise_jwt_secret_2026'
            );
            userId = decoded.userId || decoded.id;
          } catch (_) {}
        }
      }

      if (!userId) {
        userId = 'default-user';
      }

      const answers = Array.isArray(body.answers) ? body.answers : [];
      const result = await evaluateQuizSubmission(userId, skillId, stepNum, answers);

      return reply.status(200).send({
        success: true,
        ...result,
      });
    } catch (err: any) {
      fastify.log.error(err, '[POST /api/skills/:skillId/step/:stepNumber/quiz/evaluate] Failed');
      return reply.status(500).send({ error: err.message || 'Failed to evaluate step quiz' });
    }
  });

  // 3. GET /api/skills/user/:userId — List active skills for user
  fastify.get('/api/skills/user/:userId', async (req, reply) => {
    try {
      const { userId } = req.params as { userId: string };
      const skills: any[] = await prisma.$queryRawUnsafe(`
        SELECT * FROM user_skills WHERE user_id = $1 ORDER BY updated_at DESC;
      `, userId);

      return reply.status(200).send({ skills });
    } catch (err: any) {
      fastify.log.error(err, '[GET /api/skills/user/:userId] Failed');
      return reply.status(500).send({ error: 'Failed to load user skills' });
    }
  });

  // 3b. GET /api/skills/enrolled — List active cognitive enrolled skills
  fastify.get('/api/skills/enrolled', async (req, reply) => {
    try {
      let userId: string | null = null;
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        try {
          const decoded: any = jwt.verify(
            authHeader.split(' ')[1],
            process.env.JWT_SECRET || 'skilltrack_enterprise_jwt_secret_2026'
          );
          userId = decoded.userId || decoded.id;
        } catch (_) {}
      }

      let skills: any[] = [];
      if (userId) {
        skills = await prisma.$queryRawUnsafe(`
          SELECT * FROM user_skills WHERE user_id = $1 ORDER BY updated_at DESC;
        `, userId);
      } else {
        skills = await prisma.$queryRawUnsafe(`
          SELECT * FROM user_skills ORDER BY updated_at DESC LIMIT 10;
        `);
      }

      return reply.status(200).send({ skills: skills || [] });
    } catch (err: any) {
      fastify.log.error(err, '[GET /api/skills/enrolled] Failed');
      return reply.status(200).send({ skills: [] });
    }
  });

  // 4. PATCH /api/skills/:skillId/steps/:stepNumber/practice-day — Check off practice session
  fastify.patch('/api/skills/:skillId/steps/:stepNumber/practice-day', async (req, reply) => {
    try {
      const { skillId, stepNumber } = req.params as { skillId: string; stepNumber: string };
      const num = parseInt(stepNumber, 10);

      const rows: any[] = await prisma.$queryRawUnsafe(`
        UPDATE skill_steps 
        SET practice_days_completed = practice_days_completed + 1
        WHERE skill_id = $1 AND step_number = $2
        RETURNING *;
      `, skillId, num);

      if (!rows || rows.length === 0) {
        return reply.status(404).send({ error: 'Step not found' });
      }

      const step = rows[0];
      const isCalendarComplete = step.practice_days_completed >= step.required_practice_days;

      return reply.status(200).send({
        success: true,
        stepNumber: num,
        practiceDaysCompleted: step.practice_days_completed,
        requiredPracticeDays: step.required_practice_days,
        isCalendarComplete,
      });
    } catch (err: any) {
      fastify.log.error(err, '[PATCH practice-day] Failed');
      return reply.status(500).send({ error: 'Failed to update practice days' });
    }
  });

  // 5. POST /api/skills/:skillId/steps/:stepNumber/advance — Strict Dual-Gate Progression Lock
  fastify.post('/api/skills/:skillId/steps/:stepNumber/advance', async (req, reply) => {
    try {
      const { skillId, stepNumber } = req.params as { skillId: string; stepNumber: string };
      const num = parseInt(stepNumber, 10);

      // Fetch skill and step
      const skillRows: any[] = await prisma.$queryRawUnsafe(`
        SELECT * FROM user_skills WHERE id = $1 LIMIT 1;
      `, skillId);
      if (!skillRows || skillRows.length === 0) {
        return reply.status(404).send({ error: 'Skill not found' });
      }
      const skill = skillRows[0];

      const stepRows: any[] = await prisma.$queryRawUnsafe(`
        SELECT * FROM skill_steps WHERE skill_id = $1 AND step_number = $2 LIMIT 1;
      `, skillId, num);
      if (!stepRows || stepRows.length === 0) {
        return reply.status(404).send({ error: 'Step not found' });
      }
      const step = stepRows[0];

      // DUAL-GATE EVALUATION
      if (skill.skill_category === 'physical') {
        const calendarFinished = step.practice_days_completed >= step.required_practice_days;
        const quizPassed = Boolean(step.quiz_passed);

        if (!calendarFinished && quizPassed) {
          return reply.status(403).send({
            error: `Physical skill progression locked. You must complete all ${step.required_practice_days} practice days on your training calendar before advancing.`,
            canProgress: false,
            reason: 'INCOMPLETE_PRACTICE_CALENDAR',
          });
        }

        if (calendarFinished && !quizPassed) {
          return reply.status(403).send({
            error: `Practice days completed! Pass the mechanical Socratic Quiz to unlock Step ${num + 1}.`,
            canProgress: false,
            reason: 'QUIZ_NOT_PASSED',
          });
        }

        if (!calendarFinished && !quizPassed) {
          return reply.status(403).send({
            error: `Both daily practice calendar and Socratic quiz are required to unlock Step ${num + 1}.`,
            canProgress: false,
            reason: 'BOTH_GATES_INCOMPLETE',
          });
        }
      } else {
        // Cognitive skills require passed quiz
        if (!step.quiz_passed) {
          return reply.status(403).send({
            error: `Pass the conceptual Socratic Quiz with >=${LEARNING_CONFIG.PASS_THRESHOLD_PERCENT}% to unlock Step ${num + 1}.`,
            canProgress: false,
            reason: 'QUIZ_NOT_PASSED',
          });
        }
      }

      // Mark current step completed
      await prisma.$executeRawUnsafe(`
        UPDATE skill_steps 
        SET is_completed = TRUE 
        WHERE skill_id = $1 AND step_number = $2;
      `, skillId, num);

      // Check if next step exists
      const nextStepNum = num + 1;
      const nextStepRows: any[] = await prisma.$queryRawUnsafe(`
        SELECT * FROM skill_steps WHERE skill_id = $1 AND step_number = $2;
      `, skillId, nextStepNum);

      let isSkillComplete = false;
      if (nextStepRows && nextStepRows.length > 0) {
        // Unlock next step
        const nextStep = nextStepRows[0];

        // Synthesize content for next step if not populated yet
        if (!nextStep.documentation_markdown || nextStep.documentation_markdown.trim() === '') {
          const synthesized = await researchAndSynthesizeStepContent({
            userId: skill.user_id,
            skillName: skill.skill_name,
            subGenre: skill.sub_genre,
            skillCategory: skill.skill_category,
            stepNumber: nextStepNum,
            stepTitle: nextStep.title,
            stepDescription: nextStep.description,
            requiredPracticeDays: nextStep.required_practice_days,
          });

          await prisma.$executeRawUnsafe(`
            UPDATE skill_steps SET
              video_url = $1,
              video_id = $2,
              documentation_markdown = $3,
              documentation_source_url = $4,
              documentation_quadrants = $5::jsonb,
              daily_diet_plan = $6::jsonb,
              is_unlocked = TRUE
            WHERE skill_id = $7 AND step_number = $8;
          `,
            synthesized.videoUrl,
            synthesized.videoId,
            synthesized.documentationMarkdown,
            synthesized.documentationSourceUrl,
            JSON.stringify(synthesized.documentationQuadrants),
            synthesized.dailyDietPlan ? JSON.stringify(synthesized.dailyDietPlan) : null,
            skillId,
            nextStepNum
          );
        } else {
          await prisma.$executeRawUnsafe(`
            UPDATE skill_steps SET is_unlocked = TRUE WHERE skill_id = $1 AND step_number = $2;
          `, skillId, nextStepNum);
        }

        // Update current_step on user_skills
        await prisma.$executeRawUnsafe(`
          UPDATE user_skills SET current_step = $1, updated_at = NOW() WHERE id = $2;
        `, nextStepNum, skillId);
      } else {
        // Completed final step!
        isSkillComplete = true;
        await prisma.$executeRawUnsafe(`
          UPDATE user_skills SET is_completed = TRUE, updated_at = NOW() WHERE id = $1;
        `, skillId);

        if (skill.user_id) {
          try {
            await prisma.$executeRawUnsafe(`
              UPDATE users SET total_skills_completed = total_skills_completed + 1 WHERE id = $1;
            `, skill.user_id);
          } catch (_) {}
        }
      }

      // Award +150 XP
      if (skill.user_id) {
        try {
          await prisma.$executeRawUnsafe(`
            UPDATE users SET xp = xp + 150 WHERE id = $1;
          `, skill.user_id);
        } catch (_) {}
      }

      return reply.status(200).send({
        success: true,
        canProgress: true,
        isSkillComplete,
        nextStepUnlocked: !isSkillComplete,
        newStepNumber: nextStepNum,
        xpGained: 150,
      });
    } catch (err: any) {
      fastify.log.error(err, '[POST advance] Failed');
      return reply.status(500).send({ error: 'Failed to advance step' });
    }
  });

  // 6. POST /api/skills/quiz/evaluate — Strict Socratic Evaluator (Groq)
  fastify.post('/api/skills/quiz/evaluate', async (req, reply) => {
    try {
      const {
        skillName,
        stepNumber,
        quizSubmissions,
        skillId,
      } = (req.body || {}) as {
        skillName?: string;
        stepNumber?: number;
        quizSubmissions: Array<{
          questionId: string;
          questionText: string;
          userAnswer: string;
          correctAnswer?: string;
        }>;
        skillId?: string;
      };

      if (!quizSubmissions || !Array.isArray(quizSubmissions) || quizSubmissions.length === 0) {
        return reply.status(400).send({ error: 'quizSubmissions array is required' });
      }

      const { groqKey } = await getEffectiveKeys();
      const evaluationPrompt = `You are a Strict Socratic Examiner.
Grade the learner's answers against the required conceptual standards.
Skill: "${skillName || 'General Skill'}", Step: "${stepNumber || 1}".

Questions and Student Submissions:
${JSON.stringify(quizSubmissions, null, 2)}

Evaluation Criteria:
- Grade bluntly and strictly based on conceptual accuracy.
- Calculate an exact percentage score between 0 and 100 based on accuracy.
- Passing threshold is strictly ${LEARNING_CONFIG.PASS_THRESHOLD_PERCENT}%. If they do not demonstrate clear understanding, score below ${LEARNING_CONFIG.PASS_THRESHOLD_PERCENT}%.
- Do NOT inflate scores.

Return strictly JSON:
{
  "scorePercentage": number,
  "passed": boolean,
  "grade": "A" | "B" | "C" | "F",
  "questionBreakdown": [
    {
      "questionId": "string",
      "isCorrect": boolean,
      "critique": "Blunt explanation of what was missing or why it was correct",
      "modelAnswer": "Canonical correct explanation"
    }
  ],
  "diagnosticReport": "Comprehensive assessment of strengths and knowledge gaps"
}`;

      let evaluationResult: any;
      try {
        const res = await callGroqWithFallback(
          [
            { role: 'system', content: evaluationPrompt },
            { role: 'user', content: `Perform the strict Socratic grading now.` },
          ],
          { apiKey: groqKey || '', temperature: 0.1, jsonMode: true }
        );

        evaluationResult = JSON.parse(res.content);
      } catch (llmErr) {
        // Deterministic fallback grading based on exact match
        let correctCount = 0;
        const breakdown = quizSubmissions.map((q) => {
          const isCorrect = q.correctAnswer
            ? q.userAnswer?.trim().toUpperCase() === q.correctAnswer?.trim().toUpperCase()
            : false;
          if (isCorrect) correctCount++;
          return {
            questionId: q.questionId,
            isCorrect,
            critique: isCorrect ? 'Conceptual answer validated.' : 'Incorrect option selected.',
            modelAnswer: q.correctAnswer || 'Required canonical principle.',
          };
        });

        const scorePercentage = Math.round((correctCount / quizSubmissions.length) * 100);
        evaluationResult = {
          scorePercentage,
          passed: scorePercentage >= LEARNING_CONFIG.PASS_THRESHOLD_PERCENT,
          grade: scorePercentage >= 90 ? 'A' : scorePercentage >= LEARNING_CONFIG.PASS_THRESHOLD_PERCENT ? 'B' : 'F',
          questionBreakdown: breakdown,
          diagnosticReport: scorePercentage >= LEARNING_CONFIG.PASS_THRESHOLD_PERCENT
            ? 'Candidate demonstrated mastery of foundational principles.'
            : 'Candidate exhibited misconceptions on key scenarios. Further study required.',
        };
      }

      const scorePercentage = Math.max(0, Math.min(100, Number(evaluationResult.scorePercentage) || 0));
      const passed = scorePercentage >= LEARNING_CONFIG.PASS_THRESHOLD_PERCENT;

      // Update skill_steps if skillId & stepNumber provided
      if (skillId && stepNumber) {
        try {
          await prisma.$executeRawUnsafe(`
            UPDATE skill_steps 
            SET quiz_passed = $1, quiz_score = $2, is_completed = $3
            WHERE skill_id = $4 AND step_number = $5;
          `, passed, scorePercentage, passed, skillId, Number(stepNumber));

          if (passed) {
            await prisma.$executeRawUnsafe(`
              UPDATE skill_steps 
              SET is_unlocked = TRUE 
              WHERE skill_id = $1 AND step_number = $2;
            `, skillId, Number(stepNumber) + 1);
          }
        } catch (_) {}
      }

      return reply.status(200).send({
        scorePercentage,
        passed,
        passingThreshold: LEARNING_CONFIG.PASS_THRESHOLD_PERCENT,
        grade: evaluationResult.grade || (passed ? 'B' : 'F'),
        questionBreakdown: evaluationResult.questionBreakdown || [],
        diagnosticReport: evaluationResult.diagnosticReport || 'Evaluation complete.',
        xpGained: passed ? 150 : 0,
      });
    } catch (err: any) {
      fastify.log.error(err, '[POST /api/quiz/evaluate] Failed');
      return reply.status(500).send({ error: 'Quiz evaluation failed' });
    }
  });
};

export default skillsRoutes;
