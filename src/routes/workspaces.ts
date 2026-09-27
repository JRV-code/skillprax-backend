// skillprax-backend/src/routes/workspaces.ts

import { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import prisma from "../lib/prisma";
import { generateStepContent, GroqConfigError, GroqGenerationError } from "../lib/ai/pipeline";

const ADMIN_CONFIG_ID = "global";

async function getApiKeys(): Promise<{ groqApiKey: string; tavilyApiKey: string | null }> {
  let config: any = await prisma.adminConfig.findUnique({ where: { id: ADMIN_CONFIG_ID } });
  if (!config) {
    config = await prisma.adminConfig.findFirst();
  }

  const groqApiKey = config?.groqApiKey || config?.groqKey || process.env.GROQ_API_KEY;
  const tavilyApiKey = config?.tavilyApiKey || config?.tavilyKey || process.env.TAVILY_API_KEY || null;

  if (!groqApiKey) {
    throw new GroqConfigError(
      "GROQ_API_KEY is not configured in AdminConfig or environment variables."
    );
  }

  return {
    groqApiKey,
    tavilyApiKey,
  };
}

const createStepSchema = z.object({
  title: z.string().min(2).max(200),
  description: z.string().min(2).max(2000).optional().default("Foundational principles and mechanics."),
  pillar: z.string().min(2).max(100).optional().default("General Knowledge"),
  learnerLevel: z.enum(["beginner", "intermediate", "advanced"]).default("beginner"),
});

const createWorkspaceSchema = z.object({
  skillName: z.string().min(2).max(200).optional(),
  title: z.string().min(2).max(200).optional(),
  pillar: z.string().min(2).max(100).optional(),
  category: z.string().optional(),
  domainCategory: z.string().optional(),
  baselineKnowledge: z.string().optional(),
  targetGoal: z.string().optional(),
  preferredProvider: z.string().optional(),
});

const safeJsonParse = (data: any, fallback: any = []) => {
  if (Array.isArray(data) || (typeof data === "object" && data !== null)) return data;
  if (typeof data === "string") {
    try { return JSON.parse(data); } catch (_) { return fallback; }
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

const workspacesRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  
  // Handler for workspace initiation
  const handleInitiate = async (request: any, reply: any) => {
    const parsed = createWorkspaceSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid request body", details: parsed.error.flatten() });
    }

    const body = parsed.data;
    const skillName = body.skillName || body.title || "New Skill Track";
    const pillar = body.pillar || body.domainCategory || body.category || "General Knowledge";
    const baselineKnowledge = body.baselineKnowledge || "";
    const targetGoal = body.targetGoal || "Mastery";

    const workspaceData: any = {
      title: skillName,
      skillName: skillName,
      pillar: pillar,
      domainCategory: pillar,
      category: pillar,
      baselineKnowledge: baselineKnowledge,
      targetGoal: targetGoal,
      aiProvider: body.preferredProvider || "groq",
    };

    const workspace = await prisma.workspace.create({
      data: workspaceData,
    });

    let apiKeys: { groqApiKey: string; tavilyApiKey: string | null };
    try {
      apiKeys = await getApiKeys();
    } catch (err) {
      if (err instanceof GroqConfigError) {
        fastify.log.error({ err }, "AdminConfig / API key lookup failed");
        return reply.status(503).send({ error: `Initialization failed: ${err.message}` });
      }
      throw err;
    }

    let content;
    try {
      content = await generateStepContent({
        groqApiKey: apiKeys.groqApiKey,
        tavilyApiKey: apiKeys.tavilyApiKey,
        pillar,
        skillName,
        stepTitle: "Foundations & Core Principles",
        stepDescription: `Master core foundational principles and achieve: ${targetGoal}`,
        learnerLevel: "beginner",
      });
    } catch (err) {
      if (err instanceof GroqConfigError || err instanceof GroqGenerationError) {
        fastify.log.error({ err }, "Step content generation failed");
        return reply.status(502).send({ error: `Initialization failed: ${err.message}` });
      }
      throw err;
    }

    const stepData: any = {
      workspaceId: workspace.id,
      stepIndex: 1,
      title: "Foundations & Core Principles",
      description: `Master core foundational principles and achieve: ${targetGoal}`,
      whatYouWillLearn: content.conceptualOverview,
      conceptualOverview: content.conceptualOverview,
      coreKeyTakeaways: content.keyTakeaways as any,
      keyTakeaways: content.keyTakeaways as any,
      practicalApplication: targetGoal,
      questionCount: content.questionCount || 5,
      assessableUnits: (content.assessableUnits || content.keyTakeaways) as any,
      resources: content.resources as any,
      estimatedMinutes: content.estimatedMinutes || 45,
    };

    const step = await prisma.skillStep.create({
      data: stepData,
    });

    const formattedWs = formatWorkspace({ ...workspace, steps: [step] });
    const formattedStep = formatStep(step);

    return reply.status(201).send({
      id: workspace.id,
      ...formattedWs,
      workspace: formattedWs,
      step: formattedStep,
    });
  };

  fastify.post("/workspaces", handleInitiate);
  fastify.post("/api/workspaces", handleInitiate);
  fastify.post("/api/workspaces/initiate", handleInitiate);

  // List all workspaces
  const handleGetAll = async (_request: any, reply: any) => {
    const workspaces = await prisma.workspace.findMany({
      orderBy: { updatedAt: "desc" },
      include: { steps: { orderBy: { stepIndex: "asc" } } },
    });
    return reply.send(workspaces.map(formatWorkspace));
  };

  fastify.get("/workspaces", handleGetAll);
  fastify.get("/api/workspaces", handleGetAll);

  // Fetch Workspace by ID
  const handleGetById = async (request: any, reply: any) => {
    const { id } = request.params as { id: string };
    if (!id || id === "undefined") {
      return reply.status(400).send({ error: "Invalid workspace ID" });
    }

    const workspace = await prisma.workspace.findUnique({
      where: { id },
      include: { steps: { orderBy: { stepIndex: "asc" } } },
    });
    if (!workspace) {
      return reply.status(404).send({ error: "Workspace not found" });
    }

    const formatted = formatWorkspace(workspace);
    return reply.send({
      ...formatted,
      workspace: formatted,
    });
  };

  fastify.get("/workspaces/:id", handleGetById);
  fastify.get("/api/workspaces/:id", handleGetById);

  // Add Step to Workspace
  const handleAddStep = async (request: any, reply: any) => {
    const { id: workspaceId } = request.params as { id: string };
    const parsed = createStepSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid request body", details: parsed.error.flatten() });
    }

    const workspace: any = await prisma.workspace.findUnique({ where: { id: workspaceId } });
    if (!workspace) {
      return reply.status(404).send({ error: "Workspace not found" });
    }

    const { title, description, pillar, learnerLevel } = parsed.data;

    let apiKeys: { groqApiKey: string; tavilyApiKey: string | null };
    try {
      apiKeys = await getApiKeys();
    } catch (err) {
      if (err instanceof GroqConfigError) {
        return reply.status(503).send({ error: `Initialization failed: ${err.message}` });
      }
      throw err;
    }

    const lastStep = await prisma.skillStep.findFirst({
      where: { workspaceId },
      orderBy: { stepIndex: "desc" },
      select: { stepIndex: true },
    });
    const nextStepIndex = (lastStep?.stepIndex ?? 0) + 1;

    let content;
    try {
      content = await generateStepContent({
        groqApiKey: apiKeys.groqApiKey,
        tavilyApiKey: apiKeys.tavilyApiKey,
        pillar: pillar || workspace.pillar || workspace.domainCategory || "General Knowledge",
        skillName: workspace.skillName || workspace.title,
        stepTitle: title,
        stepDescription: description || "",
        learnerLevel,
      });
    } catch (err) {
      if (err instanceof GroqConfigError || err instanceof GroqGenerationError) {
        return reply.status(502).send({ error: `Initialization failed: ${err.message}` });
      }
      throw err;
    }

    const stepData: any = {
      workspaceId,
      stepIndex: nextStepIndex,
      title,
      description: description || "",
      whatYouWillLearn: content.conceptualOverview,
      conceptualOverview: content.conceptualOverview,
      coreKeyTakeaways: content.keyTakeaways as any,
      keyTakeaways: content.keyTakeaways as any,
      questionCount: content.questionCount || 5,
      assessableUnits: (content.assessableUnits || content.keyTakeaways) as any,
      resources: content.resources as any,
      estimatedMinutes: content.estimatedMinutes || 45,
    };

    const step = await prisma.skillStep.create({
      data: stepData,
    });

    return reply.status(201).send({ step: formatStep(step) });
  };

  fastify.post("/workspaces/:id/steps", handleAddStep);
  fastify.post("/api/workspaces/:id/steps", handleAddStep);

  // Regenerate Step
  const handleRegenerate = async (request: any, reply: any) => {
    const { id: workspaceId, stepId } = request.params as { id: string; stepId: string };

    const [workspace, step]: [any, any] = await Promise.all([
      prisma.workspace.findUnique({ where: { id: workspaceId } }),
      prisma.skillStep.findUnique({ where: { id: stepId } }),
    ]);
    if (!workspace || !step || step.workspaceId !== workspaceId) {
      return reply.status(404).send({ error: "Step not found in this workspace" });
    }

    let apiKeys: { groqApiKey: string; tavilyApiKey: string | null };
    try {
      apiKeys = await getApiKeys();
    } catch (err) {
      if (err instanceof GroqConfigError) {
        return reply.status(503).send({ error: `Initialization failed: ${err.message}` });
      }
      throw err;
    }

    let content;
    try {
      content = await generateStepContent({
        groqApiKey: apiKeys.groqApiKey,
        tavilyApiKey: apiKeys.tavilyApiKey,
        pillar: workspace.pillar || workspace.domainCategory || "General Knowledge",
        skillName: workspace.skillName || workspace.title,
        stepTitle: step.title,
        stepDescription: step.description || "",
        learnerLevel: "beginner",
      });
    } catch (err) {
      if (err instanceof GroqConfigError || err instanceof GroqGenerationError) {
        return reply.status(502).send({ error: `Regeneration failed: ${err.message}` });
      }
      throw err;
    }

    const updateData: any = {
      whatYouWillLearn: content.conceptualOverview,
      conceptualOverview: content.conceptualOverview,
      coreKeyTakeaways: content.keyTakeaways as any,
      keyTakeaways: content.keyTakeaways as any,
      questionCount: content.questionCount || 5,
      assessableUnits: (content.assessableUnits || content.keyTakeaways) as any,
      resources: content.resources as any,
      estimatedMinutes: content.estimatedMinutes || 45,
    };

    const updated = await prisma.skillStep.update({
      where: { id: stepId },
      data: updateData,
    });

    return reply.send({ step: formatStep(updated) });
  };

  fastify.post("/workspaces/:id/steps/:stepId/regenerate", handleRegenerate);
  fastify.post("/api/workspaces/:id/steps/:stepId/regenerate", handleRegenerate);
};

export default workspacesRoutes;
