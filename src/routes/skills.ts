import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import prisma from '../lib/prisma';
import { getEffectiveKeys } from '../lib/keyManager';
import { callGroqWithFallback } from '../lib/ai/pipeline';
import {
  estimateDynamicCurriculum,
  researchAndSynthesizeStepContent,
} from '../services/aiOrchestrator';

export const skillsRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
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

      // Stage B: Synthesize Step 1 with Tavily + Groq
      const step1Plan = curriculum.steps[0];
      const step1Content = await researchAndSynthesizeStepContent({
        userId,
        skillName,
        subGenre,
        skillCategory,
        stepNumber: 1,
        stepTitle: step1Plan.title,
        stepDescription: step1Plan.description,
        requiredPracticeDays: step1Plan.requiredPracticeDays,
        dietaryPreference: body.dietaryPreference,
        medicalConditions: body.medicalConditions,
        preferredLanguage,
      });

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
          daily_diet_plan,
          is_unlocked,
          is_completed
        )
        VALUES ($1, $2, $3, $4, $5, 0, FALSE, NULL, $6, $7, $8, $9, $10::jsonb, $11::jsonb, TRUE, FALSE)
        ON CONFLICT (skill_id, step_number) DO UPDATE SET
          title = EXCLUDED.title,
          description = EXCLUDED.description,
          video_url = EXCLUDED.video_url,
          video_id = EXCLUDED.video_id,
          documentation_markdown = EXCLUDED.documentation_markdown,
          documentation_quadrants = EXCLUDED.documentation_quadrants,
          daily_diet_plan = EXCLUDED.daily_diet_plan;
      `,
        skillId,
        1,
        step1Content.title,
        step1Content.description,
        step1Content.requiredPracticeDays,
        step1Content.videoUrl,
        step1Content.videoId,
        step1Content.documentationMarkdown,
        step1Content.documentationSourceUrl,
        JSON.stringify(step1Content.documentationQuadrants),
        step1Content.dailyDietPlan ? JSON.stringify(step1Content.dailyDietPlan) : null
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
        currentStepContent: step1Content,
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
            error: `Pass the conceptual Socratic Quiz with >=75% to unlock Step ${num + 1}.`,
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

  // 6. POST /api/quiz/evaluate — Strict Socratic Evaluator (Groq)
  fastify.post('/api/quiz/evaluate', async (req, reply) => {
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
- Passing threshold is strictly 75%. If they do not demonstrate clear understanding, score below 75%.
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
          passed: scorePercentage >= 75,
          grade: scorePercentage >= 90 ? 'A' : scorePercentage >= 75 ? 'B' : 'F',
          questionBreakdown: breakdown,
          diagnosticReport: scorePercentage >= 75
            ? 'Candidate demonstrated mastery of foundational principles.'
            : 'Candidate exhibited misconceptions on key scenarios. Further study required.',
        };
      }

      const scorePercentage = Math.max(0, Math.min(100, Number(evaluationResult.scorePercentage) || 0));
      const passed = scorePercentage >= 75;

      // Update skill_steps if skillId & stepNumber provided
      if (skillId && stepNumber) {
        try {
          await prisma.$executeRawUnsafe(`
            UPDATE skill_steps 
            SET quiz_passed = $1, quiz_score = $2
            WHERE skill_id = $3 AND step_number = $4;
          `, passed, scorePercentage, skillId, Number(stepNumber));
        } catch (_) {}
      }

      return reply.status(200).send({
        scorePercentage,
        passed,
        passingThreshold: 75,
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
