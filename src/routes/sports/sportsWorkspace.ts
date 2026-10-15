import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import prisma from '../../lib/prisma';
import {
  enqueueSportsJob,
  runSportsPackBuild,
  getSportsStepPack,
  sportsBuildProgress,
} from '../../services/sports/sportsPackBuilder';
import {
  generateLevelUpQuiz,
  submitQuizAnswers,
} from '../../services/learning/quiz';
import { generateMasteryTrajectory } from '../../services/learning/trajectory';

export const sportsWorkspaceRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // POST /api/sports-workspace/enroll — Sub-second skeleton-only sports enrollment (<1.5s)
  fastify.post('/api/sports-workspace/enroll', async (req, reply) => {
    try {
      const body: any = req.body || {};
      const cleanTitle = String(body.title ?? body.skill ?? body.topic ?? '').trim();
      const cleanSub = String(body.subGenre || 'Athletic Mastery').trim();
      const desiredLevel = body.desiredMastery || body.targetGoal || body.desiredLevel || 'Intermediate';
      const experienceLevel = body.experienceLevel || body.currentExperience || 'Some Foundational Knowledge';
      const profileId = body.profileId || body.userProfileId || 'default-profile';
      const dailyMinutes = Math.max(15, Math.min(960, Number(body.dailyMinutes) || 60));

      const result = await generateMasteryTrajectory({
        section: 'SPORTS',
        domain: 'Athletics',
        skill: cleanTitle || 'Athletic Discipline',
        subGenre: cleanSub,
        desiredLevel,
        currentExperience: experienceLevel,
        dailyMinutes,
        profileId,
      });

      return reply.status(201).send({
        id: result.workspaceId,
        workspace: result.workspace,
        stepCount: result.stepCount,
        stepCountReason: result.stepCountReason,
        steps: result.steps,
      });
    } catch (err: any) {
      fastify.log.error(err, '[SportsEnrollment] Failed');
      return reply.status(500).send({ error: err.message || 'Failed to enroll sports trajectory' });
    }
  });

  // GET /api/sports-workspace/:workspaceId — Get full sports workspace data
  fastify.get('/api/sports-workspace/:workspaceId', async (req, reply) => {
    const { workspaceId } = req.params as { workspaceId: string };

    try {
      const ws = await prisma.workspace.findUnique({
        where: { id: workspaceId },
        include: {
          steps: {
            orderBy: { stepIndex: 'asc' },
            include: {
              stepChapters: {
                orderBy: { order: 'asc' },
                include: { topics: { orderBy: { order: 'asc' } } },
              },
            },
          },
          userProfile: true,
        },
      });

      if (!ws) {
        return reply.status(404).send({ error: 'Sports workspace not found' });
      }

      return reply.send({ workspace: ws });
    } catch (err: any) {
      fastify.log.error(err, '[GetSportsWorkspace] Failed');
      return reply.status(500).send({ error: err.message || 'Failed to fetch sports workspace' });
    }
  });

  // Common pack builder handler
  const handleSportsPackBuild = async (req: any, reply: any) => {
    const { stepId } = req.params as { stepId: string };
    const body = (req.body || {}) as { prefetch?: boolean };

    try {
      let step = await prisma.skillStep.findUnique({
        where: { id: stepId },
      });

      if (!step) {
        // Fallback: check if stepId is actually a workspaceId
        const ws = await prisma.workspace.findUnique({
          where: { id: stepId },
          include: { steps: { orderBy: { stepIndex: 'asc' } } },
        });
        if (ws && ws.steps.length > 0) {
          const activeS = ws.steps.find((s) => s.status !== 'PASSED') || ws.steps[0];
          step = activeS;
        }
      }

      if (!step) {
        return reply.status(404).send({ error: 'Step not found' });
      }

      if (step.packStatus === 'READY') {
        return reply.status(200).send({
          message: 'Sports pack already built',
          stepId: step.id,
          packStatus: 'READY',
          packStage: 'READY',
        });
      }

      if (step.packStatus === 'BUILDING') {
        return reply.status(202).send({
          message: 'Sports pack build already in progress',
          stepId: step.id,
          packStatus: 'BUILDING',
          packStage: step.packStage,
        });
      }

      // Mark step as BUILDING
      await prisma.skillStep.update({
        where: { id: step.id },
        data: {
          packStatus: 'BUILDING',
          packStage: 'RESEARCHING',
          packStartedAt: new Date(),
          packError: null,
        },
      });

      // Enqueue background build
      const targetStepId = step.id;
      enqueueSportsJob(() => runSportsPackBuild(targetStepId)).catch((err) => {
        fastify.log.error({ err, stepId: targetStepId }, '[SportsPackQueue] Background job failed');
      });

      return reply.status(202).send({
        queued: true,
        stepId: targetStepId,
        packStatus: 'BUILDING',
        packStage: 'RESEARCHING',
      });
    } catch (err: any) {
      fastify.log.error(err, '[BuildSportsPack] Failed');
      return reply.status(500).send({ error: err.message || 'Failed to start sports pack build' });
    }
  };

  // POST /api/sports-workspace/steps/:stepId/build-pack & /prefetch-pack — Trigger pack generation
  fastify.post('/api/sports-workspace/steps/:stepId/build-pack', handleSportsPackBuild);
  fastify.post('/api/sports-workspace/steps/:stepId/prefetch-pack', handleSportsPackBuild);

  // POST /api/sports-workspace/steps/:stepId/engaged — Silent background prefetch of Step N quiz + Step N+1 pack & quiz
  fastify.post('/api/sports-workspace/steps/:stepId/engaged', async (req, reply) => {
    const { stepId } = req.params as { stepId: string };
    try {
      let step = await prisma.skillStep.findUnique({
        where: { id: stepId },
        include: {
          workspace: {
            include: {
              steps: { orderBy: { stepIndex: 'asc' } },
            },
          },
        },
      });

      if (!step) {
        const ws = await prisma.workspace.findUnique({
          where: { id: stepId },
          include: { steps: { orderBy: { stepIndex: 'asc' } } },
        });
        if (ws && ws.steps.length > 0) {
          const activeS = ws.steps.find((s) => s.status !== 'PASSED') || ws.steps[0];
          step = { ...activeS, workspace: ws } as any;
        }
      }

      if (!step) return reply.status(404).send({ error: 'Sports step not found' });

      await prisma.skillStep.update({
        where: { id: step.id },
        data: { engagedAt: new Date() },
      });

      // 1) Enqueue quiz for current sports step N if not generated
      if (step.quizStatus === 'NOT_BUILT' || step.quizStatus === 'FAILED') {
        const targetId = step.id;
        enqueueSportsJob(async () => {
          try {
            await generateLevelUpQuiz(targetId);
            console.log(`[SportsEngaged] Step ${targetId} quiz prefetched silently.`);
          } catch (qErr) {
            console.warn('[SportsEngaged] Quiz prefetch notice:', qErr);
          }
        }).catch(() => {});
      }

      // 2) Lookahead next sports step N+1: build pack, then quiz for N+1
      const nextStep = step.workspace?.steps?.find((s) => s.stepIndex === step.stepIndex + 1);
      if (nextStep && (nextStep.packStatus === 'NOT_BUILT' || nextStep.packStatus === 'FAILED')) {
        const nextId = nextStep.id;
        enqueueSportsJob(async () => {
          try {
            console.log(`[SportsEngaged] Next Step ${nextId} (Step ${nextStep.stepIndex}) pack prefetch starting silently...`);
            await runSportsPackBuild(nextId);
            await generateLevelUpQuiz(nextId);
            console.log(`[SportsEngaged] Next Step ${nextId} pack and quiz prefetched silently.`);
          } catch (pErr) {
            console.warn('[SportsEngaged] Next step prefetch notice:', pErr);
          }
        }).catch(() => {});
      }

      return reply.send({ success: true, message: 'Sports engagement registered; silent background prefetch enqueued' });
    } catch (err: any) {
      fastify.log.error(err, '[SportsStepEngaged] Failed');
      return reply.status(500).send({ error: err.message || 'Failed to register sports engagement' });
    }
  });

  // GET /api/sports-workspace/steps/:stepId/pack-status — Poll status
  fastify.get('/api/sports-workspace/steps/:stepId/pack-status', async (req, reply) => {
    const { stepId } = req.params as { stepId: string };

    try {
      let step = await prisma.skillStep.findUnique({
        where: { id: stepId },
        select: {
          id: true,
          stepIndex: true,
          packStatus: true,
          packStage: true,
          packError: true,
          packStartedAt: true,
        },
      });

      if (!step) {
        const ws = await prisma.workspace.findUnique({
          where: { id: stepId },
          include: { steps: { orderBy: { stepIndex: 'asc' } } },
        });
        if (ws && ws.steps.length > 0) {
          const activeS = ws.steps.find((s) => s.status !== 'PASSED') || ws.steps[0];
          step = activeS as any;
        }
      }

      if (!step) {
        return reply.status(404).send({ error: 'Step not found' });
      }

      return reply.send({
        stepId: step.id,
        stepIndex: step.stepIndex,
        packStatus: step.packStatus || 'NOT_BUILT',
        packStage: step.packStage || null,
        packError: step.packError || null,
        buildProgress: sportsBuildProgress.get(step.id) || null,
      });
    } catch (err: any) {
      fastify.log.error(err, '[GetSportsPackStatus] Failed');
      return reply.status(500).send({ error: err.message || 'Failed to get pack status' });
    }
  });

  // GET /api/sports-workspace/steps/:stepId/pack — Get full ready sports pack
  fastify.get('/api/sports-workspace/steps/:stepId/pack', async (req, reply) => {
    const { stepId } = req.params as { stepId: string };

    try {
      const pack = await getSportsStepPack(stepId);
      return reply.send(pack);
    } catch (err: any) {
      fastify.log.error(err, '[GetSportsPack] Failed');
      return reply.status(err.message === 'Sports step not found' ? 404 : 500).send({
        error: err.message || 'Failed to get sports pack',
      });
    }
  });

  // POST /api/sports-workspace/steps/:stepId/complete-day — Mark a training day completed
  fastify.post('/api/sports-workspace/steps/:stepId/complete-day', async (req, reply) => {
    const { stepId } = req.params as { stepId: string };
    const body = (req.body || {}) as { dayNumber: number; profileId?: string };

    try {
      const step = await prisma.skillStep.findUnique({
        where: { id: stepId },
      });

      if (!step) {
        return reply.status(404).send({ error: 'Step not found' });
      }

      // We can record completion in step's intro or activity logs
      return reply.send({
        success: true,
        stepId: step.id,
        dayCompleted: body.dayNumber || 1,
      });
    } catch (err: any) {
      fastify.log.error(err, '[CompleteSportsDay] Failed');
      return reply.status(500).send({ error: err.message || 'Failed to log day completion' });
    }
  });

  // GET /api/sports-workspace/steps/:stepId/quiz & level-up-quiz
  const handleSportsGetQuiz = async (req: any, reply: any) => {
    const { stepId } = req.params as { stepId: string };
    const queryMode = req.query?.mode as 'initial' | 'retest' | 'perfection' | undefined;
    try {
      let step = await prisma.skillStep.findUnique({ where: { id: stepId }, select: { id: true, status: true } });
      if (!step) {
        const ws = await prisma.workspace.findUnique({
          where: { id: stepId },
          include: { steps: { orderBy: { stepIndex: 'asc' } } },
        });
        if (ws && ws.steps.length > 0) {
          const activeS = ws.steps.find((s) => s.status !== 'PASSED') || ws.steps[0];
          step = activeS;
        }
      }
      if (!step) return reply.status(404).send({ error: 'Step not found' });
      const quiz = await generateLevelUpQuiz(step.id, { mode: queryMode || 'initial' });
      return reply.send(quiz);
    } catch (err: any) {
      fastify.log.error(err, '[SportsGetQuiz] Failed');
      return reply.status(err.statusCode || 500).send({
        error: err.message || 'Failed to retrieve sports quiz',
      });
    }
  };

  fastify.get('/api/sports-workspace/steps/:stepId/quiz', handleSportsGetQuiz);
  fastify.get('/api/sports-workspace/steps/:stepId/level-up-quiz', handleSportsGetQuiz);

  // POST /api/sports-workspace/steps/:stepId/quiz & level-up-quiz
  const handleSportsPostQuiz = async (req: any, reply: any) => {
    const { stepId } = req.params as { stepId: string };
    const queryMode = req.query?.mode;
    const body = (req.body || {}) as {
      mode?: 'initial' | 'retest' | 'perfection';
      retestMode?: boolean;
      perfectionMode?: boolean;
      failedQuestionIds?: string[];
    };
    const effectiveMode = body.mode || queryMode || (body.retestMode ? 'retest' : body.perfectionMode ? 'perfection' : 'initial');

    try {
      let step = await prisma.skillStep.findUnique({ where: { id: stepId }, select: { id: true, status: true } });
      if (!step) {
        const ws = await prisma.workspace.findUnique({
          where: { id: stepId },
          include: { steps: { orderBy: { stepIndex: 'asc' } } },
        });
        if (ws && ws.steps.length > 0) {
          const activeS = ws.steps.find((s) => s.status !== 'PASSED') || ws.steps[0];
          step = activeS;
        }
      }
      if (!step) return reply.status(404).send({ error: 'Step not found' });
      const quiz = await generateLevelUpQuiz(step.id, {
        mode: effectiveMode,
        retestMode: body.retestMode || effectiveMode === 'retest',
        perfectionMode: body.perfectionMode || effectiveMode === 'perfection',
        failedQuestionIds: body.failedQuestionIds,
      });
      return reply.send(quiz);
    } catch (err: any) {
      fastify.log.error(err, '[SportsGenerateQuiz] Failed');
      return reply.status(err.statusCode || 500).send({
        error: err.message || 'Failed to generate sports quiz',
      });
    }
  };

  fastify.post('/api/sports-workspace/steps/:stepId/quiz', handleSportsPostQuiz);
  fastify.post('/api/sports-workspace/steps/:stepId/level-up-quiz', handleSportsPostQuiz);

  // POST /api/sports-workspace/steps/:stepId/submit-quiz
  fastify.post('/api/sports-workspace/steps/:stepId/submit-quiz', async (req, reply) => {
    const { stepId } = req.params as { stepId: string };
    const { attemptId, answers, questionIds, mode } = (req.body || {}) as {
      attemptId?: string;
      answers: Record<string, string> | Array<{ questionId: string; selectedOptionId: string }>;
      questionIds?: string[];
      mode?: string;
    };

    try {
      let normalizedAnswers: Record<string, string> = {};
      if (Array.isArray(answers)) {
        answers.forEach((a) => {
          if (a?.questionId) normalizedAnswers[a.questionId] = String(a.selectedOptionId);
        });
      } else if (typeof answers === 'object' && answers !== null) {
        normalizedAnswers = answers;
      }

      const graded = await submitQuizAnswers(stepId, {
        attemptId,
        answers: normalizedAnswers,
        questionIds: Array.isArray(questionIds) ? questionIds.map(String) : undefined,
        mode: typeof mode === 'string' ? mode : undefined,
      });

      return reply.send(graded);
    } catch (err: any) {
      fastify.log.error(err, '[SportsSubmitQuiz] Failed');
      return reply.status(500).send({
        error: err.message || 'Failed to evaluate sports quiz submission',
      });
    }
  });
};
