// skillprax-backend/src/routes/quizzes.ts

import { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import prisma from "../lib/prisma";
import { generateQuiz, GroqConfigError, GroqGenerationError } from "../lib/ai/pipeline";

const ADMIN_CONFIG_ID = "global";

async function getGroqApiKey(): Promise<string> {
  let config: any = await prisma.adminConfig.findUnique({ where: { id: ADMIN_CONFIG_ID } });
  if (!config) {
    config = await prisma.adminConfig.findFirst();
  }
  const groqApiKey = config?.groqApiKey || config?.groqKey || process.env.GROQ_API_KEY;

  if (!groqApiKey) {
    throw new GroqConfigError("GROQ_API_KEY is not configured in AdminConfig or environment variables.");
  }
  return groqApiKey;
}

const submitQuizSchema = z.object({
  answers: z.array(z.object({ 
    questionId: z.string().optional(),
    id: z.string().optional(),
    selectedIndex: z.number().int().min(0).optional(),
    selectedOptionIndex: z.number().int().min(0).optional(),
  })),
});

const quizzesRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {

  // Create & Generate Quiz for Step
  const handleGenerateQuiz = async (request: any, reply: any) => {
    const { workspaceId, stepId: paramStepId } = (request.params || {}) as { workspaceId?: string; stepId?: string };
    const bodyStepId = (request.body || {})?.stepId;
    const stepId = paramStepId || bodyStepId;

    if (!stepId) {
      return reply.status(400).send({ error: "stepId parameter is required" });
    }

    const step: any = await prisma.skillStep.findUnique({
      where: { id: stepId },
      include: { workspace: true },
    });

    if (!step) {
      return reply.status(404).send({ error: "Step not found" });
    }

    let groqApiKey: string;
    try {
      groqApiKey = await getGroqApiKey();
    } catch (err) {
      if (err instanceof GroqConfigError) {
        return reply.status(503).send({ error: `Initialization failed: ${err.message}` });
      }
      throw err;
    }

    let quiz;
    try {
      quiz = await generateQuiz({
        groqApiKey,
        pillar: step.workspace?.pillar || step.workspace?.domainCategory || step.workspace?.category || "General Knowledge",
        skillName: step.workspace?.skillName || step.workspace?.title || "Skill Track",
        stepTitle: step.title,
        stepDescription: step.description || "",
        conceptualOverview: step.conceptualOverview || step.whatYouWillLearn || "",
        learnerLevel: "beginner",
      });
    } catch (err) {
      if (err instanceof GroqConfigError || err instanceof GroqGenerationError) {
        fastify.log.error({ err }, "Quiz generation failed");
        return reply.status(502).send({ error: `Quiz generation failed: ${err.message}` });
      }
      throw err;
    }

    const attemptData: any = {
      stepId,
      acuBreakdown: quiz.acuBreakdown as any,
      questionCount: quiz.questionCount,
      questions: quiz.questions as any,
      status: "in_progress",
    };

    const attempt = await prisma.quizAttempt.create({
      data: attemptData,
    });

    const sanitizedQuestions = quiz.questions.map(({ id, acuLabel, scenario, question, options }) => ({
      id,
      acuLabel,
      scenario,
      question,
      options,
    }));

    return reply.status(201).send({
      attemptId: attempt.id,
      acuBreakdown: quiz.acuBreakdown,
      questionCount: quiz.questionCount,
      questions: sanitizedQuestions,
    });
  };

  fastify.post("/workspaces/:workspaceId/steps/:stepId/quiz", handleGenerateQuiz);
  fastify.post("/api/steps/:stepId/prompt-quiz", handleGenerateQuiz);
  fastify.post("/api/quizzes/generate", handleGenerateQuiz);

  // Submit Quiz Attempt Evaluation
  const handleSubmitQuiz = async (request: any, reply: any) => {
    const { attemptId } = (request.params || {}) as { attemptId?: string };
    const parsed = submitQuizSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid request body", details: parsed.error.flatten() });
    }

    let attempt: any = null;
    if (attemptId) {
      attempt = await prisma.quizAttempt.findUnique({ where: { id: attemptId } });
    }

    if (!attempt) {
      const stepId = (request.params || {})?.stepId || (request.body || {})?.stepId;
      if (stepId) {
        const attempts: any[] = await prisma.quizAttempt.findMany({
          where: { stepId },
          orderBy: { createdAt: "desc" },
        });
        attempt = attempts.find((a) => a.status === "in_progress") || attempts[0];
      }
    }

    if (!attempt) {
      return reply.status(404).send({ error: "Quiz attempt not found" });
    }

    const questions = (attempt.questions || []) as unknown as Array<{
      id: string;
      acuLabel: string;
      correctIndex: number;
      distractorExplanations: string[];
      options: string[];
    }>;

    const { answers } = parsed.data;
    const answerMap = new Map(answers.map((a) => [a.questionId || a.id, a.selectedIndex ?? a.selectedOptionIndex ?? -1]));

    let correctCount = 0;
    const results = questions.map((q) => {
      const selectedIndex = answerMap.get(q.id) ?? -1;
      const isCorrect = selectedIndex === q.correctIndex;
      if (isCorrect) correctCount += 1;
      return {
        questionId: q.id,
        acuLabel: q.acuLabel,
        selectedIndex,
        correctIndex: q.correctIndex,
        isCorrect,
        explanation: q.distractorExplanations?.[selectedIndex] ?? "No answer selected.",
        correctExplanation: q.distractorExplanations?.[q.correctIndex] ?? "",
      };
    });

    const total = Math.max(questions.length, 1);
    const scorePercent = Math.round((correctCount / total) * 100);
    const passed = scorePercent >= 80;
    const weakAcus = results.filter((r) => !r.isCorrect).map((r) => r.acuLabel);

    const updateData: any = {
      status: "completed",
      correctCount,
      scorePercent,
      score: scorePercent,
      passed,
      results: results as any,
      completedAt: new Date(),
    };

    const updated = await prisma.quizAttempt.update({
      where: { id: attempt.id },
      data: updateData,
    });

    return reply.send({
      attemptId: updated.id,
      score: scorePercent,
      scorePercent,
      passed,
      correctCount,
      questionCount: questions.length,
      weakAcus,
      results,
    });
  };

  fastify.post("/quiz-attempts/:attemptId/submit", handleSubmitQuiz);
  fastify.post("/api/steps/:stepId/evaluate", handleSubmitQuiz);
};

export default quizzesRoutes;
