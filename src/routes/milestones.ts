import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import prisma from '../lib/prisma';

export const milestoneRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // 1. POST /api/milestones/submit-quiz — Socratic Quiz Progression Unfreeze (Module 3)
  fastify.post('/api/milestones/submit-quiz', async (req, reply) => {
    try {
      const {
        userId,
        skillId = 'default-skill',
        milestoneOrder = 1,
        scorePercentage = 0,
        skillTitle = 'Skill Mastery',
      } = (req.body || {}) as {
        userId: string;
        skillId: string;
        milestoneOrder: number;
        scorePercentage: number;
        skillTitle?: string;
      };

      if (!userId) {
        return reply.status(400).send({ error: 'userId is required' });
      }

      const passed = Number(scorePercentage) >= 70;

      // Ensure milestone record exists
      try {
        await prisma.$executeRawUnsafe(`
          INSERT INTO user_milestones (user_id, skill_id, milestone_order, title, status, unlocked_at)
          VALUES ($1, $2, $3, $4, 'unlocked', NOW())
          ON CONFLICT (user_id, skill_id, milestone_order) DO NOTHING;
        `, userId, skillId, milestoneOrder, `Milestone ${milestoneOrder}: Foundations`);
      } catch {}

      if (!passed) {
        return reply.status(200).send({
          success: false,
          passed: false,
          nextMilestoneUnlocked: false,
          currentMilestoneIndex: milestoneOrder,
          scorePercentage,
          xpGained: 0,
          message: 'Evaluation score did not meet the 70% threshold. Diagnostic review recommended.',
        });
      }

      // If passed >= 70%:
      // 1. Mark current milestone completed
      try {
        await prisma.$executeRawUnsafe(`
          UPDATE user_milestones 
          SET status = 'completed', completed_at = NOW(), quiz_score = $1
          WHERE user_id = $2 AND skill_id = $3 AND milestone_order = $4;
        `, Math.round(scorePercentage), userId, skillId, milestoneOrder);
      } catch (err) {
        fastify.log.warn(err, '[user_milestones] Mark completed error');
      }

      // 2. Unlock next sequential milestone
      const nextMilestoneOrder = milestoneOrder + 1;
      try {
        await prisma.$executeRawUnsafe(`
          INSERT INTO user_milestones (user_id, skill_id, milestone_order, title, status, unlocked_at)
          VALUES ($1, $2, $3, $4, 'unlocked', NOW())
          ON CONFLICT (user_id, skill_id, milestone_order) DO UPDATE
          SET status = 'unlocked', unlocked_at = NOW();
        `, userId, skillId, nextMilestoneOrder, `Milestone ${nextMilestoneOrder}: Advanced Architecture`);
      } catch (err) {
        fastify.log.warn(err, '[user_milestones] Unlock next error');
      }

      // 3. Update user XP (+150 XP) in users table and user_profiles table
      try {
        await prisma.$executeRawUnsafe(`
          UPDATE users 
          SET xp = COALESCE(xp, 0) + 150, updated_at = NOW()
          WHERE id = $1 OR email = $1;
        `, userId);
      } catch {}

      try {
        await prisma.userProfile.updateMany({
          where: { OR: [{ id: userId }, { email: userId }] },
          data: { totalXp: { increment: 150 } },
        });
      } catch {}

      // 4. Also unfreeze corresponding SkillStep if linked
      try {
        const workspace = await prisma.workspace.findFirst({
          where: {
            OR: [{ id: skillId }, { title: { contains: skillTitle, mode: 'insensitive' } }],
          },
          include: { steps: { orderBy: { stepIndex: 'asc' } } },
        });

        if (workspace && workspace.steps.length > 0) {
          const currentStep = workspace.steps.find((s) => s.stepIndex === milestoneOrder);
          const nextStep = workspace.steps.find((s) => s.stepIndex === nextMilestoneOrder);

          if (currentStep) {
            await prisma.skillStep.update({
              where: { id: currentStep.id },
              data: { status: 'PASSED' },
            });
          }
          if (nextStep && nextStep.status === 'LOCKED') {
            await prisma.skillStep.update({
              where: { id: nextStep.id },
              data: { status: 'STUDY_UNGENERATED' },
            });
          }
        }
      } catch (wsErr) {
        fastify.log.warn(wsErr, '[SkillStep] Step status sync warning');
      }

      return reply.status(200).send({
        success: true,
        passed: true,
        nextMilestoneUnlocked: true,
        newMilestoneIndex: nextMilestoneOrder,
        xpGained: 150,
        scorePercentage,
        message: `Milestone ${milestoneOrder} cleared! Level ${nextMilestoneOrder} unlocked with +150 XP.`,
      });
    } catch (err: any) {
      fastify.log.error(err, '[POST /api/milestones/submit-quiz] Failed');
      return reply.status(500).send({ error: 'Failed to process milestone quiz progression.' });
    }
  });

  // 2. GET /api/milestones/:userId/:skillId — Fetch user milestone status tree
  fastify.get('/api/milestones/:userId/:skillId', async (req, reply) => {
    const { userId, skillId } = req.params as { userId: string; skillId: string };
    try {
      let milestones: any[] = [];
      try {
        milestones = await prisma.$queryRawUnsafe(`
          SELECT * FROM user_milestones 
          WHERE user_id = $1 AND skill_id = $2
          ORDER BY milestone_order ASC;
        `, userId, skillId);
      } catch {}

      // If none exist, seed default 5 milestones (1 unlocked, 2-5 locked)
      if (!Array.isArray(milestones) || milestones.length === 0) {
        const defaultMilestones = [
          { order: 1, title: 'Milestone 1: Axiomatic Core & Foundations', status: 'unlocked' },
          { order: 2, title: 'Milestone 2: Procedural Mechanics & Logic', status: 'locked' },
          { order: 3, title: 'Milestone 3: Edge-Case Handling & Resilience', status: 'locked' },
          { order: 4, title: 'Milestone 4: Systems Integration & Synthesis', status: 'locked' },
          { order: 5, title: 'Milestone 5: Production Capstone & Mastery', status: 'locked' },
        ];

        for (const m of defaultMilestones) {
          try {
            await prisma.$executeRawUnsafe(`
              INSERT INTO user_milestones (user_id, skill_id, milestone_order, title, status, unlocked_at)
              VALUES ($1, $2, $3, $4, $5, ${m.status === 'unlocked' ? 'NOW()' : 'NULL'})
              ON CONFLICT (user_id, skill_id, milestone_order) DO NOTHING;
            `, userId, skillId, m.order, m.title, m.status);
          } catch {}
        }

        try {
          milestones = await prisma.$queryRawUnsafe(`
            SELECT * FROM user_milestones 
            WHERE user_id = $1 AND skill_id = $2
            ORDER BY milestone_order ASC;
          `, userId, skillId);
        } catch {}
      }

      return reply.status(200).send({ milestones: milestones || [] });
    } catch (err: any) {
      fastify.log.error(err, '[GET /api/milestones] Failed');
      return reply.status(500).send({ error: 'Failed to retrieve user milestones' });
    }
  });
};

export default milestoneRoutes;
