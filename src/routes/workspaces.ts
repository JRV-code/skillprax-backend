import { FastifyInstance, FastifyPluginAsync } from "fastify";
import prisma from "../lib/prisma";
import { runPedagogicalCuratorPipeline } from "../lib/ai/pipeline";
import { safeJsonParse, safeJsonStringify } from "../lib/ai/orchestrator";

const workspaceRoutes: FastifyPluginAsync = async (server: FastifyInstance) => {
  // Initiate Workspace & Generate Step 1
  server.post("/api/workspaces/initiate", async (req, reply) => {
    try {
      const body = (req.body || {}) as any;
      const { title, domainCategory, targetGoal, level, category, baselineKnowledge } = body;

      const titleVal = title || body.title;
      if (!titleVal) {
        return reply.status(400).send({ error: "Title is required" });
      }

      // Safe lookup for AdminConfig (avoids ID mismatch)
      const config = await prisma.adminConfig.findFirst();
      const groqKey = config?.groqKey || process.env.GROQ_API_KEY;
      const tavilyKey = config?.tavilyKey || process.env.TAVILY_API_KEY;

      if (!groqKey) {
        return reply.status(400).send({ error: "Groq API key is not configured in Admin panel." });
      }

      const domainVal = domainCategory || category || "General Knowledge";
      const goalVal = targetGoal || "Mastery";

      // Create Workspace Record
      const workspace = await prisma.workspace.create({
        data: {
          title: titleVal,
          domainCategory: domainVal,
          category: domainVal,
          baselineKnowledge: baselineKnowledge || "",
          targetGoal: goalVal,
          level: level || "Beginner",
          currentStep: 1,
          currentStepIndex: 1,
          aiProvider: "groq"
        }
      });

      // Run Autonomous Dual-AI Pipeline for Step 1
      const stepData = await runPedagogicalCuratorPipeline({
        domain: workspace.domainCategory,
        topic: workspace.title,
        stepIndex: 1,
        stepTitle: "Foundations & Core Principles",
        goal: workspace.targetGoal,
        groqKey,
        tavilyKey
      });

      // Persist Step 1 with AI-determined questionCount and resources
      const step = await prisma.skillStep.create({
        data: {
          workspaceId: workspace.id,
          stepIndex: 1,
          title: "Foundations & Core Principles",
          difficulty: "Beginner",
          whatYouWillLearn: stepData.whatYouWillLearn || "",
          coreKeyTakeaways: safeJsonStringify(stepData.coreKeyTakeaways || []),
          practicalApplication: stepData.practicalApplication || goalVal,
          questionCount: Number(stepData.questionCount) || 5,
          assessableUnits: safeJsonStringify(stepData.assessableUnits || []),
          resources: safeJsonStringify(stepData.resources || []),
          status: "IN_PROGRESS"
        }
      });

      return reply.send({
        workspace,
        step: {
          ...step,
          coreKeyTakeaways: safeJsonParse(step.coreKeyTakeaways, []),
          assessableUnits: safeJsonParse(step.assessableUnits, []),
          resources: safeJsonParse(step.resources, [])
        }
      });
    } catch (err: any) {
      server.log.error(err);
      return reply.status(500).send({ error: err.message || "Failed to initiate workspace" });
    }
  });

  // GET /api/workspaces
  server.get("/api/workspaces", async (_req, reply) => {
    const workspaces = await prisma.workspace.findMany({
      orderBy: { updatedAt: "desc" },
      include: {
        steps: {
          orderBy: { stepIndex: "asc" }
        }
      }
    });

    const formatted = workspaces.map((w) => ({
      ...w,
      steps: w.steps.map((s) => ({
        ...s,
        coreKeyTakeaways: safeJsonParse(s.coreKeyTakeaways, []),
        assessableUnits: safeJsonParse(s.assessableUnits, []),
        resources: safeJsonParse(s.resources, [])
      }))
    }));

    return reply.send(formatted);
  });

  // Fetch Workspace by ID
  server.get("/api/workspaces/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const workspace = await prisma.workspace.findUnique({
      where: { id },
      include: {
        steps: {
          orderBy: { stepIndex: "asc" }
        }
      }
    });

    if (!workspace) return reply.status(404).send({ error: "Workspace not found" });

    const formattedSteps = workspace.steps.map((s) => ({
      ...s,
      coreKeyTakeaways: safeJsonParse(s.coreKeyTakeaways, []),
      assessableUnits: safeJsonParse(s.assessableUnits, []),
      resources: safeJsonParse(s.resources, [])
    }));

    return reply.send({
      ...workspace,
      steps: formattedSteps
    });
  });
};

export default workspaceRoutes;
