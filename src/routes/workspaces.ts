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
      coreKeyTakeaways: safeJsonParse(step.coreKeyTakeaways, []),
      assessableUnits: safeJsonParse(step.assessableUnits, []),
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

    const config = await prisma.adminConfig.findFirst();
    const groqKey = config?.groqKey || process.env.GROQ_API_KEY;
    const tavilyKey = config?.tavilyKey || process.env.TAVILY_API_KEY;

    if (!groqKey) {
      return reply.status(400).send({ error: "Groq API key is not configured in Admin panel." });
    }

    const activeProvider = body.preferredProvider || config?.defaultProvider || 'groq';

    try {
      const step1Title = 'Foundations & Core Principles';
      
      let pedagogicalContent: any;
      try {
        const { runPedagogicalCuratorPipeline } = await import('../lib/ai/pipeline');
        pedagogicalContent = await runPedagogicalCuratorPipeline({
          domain: body.category,
          topic: body.title,
          stepIndex: 1,
          stepTitle: step1Title,
          goal: body.targetGoal,
          groqKey,
          tavilyKey,
        });
      } catch (pipelineErr: any) {
        console.warn('Pipeline fallback triggered:', pipelineErr.message);
        // Fallback if key missing or Groq network error
        pedagogicalContent = {
          whatYouWillLearn: `Master foundational principles and core mechanics of ${body.title}.`,
          coreKeyTakeaways: ['Foundational concepts', 'Operational principles', 'Key mental models'],
          practicalApplication: body.targetGoal,
          assessableUnits: ['Core Concept Identification', 'Fundamental Syntax', 'Operational Mechanics'],
          questionCount: 5,
          resources: [],
        };
      }

      const whatYouWillLearn = pedagogicalContent.whatYouWillLearn || `Master foundational principles and core mechanics of ${body.title}.`;
      const coreKeyTakeaways = pedagogicalContent.coreKeyTakeaways || ['Foundational concepts'];
      const practicalApplication = pedagogicalContent.practicalApplication || body.targetGoal;
      const assessableUnits = pedagogicalContent.assessableUnits || ['Core Principles'];
      const questionCount = Number(pedagogicalContent.questionCount) || 5;
      const resources = pedagogicalContent.resources || [];

      // Save in single Prisma transaction
      const result = await prisma.$transaction(async (tx) => {
        const workspace = await tx.workspace.create({
          data: {
            title: body.title,
            category: body.category,
            baselineKnowledge: body.baselineKnowledge,
            targetGoal: body.targetGoal,
            aiProvider: activeProvider,
            estimatedTotalSteps: 5,
            currentStepIndex: 1,
            recommendedBooks: safeJsonStringify([]),
            status: 'ACTIVE',
          },
        });

        const createdStep = await tx.skillStep.create({
          data: {
            workspaceId: workspace.id,
            stepIndex: 1,
            title: step1Title,
            difficulty: 'Beginner',
            whatYouWillLearn,
            coreKeyTakeaways: safeJsonStringify(coreKeyTakeaways),
            practicalApplication,
            assessableUnits: safeJsonStringify(assessableUnits),
            questionCount,
            resources: safeJsonStringify(resources),
            status: 'IN_PROGRESS',
          },
        });

        return { workspace, createdStep };
      });

      return reply.send({
        ...result.workspace,
        recommendedBooks: [],
        steps: [
          {
            ...result.createdStep,
            coreKeyTakeaways,
            assessableUnits,
            resources,
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
