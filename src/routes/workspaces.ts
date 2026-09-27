// skillprax-backend/src/routes/workspaces.ts

import { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import prisma from "../lib/prisma";
import { curateAndExamine, harvestResources, PipelineExhaustionError, GroqConfigError } from "../lib/ai/pipeline";

const ADMIN_CONFIG_ID = "global";

async function getApiKeys(): Promise<{ groqApiKey: string; tavilyApiKey: string | null }> {
  let config: any = await prisma.adminConfig.findUnique({ where: { id: ADMIN_CONFIG_ID } });
  if (!config) {
    config = await prisma.adminConfig.findFirst();
  }

  const groqApiKey = config?.groqApiKey || config?.groqKey || process.env.GROQ_API_KEY;
  const tavilyApiKey = config?.tavilyApiKey || config?.tavilyKey || process.env.TAVILY_API_KEY || null;

  if (!groqApiKey) {
    throw new GroqConfigError("GROQ_API_KEY is not configured in AdminConfig or environment variables.");
  }

  return { groqApiKey, tavilyApiKey };
}

const initiateWorkspaceSchema = z.object({
  title: z.string().min(2).max(200),
  pillar: z.string().min(2).max(100).optional().default("General Knowledge"),
  domainCategory: z.string().optional(),
  category: z.string().optional(),
  baselineKnowledge: z.string().max(1000).optional().default("Beginner"),
  targetGoal: z.string().max(1000).optional().default("Full Mastery"),
  preferredProvider: z.string().optional().default("groq"),
});

const safeJsonParse = (data: any, fallback: any = []) => {
  if (Array.isArray(data) || (typeof data === "object" && data !== null)) return data;
  if (typeof data === "string") {
    try {
      return JSON.parse(data);
    } catch (_) {
      return fallback;
    }
  }
  return fallback;
};

const formatStep = (step: any) => ({
  ...step,
  whatYouWillLearn: step.whatYouWillLearn || step.conceptualOverview || "",
  conceptualOverview: step.conceptualOverview || step.whatYouWillLearn || "",
  coreKeyTakeaways: safeJsonParse(step.coreKeyTakeaways || step.keyTakeaways, []),
  keyTakeaways: safeJsonParse(step.keyTakeaways || step.coreKeyTakeaways, []),
  assessableUnits: safeJsonParse(step.assessableUnits, []),
  resources: safeJsonParse(step.resources, []),
});

const formatWorkspace = (workspace: any) => ({
  ...workspace,
  skillName: workspace.skillName || workspace.title || "",
  title: workspace.title || workspace.skillName || "",
  pillar: workspace.pillar || workspace.domainCategory || "General Knowledge",
  domainCategory: workspace.domainCategory || workspace.pillar || "General Knowledge",
  steps: Array.isArray(workspace.steps) ? workspace.steps.map(formatStep) : [],
});

function sanitizeInput(text: string): string {
  return text.replace(/[<>{}]/g, "").slice(0, 500);
}

const workspacesRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // 1. POST /api/workspaces/initiate — Create workspace & generate Step 1
  const handleInitiate = async (request: any, reply: any) => {
    try {
      const parsed = initiateWorkspaceSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "Invalid request input", details: parsed.error.flatten() });
      }

      const body = parsed.data;
      const cleanTitle = sanitizeInput(body.title);
      const cleanPillar = sanitizeInput(body.pillar || body.domainCategory || body.category || "General Knowledge");
      const cleanGoal = sanitizeInput(body.targetGoal || "Full Mastery");
      const userId = ((request as any).userId as string) || "default_user";

      let apiKeys;
      try {
        apiKeys = await getApiKeys();
      } catch (err) {
        if (err instanceof GroqConfigError) {
          return reply.status(503).send({ error: `AI configuration error: ${err.message}` });
        }
        throw err;
      }

      // Single Prisma Transaction to create workspace + step 1
      const [workspace, step] = await prisma.$transaction(async (tx) => {
        const ws = await tx.workspace.create({
          data: {
            userId,
            title: cleanTitle,
            skillName: cleanTitle,
            pillar: cleanPillar,
            domainCategory: cleanPillar,
            category: cleanPillar,
            baselineKnowledge: body.baselineKnowledge || "Beginner",
            targetGoal: cleanGoal,
            aiProvider: body.preferredProvider || "groq",
            isGenerating: true,
            generationStartedAt: new Date(),
          } as any,
        });

        const st = await tx.skillStep.create({
          data: {
            workspaceId: ws.id,
            stepIndex: 1,
            title: "Foundations & Core Principles",
            description: `Master core foundational mechanics and achieve: ${cleanGoal}`,
            status: "IN_PROGRESS",
          } as any,
        });

        return [ws, st];
      });

      // Generate Step Content via Pipeline
      try {
        const candidates = await harvestResources(cleanTitle, "Foundations & Core Principles");
        const curriculum = await curateAndExamine(cleanTitle, "Foundations & Core Principles", candidates, apiKeys.groqApiKey);

        const updatedStep = await prisma.skillStep.update({
          where: { id: step.id },
          data: {
            whatYouWillLearn: curriculum.conceptualOverview,
            conceptualOverview: curriculum.conceptualOverview,
            coreKeyTakeaways: curriculum.keyTakeaways as any,
            keyTakeaways: curriculum.keyTakeaways as any,
            questionCount: curriculum.quizBlueprint.questionCount,
            assessableUnits: curriculum.acus.map((a) => a.label) as any,
            resources: curriculum.resources as any,
            practicalApplication: cleanGoal,
          } as any,
        });

        await prisma.workspace.update({
          where: { id: workspace.id },
          data: { isGenerating: false, generationStartedAt: null } as any,
        });

        const formattedWs = formatWorkspace({ ...workspace, steps: [updatedStep], isGenerating: false });
        const formattedStep = formatStep(updatedStep);

        return reply.status(201).send({
          id: workspace.id,
          ...formattedWs,
          workspace: formattedWs,
          step: formattedStep,
        });
      } catch (err) {
        await prisma.workspace.update({
          where: { id: workspace.id },
          data: { isGenerating: false, generationStartedAt: null } as any,
        });

        if (err instanceof PipelineExhaustionError) {
          return reply.status(503).send({ error: "AI pipeline models were busy or unavailable. Please try again." });
        }
        throw err;
      }
    } catch (err: any) {
      if (err?.code === "P2025") {
        return reply.status(404).send({ error: "Record not found." });
      }
      fastify.log.error(err);
      return reply.status(500).send({ error: err.message || "Failed to initiate workspace" });
    }
  };

  fastify.post("/workspaces", handleInitiate);
  fastify.post("/api/workspaces", handleInitiate);
  fastify.post("/api/workspaces/initiate", handleInitiate);

  // 2. GET /api/workspaces — List all user workspaces
  const handleGetAll = async (request: any, reply: any) => {
    try {
      const userId = (request.userId as string) || "default_user";
      const workspaces = await prisma.workspace.findMany({
        where: { userId } as any,
        orderBy: { updatedAt: "desc" },
        include: { steps: { orderBy: { stepIndex: "asc" } } },
      });
      return reply.send(workspaces.map(formatWorkspace));
    } catch (err: any) {
      fastify.log.error(err);
      return reply.status(500).send({ error: err.message || "Failed to fetch workspaces" });
    }
  };

  fastify.get("/workspaces", handleGetAll);
  fastify.get("/api/workspaces", handleGetAll);

  // 3. GET /api/workspaces/:id — Fetch workspace with AUTO-HEALING
  const handleGetById = async (request: any, reply: any) => {
    try {
      const { id } = request.params as { id: string };
      const userId = (request.userId as string) || "default_user";

      if (!id || id === "undefined") {
        return reply.status(400).send({ error: "Invalid workspace ID" });
      }

      let workspace: any = await prisma.workspace.findUnique({
        where: { id },
        include: { steps: { orderBy: { stepIndex: "asc" } } },
      });

      if (!workspace) {
        return reply.status(404).send({ error: "Workspace not found" });
      }

      if (workspace.userId && workspace.userId !== userId && userId !== "default_user") {
        return reply.status(403).send({ error: "Unauthorized access to workspace" });
      }

      // Check if generation is in-flight (started < 30s ago)
      if (workspace.isGenerating && workspace.generationStartedAt) {
        const elapsedMs = Date.now() - new Date(workspace.generationStartedAt).getTime();
        if (elapsedMs < 30000) {
          // Poll briefly (1s) and refetch
          await new Promise((resolve) => setTimeout(resolve, 1000));
          workspace = await prisma.workspace.findUnique({
            where: { id },
            include: { steps: { orderBy: { stepIndex: "asc" } } },
          });
        }
      }

      // AUTO-HEALING: If current step has missing resources/overview, heal synchronously
      const currentStep = workspace.steps?.[workspace.steps.length - 1];
      const needsHealing =
        currentStep &&
        (!currentStep.resources ||
          (Array.isArray(currentStep.resources) && currentStep.resources.length === 0) ||
          !currentStep.conceptualOverview);

      if (needsHealing && !workspace.isGenerating) {
        try {
          await prisma.workspace.update({
            where: { id },
            data: { isGenerating: true, generationStartedAt: new Date() } as any,
          });

          const apiKeys = await getApiKeys();
          const cleanTitle = workspace.title || workspace.skillName;
          const candidates = await harvestResources(cleanTitle, currentStep.title);
          const curriculum = await curateAndExamine(cleanTitle, currentStep.title, candidates, apiKeys.groqApiKey);

          const healedStep = await prisma.skillStep.update({
            where: { id: currentStep.id },
            data: {
              whatYouWillLearn: curriculum.conceptualOverview,
              conceptualOverview: curriculum.conceptualOverview,
              coreKeyTakeaways: curriculum.keyTakeaways as any,
              keyTakeaways: curriculum.keyTakeaways as any,
              questionCount: curriculum.quizBlueprint.questionCount,
              assessableUnits: curriculum.acus.map((a) => a.label) as any,
              resources: curriculum.resources as any,
            } as any,
          });

          await prisma.workspace.update({
            where: { id },
            data: { isGenerating: false, generationStartedAt: null } as any,
          });

          workspace.steps[workspace.steps.length - 1] = healedStep;
        } catch (healErr) {
          await prisma.workspace.update({
            where: { id },
            data: { isGenerating: false, generationStartedAt: null } as any,
          });
          console.warn("[workspaces] Auto-healing step generation skipped due to error:", (healErr as Error).message);
        }
      }

      const formatted = formatWorkspace(workspace);
      return reply.send({
        ...formatted,
        workspace: formatted,
      });
    } catch (err: any) {
      if (err?.code === "P2025") {
        return reply.status(404).send({ error: "Workspace not found" });
      }
      fastify.log.error(err);
      return reply.status(500).send({ error: err.message || "Failed to fetch workspace" });
    }
  };

  fastify.get("/workspaces/:id", handleGetById);
  fastify.get("/api/workspaces/:id", handleGetById);

  // 4. POST /api/workspaces/:id/next-step — Generate next step strictly if current step passed
  const handleNextStep = async (request: any, reply: any) => {
    try {
      const { id: workspaceId } = request.params as { id: string };
      const userId = (request.userId as string) || "default_user";

      const workspace: any = await prisma.workspace.findUnique({
        where: { id: workspaceId },
        include: {
          steps: {
            orderBy: { stepIndex: "asc" },
            include: { attempts: { orderBy: { createdAt: "desc" }, take: 1 } },
          },
        },
      });

      if (!workspace) {
        return reply.status(404).send({ error: "Workspace not found" });
      }

      if (workspace.userId && workspace.userId !== userId && userId !== "default_user") {
        return reply.status(403).send({ error: "Unauthorized access to workspace" });
      }

      const steps = workspace.steps || [];
      const currentStep = steps[steps.length - 1];

      // SERVER-SIDE VERIFICATION: Verify current step has been passed
      if (currentStep) {
        const latestAttempt = currentStep.attempts?.[0];
        const isPassed = currentStep.status === "PASSED" || latestAttempt?.passed === true;

        if (!isPassed) {
          return reply.status(400).send({
            error: "Current step has not been passed yet. You must pass the evaluation quiz (80%+ score) before advancing.",
          });
        }
      }

      const nextStepIndex = (currentStep?.stepIndex ?? 0) + 1;

      // RACE CONDITION GUARD: If next step already exists, return it idempotently
      const existingNextStep = steps.find((s: any) => s.stepIndex === nextStepIndex);
      if (existingNextStep) {
        return reply.send({
          step: formatStep(existingNextStep),
          workspace: formatWorkspace(workspace),
        });
      }

      const cleanTitle = workspace.title || workspace.skillName;
      const nextStepTitle = `Step ${nextStepIndex}: Advanced Application & Mastery`;

      let apiKeys;
      try {
        apiKeys = await getApiKeys();
      } catch (err) {
        if (err instanceof GroqConfigError) {
          return reply.status(503).send({ error: `AI configuration error: ${err.message}` });
        }
        throw err;
      }

      const candidates = await harvestResources(cleanTitle, nextStepTitle);
      const curriculum = await curateAndExamine(cleanTitle, nextStepTitle, candidates, apiKeys.groqApiKey);

      const isMastered = nextStepIndex >= (workspace.estimatedTotalSteps || 5);

      const [newStep] = await prisma.$transaction([
        prisma.skillStep.create({
          data: {
            workspaceId,
            stepIndex: nextStepIndex,
            title: nextStepTitle,
            description: `Deepen practical implementation and architectural mastery for ${cleanTitle}.`,
            whatYouWillLearn: curriculum.conceptualOverview,
            conceptualOverview: curriculum.conceptualOverview,
            coreKeyTakeaways: curriculum.keyTakeaways as any,
            keyTakeaways: curriculum.keyTakeaways as any,
            practicalApplication: workspace.targetGoal || "Full Mastery",
            questionCount: curriculum.quizBlueprint.questionCount,
            assessableUnits: curriculum.acus.map((a) => a.label) as any,
            resources: curriculum.resources as any,
            status: "IN_PROGRESS",
          } as any,
        }),
        prisma.workspace.update({
          where: { id: workspaceId },
          data: {
            currentStepIndex: nextStepIndex,
            status: isMastered ? "MASTERED" : workspace.status,
          } as any,
        }),
      ]);

      const updatedWorkspace = await prisma.workspace.findUnique({
        where: { id: workspaceId },
        include: { steps: { orderBy: { stepIndex: "asc" } } },
      });

      return reply.status(201).send({
        step: formatStep(newStep),
        workspace: formatWorkspace(updatedWorkspace),
      });
    } catch (err: any) {
      if (err?.code === "P2025") {
        return reply.status(404).send({ error: "Record not found." });
      }
      fastify.log.error(err);
      return reply.status(500).send({ error: err.message || "Failed to generate next step" });
    }
  };

  fastify.post("/workspaces/:id/next-step", handleNextStep);
  fastify.post("/api/workspaces/:id/next-step", handleNextStep);
  fastify.post("/api/workspaces/:workspaceId/generate-next-step", handleNextStep);
};

export default workspacesRoutes;
