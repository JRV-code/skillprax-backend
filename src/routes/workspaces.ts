// skillprax-backend/src/routes/workspaces.ts

import { FastifyInstance, FastifyPluginAsync } from "fastify";
import prisma from "../lib/prisma";
import {
  synthesizeStepMaterials,
  synthesizeQuizFromMaterial,
  harvestResources,
  callGroqWithFallback,
  PipelineExhaustionError,
  GroqConfigError,
} from "../lib/ai/pipeline";

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
      ? q.options.map((opt: any) =>
          typeof opt === "string" ? opt : { id: opt.id || opt.key || "A", text: opt.text }
        )
      : [],
  }));
}

const formatStepClientSafe = (step: any) => {
  const rawBlueprint = safeJsonParse(step.quizBlueprint, []);
  const studentSafeQuestions = stripQuizAnswers(rawBlueprint);
  const acus = safeJsonParse(step.assessableUnits, []);

  return {
    ...step,
    assessableUnits: acus,
    resources: safeJsonParse(step.resources, []),
    quizBlueprint: studentSafeQuestions,
    questionCount: studentSafeQuestions.length > 0 ? studentSafeQuestions.length : acus.length,
  };
};

const formatWorkspaceClientSafe = (workspace: any) => ({
  ...workspace,
  title: workspace.title || "",
  domainCategory: workspace.domainCategory || "General Knowledge",
  subGenre: workspace.subGenre || null,
  steps: Array.isArray(workspace.steps) ? workspace.steps.map(formatStepClientSafe) : [],
});

function sanitizeInput(text: string): string {
  return text.replace(/[<>{}]/g, "").slice(0, 500);
}

const workspacesRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // ============================================================
  // 1. POST /api/workspaces/initiate — Create workspace & generate Step 1
  // ============================================================
  fastify.post("/api/workspaces/initiate", async (request, reply) => {
    try {
      const body: any = request.body || {};

      // Guardrail 4: defensive normalization — accept title OR topic
      const cleanTitle = sanitizeInput((body.title ?? body.topic ?? "").trim()).slice(0, 140);
      if (!cleanTitle) {
        return reply.status(400).send({ error: "Title parameter is required and must be non-empty." });
      }

      const cleanDomain = sanitizeInput((body.domainCategory ?? body.pillar ?? body.category ?? "General Knowledge").trim());
      const cleanSubGenre = body.subGenre ? sanitizeInput(String(body.subGenre).trim()) : null;
      const cleanGoal = sanitizeInput((body.targetGoal ?? "Full Mastery").trim());
      const cleanLevel = sanitizeInput((body.level ?? "beginner").trim()).toLowerCase() || "beginner";

      let apiKeys;
      try {
        apiKeys = await getApiKeys();
      } catch (err) {
        if (err instanceof GroqConfigError) {
          return reply.status(503).send({ error: `AI configuration error: ${err.message}` });
        }
        throw err;
      }

      // Create workspace + Step 1 in a single transaction
      const [workspace, step] = await prisma.$transaction(async (tx) => {
        const ws = await tx.workspace.create({
          data: {
            title: cleanTitle,
            domainCategory: cleanDomain,
            subGenre: cleanSubGenre,
            targetGoal: cleanGoal,
            level: cleanLevel,
            aiEngine: body.aiEngine || "llama-3.3-70b-versatile",
            userProfileId: body.userProfileId || body.profileId || "default-profile",
            totalPlannedSteps: typeof body.totalPlannedSteps === 'number' ? Math.min(8, Math.max(3, body.totalPlannedSteps)) : 5,
            isGenerating: true,
            generationStartedAt: new Date(),
          },
        });

        const st = await tx.skillStep.create({
          data: {
            workspaceId: ws.id,
            stepIndex: 1,
            title: "Foundations & Core Principles",
            description: `Master core foundational mechanics and achieve: ${cleanGoal}`,
            status: "IN_PROGRESS",
          },
        });

        return [ws, st];
      });

      // Two-phase pipeline synthesis for Step 1
      try {
        // Phase A: harvest + curate
        const candidates = await harvestResources(
          cleanTitle,
          "Foundations & Core Principles",
          apiKeys.tavilyApiKey,
          cleanDomain,
          cleanGoal
        );
        const materials = await synthesizeStepMaterials(
          cleanTitle,
          cleanDomain,
          cleanGoal,
          cleanLevel,
          candidates,
          apiKeys.groqApiKey
        );

        // Persist Phase A results
        const updatedStep = await prisma.skillStep.update({
          where: { id: step.id },
          data: {
            assessableUnits: materials.acus as any,
            resources: materials.resources as any,
          },
        });

        const fullWorkspace = await prisma.workspace.findUnique({
          where: { id: workspace.id },
          include: { steps: { orderBy: { stepIndex: "asc" } } },
        });

        const formatted = formatWorkspaceClientSafe(fullWorkspace);
        return reply.status(201).send({
          id: workspace.id,
          ...formatted,
          workspace: formatted,
          step: formatStepClientSafe(updatedStep),
        });
      } finally {
        await prisma.workspace.update({
          where: { id: workspace.id },
          data: { isGenerating: false, generationStartedAt: null },
        });
      }
    } catch (err: any) {
      if (err instanceof PipelineExhaustionError) {
        return reply.status(503).send({ error: "AI pipeline models were busy or unavailable. Please try again shortly." });
      }
      if (err?.code === "P2025") {
        return reply.status(404).send({ error: "Record not found." });
      }
      fastify.log.error(err);
      return reply.status(500).send({ error: err.message || "Failed to initiate workspace" });
    }
  });

  // ============================================================
  // 1B. POST /api/workspaces — Dynamic Sizing (3-8 steps) & Sub-Genre
  // ============================================================
  fastify.post("/api/workspaces", async (request, reply) => {
    try {
      const body: any = request.body || {};
      const cleanTitle = sanitizeInput((body.title ?? body.topic ?? "").trim()).slice(0, 140);
      if (!cleanTitle) {
        return reply.status(400).send({ error: "Title parameter is required." });
      }

      const cleanDomain = sanitizeInput((body.domain ?? body.domainCategory ?? body.category ?? "General Knowledge").trim());
      const cleanSubGenre = body.subGenre ? sanitizeInput(String(body.subGenre).trim()) : null;
      const profileId = body.profileId || body.userProfileId || "default-profile";

      let apiKeys;
      try {
        apiKeys = await getApiKeys();
      } catch (err) {
        if (err instanceof GroqConfigError) {
          return reply.status(503).send({ error: `AI configuration error: ${(err as Error).message}` });
        }
        throw err;
      }

      // Fetch profile context if available
      const profile = await prisma.userProfile.findUnique({ where: { id: profileId } });
      const eduContext = profile ? `${profile.educationBoard} ${profile.grade}` : "Standard Track";

      const systemPrompt = `You are the SKILL-TRACK Pedagogy & Curriculum Engine (v2.6).
Domain: "${cleanDomain}"
Target Skill: "${cleanTitle}"
${cleanSubGenre ? `Specialized Sub-Genre: "${cleanSubGenre}"` : ''}
Learner Educational Context: "${eduContext}".

TASK:
Generate a rigorous, sequentially mastered curriculum tailored specifically to "${cleanTitle}".

DYNAMIC SIZING DIRECTIVE (3 to 8 Milestones):
- DYNAMICALLY SCOPE ROADMAP DEPTH BETWEEN 3 AND 8 MILESTONES based on technical complexity:
  * Niche technical drill or narrow specialization: 3 to 4 milestones.
  * Intermediate applied systems: 4 to 6 milestones.
  * Deep multi-layered disciplines (e.g. Organic Chemistry, Distributed Systems): 6 to 8 milestones.
- Every step MUST have a completely UNIQUE, DISTINCT title reflecting a clear progressive level-up in difficulty and mastery.
- Each milestone MUST contain 2 to 3 granular Assessable Competency Units (ACUs).

JSON SCHEMA:
{
  "title": "${cleanTitle}",
  "subTitle": "An authoritative, domain-accurate subtitle",
  "steps": [
    {
      "stepIndex": 1,
      "title": "Unique Foundational Module Name",
      "acus": [
        { "title": "Competency Unit Name", "description": "Specific measurable skill tested" },
        { "title": "Competency Unit Name", "description": "Specific measurable skill tested" }
      ]
    }
  ]
}`;

      let generatedData: any = null;
      try {
        const aiRes = await callGroqWithFallback(
          [
            { role: "system", content: systemPrompt },
            { role: "user", content: `Generate dynamic 3-8 step curriculum for "${cleanTitle}" ${cleanSubGenre ? `(${cleanSubGenre})` : ''}` }
          ],
          { apiKey: apiKeys.groqApiKey, jsonMode: true, model: "llama-3.3-70b-versatile" }
        );
        const cleaned = aiRes.content.trim().replace(/^```json\s*/i, '').replace(/\s*```$/, '');
        generatedData = JSON.parse(cleaned);
      } catch (aiErr) {
        fastify.log.warn(`[POST /api/workspaces] Groq fallback used: ${(aiErr as Error).message}`);
        generatedData = {
          title: cleanTitle,
          subTitle: `${cleanSubGenre ? `${cleanSubGenre} ` : ''}${cleanDomain} Mastery Track`,
          steps: [
            {
              stepIndex: 1,
              title: `${cleanTitle}: Foundational Principles`,
              acus: [
                { title: `Axiomatic ${cleanTitle} Baseline`, description: "Verify baseline principles" },
                { title: "Boundary Conditions", description: "First-principles verification" }
              ]
            },
            {
              stepIndex: 2,
              title: `${cleanTitle}: Applied Mechanics`,
              acus: [
                { title: "Procedural Execution", description: "Applied synthesis and operational steps" }
              ]
            },
            {
              stepIndex: 3,
              title: `${cleanTitle}: Advanced Optimization`,
              acus: [
                { title: "Non-linear edge cases", description: "Cross-domain synthesis verification" }
              ]
            },
            {
              stepIndex: 4,
              title: `${cleanTitle}: Apex Mastery`,
              acus: [
                { title: "Apex Competency Clearance", description: "Comprehensive Socratic verification" }
              ]
            }
          ]
        };
      }

      // Clamp steps between 3 and 8
      const rawSteps = Array.isArray(generatedData.steps) ? generatedData.steps : [];
      const clampedSteps = rawSteps.slice(0, 8);
      if (clampedSteps.length < 3) {
        while (clampedSteps.length < 3) {
          const idx = clampedSteps.length + 1;
          clampedSteps.push({
            stepIndex: idx,
            title: `Milestone ${idx}: Applied Synthesis`,
            acus: [{ title: 'Applied Verification', description: 'Practical execution under scenario constraints' }]
          });
        }
      }

      // Create Workspace + Steps in Prisma transaction
      const newWorkspace = await prisma.workspace.create({
        data: {
          title: generatedData.title || cleanTitle,
          domainCategory: cleanDomain,
          subGenre: cleanSubGenre,
          targetGoal: body.targetGoal || "Full Mastery",
          level: body.level || "Beginner",
          aiEngine: "llama-3.3-70b-versatile",
          userProfileId: profileId,
          totalPlannedSteps: clampedSteps.length,
          steps: {
            create: clampedSteps.map((s: any, idx: number) => ({
              stepIndex: idx + 1,
              title: s.title || `Step ${idx + 1}`,
              description: `Mastery gate for step ${idx + 1}`,
              status: idx === 0 ? "STUDY_UNGENERATED" : "LOCKED",
              assessableUnits: (s.acus || []).map((a: any) => ({
                title: typeof a === "string" ? a : a.title || "Competency Unit",
                description: typeof a === "string" ? a : a.description || "Specific skill tested"
              })) as any
            }))
          }
        },
        include: {
          steps: { orderBy: { stepIndex: "asc" } }
        }
      });

      const formatted = formatWorkspaceClientSafe(newWorkspace);
      return reply.status(201).send({ workspace: formatted, id: newWorkspace.id });
    } catch (err: any) {
      fastify.log.error(err, "[POST /api/workspaces] Failed");
      return reply.status(500).send({ error: err.message || "Failed to create workspace" });
    }
  });

  // ============================================================
  fastify.get("/api/workspaces", async (req, reply) => {
    const { profileId } = req.query as { profileId?: string };
    if (!profileId) {
      return reply.status(400).send({ error: "profileId query parameter is required" });
    }
    try {
      const workspaces = await prisma.workspace.findMany({
        where: { userProfileId: profileId },
        orderBy: { updatedAt: "desc" },
        include: {
          steps: {
            select: { id: true, stepIndex: true, status: true, title: true },
            orderBy: { stepIndex: "asc" },
          },
        },
      });

      const enriched = workspaces.map((ws: any) => {
        const steps = ws.steps || [];
        const totalSteps = ws.totalPlannedSteps || 5;
        const passedCount = steps.filter((s: any) => s.status === "PASSED").length;
        const progress = Math.round((passedCount / totalSteps) * 100);
        const currentStep = passedCount < totalSteps ? passedCount + 1 : totalSteps;

        return {
          ...ws,
          totalSteps,
          completedSteps: passedCount,
          currentStep,
          progress,
          engine: ws.aiEngine || "llama-3.3-70b-versatile",
        };
      });

      return reply.status(200).send({ workspaces: enriched });
    } catch (err: any) {
      fastify.log.error(err, "[GET /api/workspaces] Failed");
      return reply.status(500).send({ error: "Failed to fetch tracks" });
    }
  });

  // ============================================================
  // 3. GET /api/workspaces/:id — Fetch workspace with auto-healing & polling
  // ============================================================
  fastify.get("/api/workspaces/:id", async (request, reply) => {
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

      // Check if generation is in-flight (<30s ago). If so, poll up to ~5 times (7.5s total)
      if (workspace.isGenerating && workspace.generationStartedAt) {
        const elapsedMs = Date.now() - new Date(workspace.generationStartedAt).getTime();
        if (elapsedMs < 30000) {
          let pollAttempts = 0;
          while (pollAttempts < 5) {
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
            data: { isGenerating: true, generationStartedAt: new Date() },
          });

          const apiKeys = await getApiKeys();
          const candidates = await harvestResources(
            workspace.title,
            currentStep.title,
            apiKeys.tavilyApiKey,
            workspace.domainCategory,
            workspace.targetGoal
          );
          const materials = await synthesizeStepMaterials(
            workspace.title,
            workspace.domainCategory,
            workspace.targetGoal,
            workspace.level || "beginner",
            candidates,
            apiKeys.groqApiKey
          );

          const healedStep = await prisma.skillStep.update({
            where: { id: currentStep.id },
            data: {
              assessableUnits: materials.acus as any,
              resources: materials.resources as any,
            },
          });

          workspace.steps[workspace.steps.length - 1] = healedStep;
        } catch (healErr) {
          console.warn("[workspaces] Auto-healing step generation error:", (healErr as Error).message);
        } finally {
          await prisma.workspace.update({
            where: { id: cleanId },
            data: { isGenerating: false, generationStartedAt: null },
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
  });

  // ============================================================
  // 4. POST /api/workspaces/:id/next-step — Generate next step if current passed
  // ============================================================
  fastify.post("/api/workspaces/:id/next-step", async (request, reply) => {
    try {
      const { id: workspaceId } = request.params as { id: string };
      const cleanWorkspaceId = (workspaceId || "").trim();

      const workspace: any = await prisma.workspace.findUnique({
        where: { id: cleanWorkspaceId },
        include: {
          steps: { orderBy: { stepIndex: "asc" } },
        },
      });

      if (!workspace) {
        return reply.status(404).send({ error: `Workspace with ID "${cleanWorkspaceId}" not found.` });
      }

      const steps = workspace.steps || [];
      const currentStep = steps[steps.length - 1];

      // SERVER-SIDE VERIFICATION: Current step must be passed (from DB)
      if (currentStep && currentStep.status !== "PASSED") {
        return reply.status(400).send({
          error: "Current step has not been passed yet. You must pass the evaluation quiz (80%+ score) before advancing.",
        });
      }

      const nextStepIndex = (currentStep?.stepIndex ?? 0) + 1;

      // IDEMPOTENCY: If next step already exists, return it
      const existingNextStep = steps.find((s: any) => s.stepIndex === nextStepIndex);
      if (existingNextStep) {
        return reply.send({
          step: formatStepClientSafe(existingNextStep),
          workspace: formatWorkspaceClientSafe(workspace),
        });
      }

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

      // Create new step row + set generating flag
      const newStep = await prisma.$transaction(async (tx) => {
        const ns = await tx.skillStep.create({
          data: {
            workspaceId: cleanWorkspaceId,
            stepIndex: nextStepIndex,
            title: nextStepTitle,
            description: `Deepen practical implementation and mastery for ${workspace.title}.`,
            status: "IN_PROGRESS",
          },
        });
        await tx.workspace.update({
          where: { id: cleanWorkspaceId },
          data: {
            isGenerating: true,
            generationStartedAt: new Date(),
          },
        });
        return ns;
      });

      // Synthesize content for next step
      try {
        const candidates = await harvestResources(
          workspace.title,
          nextStepTitle,
          apiKeys.tavilyApiKey,
          workspace.domainCategory,
          workspace.targetGoal
        );
        const materials = await synthesizeStepMaterials(
          workspace.title,
          workspace.domainCategory,
          workspace.targetGoal,
          workspace.level || "beginner",
          candidates,
          apiKeys.groqApiKey
        );

        // Persist Phase A results for next step (Quiz generation happens on-demand via prompt-quiz button click)
        const updatedStep = await prisma.skillStep.update({
          where: { id: newStep.id },
          data: {
            assessableUnits: materials.acus as any,
            resources: materials.resources as any,
          },
        });

        const updatedWorkspace = await prisma.workspace.findUnique({
          where: { id: cleanWorkspaceId },
          include: { steps: { orderBy: { stepIndex: "asc" } } },
        });

        return reply.status(200).send({
          ...(updatedWorkspace || {}),
          workspace: updatedWorkspace,
        });
      } finally {
        await prisma.workspace.update({
          where: { id: cleanWorkspaceId },
          data: { isGenerating: false, generationStartedAt: null },
        });
      }
    } catch (err: any) {
      if (err instanceof PipelineExhaustionError) {
        return reply.status(503).send({ error: "AI pipeline models were busy or unavailable. Please try again shortly." });
      }
      if (err?.code === "P2025") {
        return reply.status(404).send({ error: "Record not found." });
      }
      fastify.log.error(err);
      return reply.status(500).send({ error: err.message || "Failed to generate next step" });
    }
  });

  // ============================================================
  // 5. POST /api/workspaces/:id/abandon-reflection — Resilient reflection handler
  // ============================================================
  fastify.post('/api/workspaces/:id/abandon-reflection', async (request, reply) => {
    const params = (request.params || {}) as { id?: string };
    const cleanId = (params.id || "").trim();

    try {
      const workspace: any = await prisma.workspace.findUnique({
        where: { id: cleanId },
        include: {
          steps: {
            where: { status: 'PASSED' },
            orderBy: { stepIndex: 'asc' },
          },
        },
      });

      if (!workspace) {
        return reply.status(404).send({ error: 'Workspace not found' });
      }

      const passedSteps = workspace.steps || [];

      // Return 200 with clear initial context if 0 steps passed yet
      if (passedSteps.length === 0) {
        return reply.status(200).send({
          reflectionText: `You are at the start of your journey in "${workspace.title}". Pausing now leaves your initial foundational milestone uncompleted.`,
          milestonesSummary: [],
        });
      }

      const completedSummary = passedSteps.map((s: any) => `Milestone ${s.stepIndex}: ${s.title}`);

      try {
        let groqKey: string | undefined;
        try {
          const apiKeys = await getApiKeys();
          groqKey = apiKeys.groqApiKey;
        } catch (_) {
          groqKey = process.env.GROQ_API_KEY;
        }

        if (!groqKey) {
          return reply.status(200).send({
            reflectionText: `You have completed ${passedSteps.length} milestone(s) in "${workspace.title}".`,
            milestonesSummary: completedSummary,
          });
        }

        const prompt = `The user is considering abandoning or pausing their learning track titled "${workspace.title}" (${workspace.domainCategory}).
They have completed ${passedSteps.length} milestones:
${completedSummary.join('\n')}

Generate a concise, honest 2-3 sentence reflection acknowledging what they have built and what pausing leaves unfinished. No generic motivational fluff. Keep it grounded.`;

        const aiResponse = await callGroqWithFallback([
          { role: 'user', content: prompt }
        ], { apiKey: groqKey });

        return reply.status(200).send({
          reflectionText: aiResponse.content.trim(),
          milestonesSummary: completedSummary,
        });
      } catch (groqErr) {
        fastify.log.warn(`[AbandonReflection] AI fallback used: ${(groqErr as Error).message}`);
        return reply.status(200).send({
          reflectionText: `You have completed ${passedSteps.length} milestone(s) in "${workspace.title}".`,
          milestonesSummary: completedSummary,
        });
      }
    } catch (err) {
      fastify.log.error(err, '[AbandonReflection] Failed');
      return reply.status(200).send({
        reflectionText: null,
        milestonesSummary: [],
      });
    }
  });

  // ============================================================
  // 6. DELETE /api/workspaces/:id — Delete workspace & record AbandonmentLog
  // ============================================================
  fastify.delete("/api/workspaces/:id", async (request, reply) => {
    try {
      const { id: workspaceId } = request.params as { id: string };
      const cleanWorkspaceId = (workspaceId || "").trim();

      const body: any = request.body || {};
      const reason = body.reason;
      const reasonDetail = body.reasonDetail;

      const validReasons = ["curve_too_steep", "curriculum_mismatch", "pivoting_goals", "other"];
      if (!reason || !validReasons.includes(reason)) {
        return reply.status(400).send({
          error: `Invalid reason. Must be one of: ${validReasons.join(", ")}`,
        });
      }

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

      // Single transaction: create AbandonmentLog (plain scalar workspaceId) -> delete workspace (cascades steps/attempts)
      await prisma.$transaction([
        prisma.abandonmentLog.create({
          data: {
            workspaceId: cleanWorkspaceId,
            trackTitle: workspace.title || "Skill Track",
            domain: workspace.domainCategory || "General Knowledge",
            completedStepsCount,
            timeInvestedSeconds,
            reason,
            reasonDetail: reasonDetail ? sanitizeInput(String(reasonDetail)) : null,
          },
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
  });
};

export default workspacesRoutes;
