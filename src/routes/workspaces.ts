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
  title: z.string().optional(),
  topic: z.string().optional(),
  domainCategory: z.string().optional(),
  pillar: z.string().optional(),
  category: z.string().optional(),
  baselineKnowledge: z.string().max(1000).optional().default("Beginner"),
  targetGoal: z.string().max(1000).optional().default("Full Mastery"),
  level: z.string().optional().default("Beginner"),
  preferredProvider: z.string().optional().default("groq"),
});

const deleteWorkspaceSchema = z.object({
  reason: z.enum(["curve_too_steep", "curriculum_mismatch", "pivoting_goals", "other"]),
  reasonDetail: z.string().max(1000).optional(),
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

function stripQuizAnswers(questions: any[]): any[] {
  if (!Array.isArray(questions)) return [];
  return questions.map((q: any) => ({
    id: q.id,
    acuId: q.acuId || "acu-1",
    scenario: q.scenario || "",
    question: q.question || "",
    options: Array.isArray(q.options)
      ? q.options.map((opt: any) => (typeof opt === "string" ? opt : { id: opt.id || opt.key || "A", text: opt.text }))
      : [],
  }));
}

const formatStepClientSafe = (step: any) => {
  const rawBlueprint = safeJsonParse(step.quizBlueprint, []);
  const studentSafeQuestions = stripQuizAnswers(rawBlueprint);

  return {
    ...step,
    whatYouWillLearn: step.whatYouWillLearn || step.conceptualOverview || "",
    conceptualOverview: step.conceptualOverview || step.whatYouWillLearn || "",
    coreKeyTakeaways: safeJsonParse(step.coreKeyTakeaways || step.keyTakeaways, []),
    keyTakeaways: safeJsonParse(step.keyTakeaways || step.coreKeyTakeaways, []),
    assessableUnits: safeJsonParse(step.assessableUnits, []),
    resources: safeJsonParse(step.resources, []),
    quizBlueprint: studentSafeQuestions,
    questionCount: studentSafeQuestions.length || step.questionCount || 5,
  };
};

const formatWorkspaceClientSafe = (workspace: any) => ({
  ...workspace,
  skillName: workspace.skillName || workspace.title || "",
  title: workspace.title || workspace.skillName || "",
  pillar: workspace.pillar || workspace.domainCategory || "General Knowledge",
  domainCategory: workspace.domainCategory || workspace.pillar || "General Knowledge",
  steps: Array.isArray(workspace.steps) ? workspace.steps.map(formatStepClientSafe) : [],
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
      const cleanTitle = (body.title || body.topic || "").trim().slice(0, 140);
      if (!cleanTitle) {
        return reply.status(400).send({ error: "Title or topic parameter is required." });
      }

      const cleanPillar = sanitizeInput(body.pillar || body.domainCategory || body.category || "General Knowledge");
      const cleanGoal = sanitizeInput(body.targetGoal || "Full Mastery");

      let apiKeys;
      try {
        apiKeys = await getApiKeys();
      } catch (err) {
        if (err instanceof GroqConfigError) {
          return reply.status(503).send({ error: `AI configuration error: ${err.message}` });
        }
        throw err;
      }

      // Create workspace + step 1 in a single transaction
      const [workspace, step] = await prisma.$transaction(async (tx) => {
        const ws = await tx.workspace.create({
          data: {
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

      // Two-phase pipeline synthesis for Step 1
      try {
        const candidates = await harvestResources(cleanTitle, "Foundations & Core Principles", apiKeys.tavilyApiKey);
        const curriculum = await curateAndExamine(cleanTitle, "Foundations & Core Principles", candidates, apiKeys.groqApiKey);

        const updatedStep = await prisma.skillStep.update({
          where: { id: step.id },
          data: {
            whatYouWillLearn: curriculum.conceptualOverview || `Master foundational mechanics for ${cleanTitle}`,
            conceptualOverview: curriculum.conceptualOverview || `Master foundational mechanics for ${cleanTitle}`,
            coreKeyTakeaways: curriculum.acus.map((a) => a.label) as any,
            keyTakeaways: curriculum.acus.map((a) => a.label) as any,
            questionCount: curriculum.quizBlueprint.questions.length || curriculum.questions.length || 5,
            assessableUnits: curriculum.acus as any,
            quizBlueprint: curriculum.quizBlueprint.questions as any,
            resources: curriculum.resources as any,
            practicalApplication: cleanGoal,
          } as any,
        });

        const formattedWs = formatWorkspaceClientSafe({ ...workspace, steps: [updatedStep], isGenerating: false });
        const formattedStep = formatStepClientSafe(updatedStep);

        return reply.status(201).send({
          id: workspace.id,
          ...formattedWs,
          workspace: formattedWs,
          step: formattedStep,
        });
      } finally {
        await prisma.workspace.update({
          where: { id: workspace.id },
          data: { isGenerating: false, generationStartedAt: null } as any,
        });
      }
    } catch (err: any) {
      if (err instanceof PipelineExhaustionError) {
        return reply.status(503).send({ error: "AI pipeline models were busy or unavailable. Please try again." });
      }
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

  // 2. GET /api/workspaces — List all workspaces
  const handleGetAll = async (request: any, reply: any) => {
    try {
      const workspaces = await prisma.workspace.findMany({
        orderBy: { updatedAt: "desc" },
        include: { steps: { orderBy: { stepIndex: "asc" } } },
      });
      return reply.send(workspaces.map(formatWorkspaceClientSafe));
    } catch (err: any) {
      fastify.log.error(err);
      return reply.send([]);
    }
  };

  fastify.get("/workspaces", handleGetAll);
  fastify.get("/api/workspaces", handleGetAll);

  // 3. GET /api/workspaces/:id — Fetch workspace with AUTO-HEALING & POLLING
  const handleGetById = async (request: any, reply: any) => {
    try {
      const { id } = request.params as { id: string };

      if (!id || id === "undefined" || id === "null" || id.trim().length === 0) {
        return reply.status(400).send({ error: "Invalid workspace ID parameter." });
      }

      const cleanId = id.trim();
      let workspace: any = await prisma.workspace.findUnique({
        where: { id: cleanId },
        include: { steps: { orderBy: { stepIndex: "asc" } } },
      });

      if (!workspace) {
        return reply.status(404).send({ error: `Workspace with ID "${cleanId}" not found.` });
      }

      // Check if generation is in-flight (< 30s ago). If so, poll up to ~10 times (15s total)
      if (workspace.isGenerating && workspace.generationStartedAt) {
        const elapsedMs = Date.now() - new Date(workspace.generationStartedAt).getTime();
        if (elapsedMs < 30000) {
          let pollAttempts = 0;
          while (pollAttempts < 10) {
            pollAttempts++;
            await new Promise((resolve) => setTimeout(resolve, 1500));
            const reRead: any = await prisma.workspace.findUnique({
              where: { id: cleanId },
              include: { steps: { orderBy: { stepIndex: "asc" } } },
            });
            if (reRead) {
              workspace = reRead;
              if (!workspace.isGenerating) break;
            }
          }
        }
      }

      const currentStep = workspace.steps?.[workspace.steps.length - 1];
      const parsedResources = currentStep ? safeJsonParse(currentStep.resources, []) : [];
      const parsedAcus = currentStep ? safeJsonParse(currentStep.assessableUnits, []) : [];

      const needsHealing = currentStep && (parsedResources.length === 0 || parsedAcus.length === 0);

      const isStaleLock = workspace.generationStartedAt
        ? Date.now() - new Date(workspace.generationStartedAt).getTime() >= 30000
        : true;

      // Auto-healing triggered if unpopulated and not actively generating
      if (needsHealing && (!workspace.isGenerating || isStaleLock)) {
        try {
          await prisma.workspace.update({
            where: { id: cleanId },
            data: { isGenerating: true, generationStartedAt: new Date() } as any,
          });

          const apiKeys = await getApiKeys();
          const cleanTitle = workspace.title || workspace.skillName;
          const candidates = await harvestResources(cleanTitle, currentStep.title, apiKeys.tavilyApiKey);
          const curriculum = await curateAndExamine(cleanTitle, currentStep.title, candidates, apiKeys.groqApiKey);

          const healedStep = await prisma.skillStep.update({
            where: { id: currentStep.id },
            data: {
              whatYouWillLearn: curriculum.conceptualOverview || `Master ${currentStep.title}`,
              conceptualOverview: curriculum.conceptualOverview || `Master ${currentStep.title}`,
              coreKeyTakeaways: curriculum.acus.map((a) => a.label) as any,
              keyTakeaways: curriculum.acus.map((a) => a.label) as any,
              questionCount: curriculum.quizBlueprint.questions.length || curriculum.questions.length || 5,
              assessableUnits: curriculum.acus as any,
              quizBlueprint: curriculum.quizBlueprint.questions as any,
              resources: curriculum.resources as any,
            } as any,
          });

          workspace.steps[workspace.steps.length - 1] = healedStep;
        } catch (healErr) {
          console.warn("[workspaces] Auto-healing step generation error:", (healErr as Error).message);
        } finally {
          await prisma.workspace.update({
            where: { id: cleanId },
            data: { isGenerating: false, generationStartedAt: null } as any,
          });
        }
      }

      const formatted = formatWorkspaceClientSafe(workspace);
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
      const cleanWorkspaceId = (workspaceId || "").trim();

      const workspace: any = await prisma.workspace.findUnique({
        where: { id: cleanWorkspaceId },
        include: {
          steps: {
            orderBy: { stepIndex: "asc" },
            include: { attempts: { orderBy: { createdAt: "desc" }, take: 1 } },
          },
        },
      });

      if (!workspace) {
        return reply.status(404).send({ error: `Workspace with ID "${cleanWorkspaceId}" not found.` });
      }

      const steps = workspace.steps || [];
      const currentStep = steps[steps.length - 1];

      // SERVER-SIDE VERIFICATION: Current step must be passed
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

      // IDEMPOTENCY GUARD: If next step already exists beyond current one, return it
      const existingNextStep = steps.find((s: any) => s.stepIndex === nextStepIndex);
      if (existingNextStep) {
        return reply.send({
          step: formatStepClientSafe(existingNextStep),
          workspace: formatWorkspaceClientSafe(workspace),
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

      // Create new step row
      const isMastered = nextStepIndex >= (workspace.estimatedTotalSteps || 5);
      const [newStep] = await prisma.$transaction([
        prisma.skillStep.create({
          data: {
            workspaceId: cleanWorkspaceId,
            stepIndex: nextStepIndex,
            title: nextStepTitle,
            description: `Deepen practical implementation and architectural mastery for ${cleanTitle}.`,
            status: "IN_PROGRESS",
          } as any,
        }),
        prisma.workspace.update({
          where: { id: cleanWorkspaceId },
          data: {
            currentStepIndex: nextStepIndex,
            status: isMastered ? "MASTERED" : workspace.status,
            isGenerating: true,
            generationStartedAt: new Date(),
          } as any,
        }),
      ]);

      // Synthesize two-phase pipeline content for next step
      try {
        const candidates = await harvestResources(cleanTitle, nextStepTitle, apiKeys.tavilyApiKey);
        const curriculum = await curateAndExamine(cleanTitle, nextStepTitle, candidates, apiKeys.groqApiKey);

        const updatedStep = await prisma.skillStep.update({
          where: { id: newStep.id },
          data: {
            whatYouWillLearn: curriculum.conceptualOverview || `Master ${nextStepTitle}`,
            conceptualOverview: curriculum.conceptualOverview || `Master ${nextStepTitle}`,
            coreKeyTakeaways: curriculum.acus.map((a) => a.label) as any,
            keyTakeaways: curriculum.acus.map((a) => a.label) as any,
            practicalApplication: workspace.targetGoal || "Full Mastery",
            questionCount: curriculum.quizBlueprint.questions.length || curriculum.questions.length || 5,
            assessableUnits: curriculum.acus as any,
            quizBlueprint: curriculum.quizBlueprint.questions as any,
            resources: curriculum.resources as any,
          } as any,
        });

        const updatedWorkspace = await prisma.workspace.findUnique({
          where: { id: cleanWorkspaceId },
          include: { steps: { orderBy: { stepIndex: "asc" } } },
        });

        return reply.status(201).send({
          step: formatStepClientSafe(updatedStep),
          workspace: formatWorkspaceClientSafe(updatedWorkspace),
        });
      } finally {
        await prisma.workspace.update({
          where: { id: cleanWorkspaceId },
          data: { isGenerating: false, generationStartedAt: null } as any,
        });
      }
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

  // 5. DELETE /api/workspaces/:id — Delete workspace & record AbandonmentLog telemetry
  const handleDelete = async (request: any, reply: any) => {
    try {
      const { id: workspaceId } = request.params as { id: string };
      const cleanWorkspaceId = (workspaceId || "").trim();

      const parsed = deleteWorkspaceSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "Invalid abandonment payload", details: parsed.error.flatten() });
      }

      const { reason, reasonDetail } = parsed.data;

      const workspace: any = await prisma.workspace.findUnique({
        where: { id: cleanWorkspaceId },
        include: { steps: true },
      });

      if (!workspace) {
        return reply.status(404).send({ error: `Workspace with ID "${cleanWorkspaceId}" not found.` });
      }

      const completedStepsCount = (workspace.steps || []).filter((s: any) => s.status === "PASSED").length;
      const createdAtTime = workspace.createdAt ? new Date(workspace.createdAt).getTime() : Date.now();
      const timeInvestedSeconds = Math.max(0, Math.floor((Date.now() - createdAtTime) / 1000));

      // Single transaction: (1) create AbandonmentLog, (2) delete steps/attempts, (3) delete workspace
      await prisma.$transaction([
        prisma.abandonmentLog.create({
          data: {
            workspaceId: cleanWorkspaceId,
            trackTitle: workspace.title || workspace.skillName || "Skill Track",
            domain: workspace.pillar || workspace.domainCategory || "General Knowledge",
            completedStepsCount,
            timeInvestedSeconds,
            reason,
            reasonDetail: reasonDetail ? sanitizeInput(reasonDetail) : null,
          } as any,
        }),
        prisma.workspace.delete({
          where: { id: cleanWorkspaceId },
        }),
      ]);

      return reply.send({
        deleted: true,
        workspaceId: cleanWorkspaceId,
      });
    } catch (err: any) {
      if (err?.code === "P2025") {
        return reply.status(404).send({ error: "Workspace not found." });
      }
      fastify.log.error(err);
      return reply.status(500).send({ error: err.message || "Failed to delete workspace" });
    }
  };

  fastify.delete("/workspaces/:id", handleDelete);
  fastify.delete("/api/workspaces/:id", handleDelete);
};

export default workspacesRoutes;
