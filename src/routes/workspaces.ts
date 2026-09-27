import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import prisma from '../lib/prisma';
import {
  generateInitiationData,
  safeJsonParse,
  safeJsonStringify,
  getProviderKey,
} from '../lib/ai/orchestrator';

export async function workspaceRoutes(fastify: FastifyInstance) {
  // GET /api/workspaces
  fastify.get('/api/workspaces', async (_request: FastifyRequest, reply: FastifyReply) => {
    const workspaces = await prisma.workspace.findMany({
      orderBy: { updatedAt: 'desc' },
      include: {
        steps: {
          select: {
            id: true,
            stepIndex: true,
            status: true,
          },
        },
      },
    });

    const formatted = workspaces.map((w) => {
      const totalSteps = w.estimatedTotalSteps || w.steps.length || 1;
      const passedSteps = w.steps.filter((s) => s.status === 'PASSED').length;
      const completionPercentage = Math.round((passedSteps / totalSteps) * 100);

      return {
        ...w,
        recommendedBooks: safeJsonParse(w.recommendedBooks, []),
        passedStepsCount: passedSteps,
        completionPercentage: Math.min(100, completionPercentage),
      };
    });

    return reply.send(formatted);
  });

  // GET /api/workspaces/:id
  fastify.get('/api/workspaces/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    const workspace = await prisma.workspace.findUnique({
      where: { id },
      include: {
        steps: {
          orderBy: { stepIndex: 'asc' },
          include: {
            attempts: {
              orderBy: { createdAt: 'desc' },
            },
          },
        },
      },
    });

    if (!workspace) {
      return reply.status(404).send({ error: 'Workspace not found' });
    }

    const totalSteps = workspace.estimatedTotalSteps || workspace.steps.length || 1;
    const passedSteps = workspace.steps.filter((s) => s.status === 'PASSED').length;
    const completionPercentage = Math.round((passedSteps / totalSteps) * 100);

    const formattedSteps = workspace.steps.map((step) => ({
      ...step,
      resources: safeJsonParse(step.resources, []),
      attempts: step.attempts.map((attempt) => ({
        ...attempt,
        userAnswers: safeJsonParse(attempt.userAnswers, []),
        weakConcepts: safeJsonParse(attempt.weakConcepts, []),
        remedialResources: safeJsonParse(attempt.remedialResources, []),
      })),
    }));

    return reply.send({
      ...workspace,
      recommendedBooks: safeJsonParse(workspace.recommendedBooks, []),
      steps: formattedSteps,
      passedStepsCount: passedSteps,
      completionPercentage: Math.min(100, completionPercentage),
    });
  });

  // POST /api/workspaces/initiate
  fastify.post('/api/workspaces/initiate', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as {
      title: string;
      category: string;
      baselineKnowledge: string;
      targetGoal: string;
      preferredProvider?: string;
    };

    if (!body?.title || !body?.category || !body?.baselineKnowledge || !body?.targetGoal) {
      return reply.status(400).send({
        error: 'Missing required fields: title, category, baselineKnowledge, and targetGoal are mandatory.',
      });
    }

    const keyInfo = await getProviderKey(body.preferredProvider || 'groq');
    const activeProvider = body.preferredProvider || keyInfo.defaultProvider || 'groq';

    try {
      // 1. Generate Step 1 and Recommended Books via LLM
      const initData = await generateInitiationData(
        body.title,
        body.category,
        body.baselineKnowledge,
        body.targetGoal,
        activeProvider
      );

      const estimatedTotalSteps = Number(initData.estimatedTotalSteps) || 5;
      const recommendedBooks = initData.recommendedBooks || [];
      const step1 = initData.step1 || {
        title: 'Foundations & Core Principles',
        difficulty: 'Beginner',
        objective: 'Master foundational terms and introductory concepts.',
        passingScore: 80,
        questionCount: 4,
        resources: [],
      };

      // 2. Save in single Prisma transaction
      const result = await prisma.$transaction(async (tx) => {
        const workspace = await tx.workspace.create({
          data: {
            title: body.title,
            category: body.category,
            baselineKnowledge: body.baselineKnowledge,
            targetGoal: body.targetGoal,
            aiProvider: activeProvider,
            estimatedTotalSteps,
            currentStepIndex: 1,
            recommendedBooks: safeJsonStringify(recommendedBooks),
            status: 'ACTIVE',
          },
        });

        const createdStep = await tx.skillStep.create({
          data: {
            workspaceId: workspace.id,
            stepIndex: 1,
            title: step1.title,
            difficulty: step1.difficulty || 'Beginner',
            objective: step1.objective,
            passingScore: Number(step1.passingScore) || 80,
            questionCount: Number(step1.questionCount) || 4,
            resources: safeJsonStringify(step1.resources || []),
            status: 'IN_PROGRESS',
          },
        });

        return { workspace, createdStep };
      });

      return reply.send({
        ...result.workspace,
        recommendedBooks,
        steps: [
          {
            ...result.createdStep,
            resources: step1.resources || [],
            attempts: [],
          },
        ],
        completionPercentage: 0,
      });
    } catch (err: any) {
      return reply.status(500).send({
        error: `Failed to initiate workspace: ${err.message || err}`,
      });
    }
  });
}

export default workspaceRoutes;
