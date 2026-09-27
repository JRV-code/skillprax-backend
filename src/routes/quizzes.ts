// skillprax-backend/src/routes/quizzes.ts

import { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import prisma from "../lib/prisma";
import { curateAndExamine, PipelineExhaustionError, GroqConfigError } from "../lib/ai/pipeline";

const PASSING_THRESHOLD = 0.8; // 80% passing threshold
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

const promptQuizParamsSchema = z.object({
  stepId: z.string().min(1),
});

const submitQuizBodySchema = z.object({
  attemptId: z.string().min(1),
  answers: z.array(
    z.object({
      questionId: z.string().min(1),
      selectedOptionId: z.union([z.string(), z.number()]),
    })
  ),
});

const quizzesRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // 1. POST /api/steps/:stepId/prompt-quiz — Generate or retrieve active quiz attempt
  fastify.post("/api/steps/:stepId/prompt-quiz", async (request, reply) => {
    try {
      const paramsResult = promptQuizParamsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return reply.status(400).send({ error: "Invalid stepId parameter", details: paramsResult.error.flatten() });
      }

      const { stepId } = paramsResult.data;
      const userId = ((request as any).userId as string) || "default_user";

      const step: any = await prisma.skillStep.findUnique({
        where: { id: stepId },
        include: { workspace: true },
      });

      if (!step) {
        return reply.status(404).send({ error: `Step "${stepId}" not found.` });
      }

      // IDEMPOTENCY: Return existing unsubmitted quiz attempt if in progress
      const existingAttempt: any = await prisma.quizAttempt.findFirst({
        where: {
          stepId,
          userId,
          status: "in_progress",
        } as any,
        orderBy: { createdAt: "desc" },
      });

      if (existingAttempt && existingAttempt.questions) {
        const rawQuestions = Array.isArray(existingAttempt.questions)
          ? existingAttempt.questions
          : JSON.parse(String(existingAttempt.questions) || "[]");

        if (rawQuestions.length > 0) {
          const studentSafeQuestions = rawQuestions.map((q: any) => ({
            id: q.id,
            acuId: q.acuId || "acu-1",
            scenario: q.scenario || "",
            question: q.question || "",
            options: Array.isArray(q.options)
              ? q.options.map((opt: any) => (typeof opt === "string" ? opt : opt.text || String(opt)))
              : [],
          }));

          return reply.send({
            attemptId: existingAttempt.id,
            questionCount: studentSafeQuestions.length,
            questions: studentSafeQuestions,
            passingScorePercent: Math.round(PASSING_THRESHOLD * 100),
          });
        }
      }

      let groqApiKey: string;
      try {
        groqApiKey = await getGroqApiKey();
      } catch (err) {
        if (err instanceof GroqConfigError) {
          return reply.status(503).send({ error: `Groq configuration error: ${err.message}` });
        }
        throw err;
      }

      let result;
      try {
        const workspaceTitle = step.workspace?.title || step.workspace?.skillName || step.title;
        result = await curateAndExamine(
          workspaceTitle,
          step.title,
          [],
          groqApiKey
        );
      } catch (err) {
        if (err instanceof PipelineExhaustionError) {
          return reply.status(503).send({ error: "AI pipeline models were busy or unavailable. Please try again in a few seconds." });
        }
        throw err;
      }

      const questions = result.quizBlueprint.questions;
      const attemptData: any = {
        stepId: step.id,
        userId,
        status: "in_progress",
        questionCount: questions.length,
        acuBreakdown: result.acus.map((a) => a.label) as any,
        questions: questions as any,
      };

      const newAttempt = await prisma.quizAttempt.create({
        data: attemptData,
      });

      // Student-safe payload: NO correct answers or distractor explanations
      const studentSafeQuestions = questions.map((q) => ({
        id: q.id,
        acuId: q.acuId,
        scenario: q.scenario,
        question: q.question,
        options: q.options.map((opt) => opt.text),
      }));

      return reply.status(201).send({
        attemptId: newAttempt.id,
        questionCount: studentSafeQuestions.length,
        questions: studentSafeQuestions,
        passingScorePercent: Math.round(PASSING_THRESHOLD * 100),
      });
    } catch (err: any) {
      if (err?.code === "P2025") {
        return reply.status(404).send({ error: "Resource not found in database." });
      }
      fastify.log.error(err);
      return reply.status(500).send({ error: err.message || "Failed to generate quiz" });
    }
  });

  // 2. POST /api/steps/:stepId/submit-quiz — Score quiz server-side & record attempt
  fastify.post("/api/steps/:stepId/submit-quiz", async (request, reply) => {
    try {
      const paramsResult = promptQuizParamsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return reply.status(400).send({ error: "Invalid stepId parameter", details: paramsResult.error.flatten() });
      }

      const bodyResult = submitQuizBodySchema.safeParse(request.body);
      if (!bodyResult.success) {
        return reply.status(400).send({ error: "Invalid quiz submission body", details: bodyResult.error.flatten() });
      }

      const { stepId } = paramsResult.data;
      const { attemptId, answers } = bodyResult.data;
      const userId = ((request as any).userId as string) || "default_user";

      const attempt: any = await prisma.quizAttempt.findUnique({
        where: { id: attemptId },
      });

      if (!attempt) {
        return reply.status(404).send({ error: `Quiz attempt "${attemptId}" not found.` });
      }

      if (attempt.stepId !== stepId) {
        return reply.status(400).send({ error: "Quiz attempt does not belong to this step." });
      }

      if (attempt.userId && attempt.userId !== userId && userId !== "default_user") {
        return reply.status(403).send({ error: "Unauthorized access to quiz attempt." });
      }

      // IDEMPOTENCY: If already submitted, return previous score result
      if (attempt.status === "completed") {
        const previousResults = Array.isArray(attempt.results) ? attempt.results : JSON.parse(String(attempt.results) || "[]");
        return reply.send({
          attemptId: attempt.id,
          scorePercent: attempt.scorePercent,
          score: attempt.scorePercent,
          passed: attempt.passed,
          passingThresholdPercent: Math.round(PASSING_THRESHOLD * 100),
          correctCount: attempt.correctCount,
          totalQuestions: attempt.questionCount,
          diagnostic: previousResults,
        });
      }

      const storedQuestions: any[] = Array.isArray(attempt.questions)
        ? attempt.questions
        : JSON.parse(String(attempt.questions) || "[]");

      const answerMap = new Map<string, number>();
      for (const a of answers) {
        let index = -1;
        if (typeof a.selectedOptionId === "number") {
          index = a.selectedOptionId;
        } else if (typeof a.selectedOptionId === "string") {
          const mapKey: Record<string, number> = { A: 0, B: 1, C: 2, D: 3, a: 0, b: 1, c: 2, d: 3 };
          index = mapKey[a.selectedOptionId] !== undefined ? mapKey[a.selectedOptionId] : parseInt(a.selectedOptionId, 10);
        }
        answerMap.set(a.questionId, isNaN(index) ? -1 : index);
      }

      let correctCount = 0;
      const diagnosticResults: any[] = [];

      for (const q of storedQuestions) {
        const selectedIndex = answerMap.get(q.id) ?? -1;
        const correctIndex = typeof q.correctIndex === "number" ? q.correctIndex : 0;
        const isCorrect = selectedIndex === correctIndex;

        if (isCorrect) {
          correctCount++;
        }

        const optionsArray = Array.isArray(q.options)
          ? q.options.map((opt: any) => (typeof opt === "string" ? opt : opt.text))
          : [];

        const optionKeys = ["A", "B", "C", "D"];
        const selectedKey = optionKeys[selectedIndex] || String(selectedIndex);
        const correctKey = optionKeys[correctIndex] || String(correctIndex);

        const distractorExps = q.distractorExplanations || {};
        const whyWrong = distractorExps[selectedKey] || distractorExps[String(selectedIndex)] || "Selected option does not demonstrate competency.";

        diagnosticResults.push({
          questionId: q.id,
          acuId: q.acuId || "acu-1",
          question: q.question,
          isCorrect,
          chosenOption: optionsArray[selectedIndex] || "No Answer",
          correctOption: optionsArray[correctIndex] || "Correct Answer",
          whyWrong: isCorrect ? "Correct assessment application." : whyWrong,
        });
      }

      const totalQuestions = Math.max(storedQuestions.length, 1);
      const scoreFraction = correctCount / totalQuestions;
      const scorePercent = Math.round(scoreFraction * 100);
      const passed = scoreFraction >= PASSING_THRESHOLD;

      // Persist in Prisma Transaction
      const [updatedAttempt] = await prisma.$transaction([
        prisma.quizAttempt.update({
          where: { id: attemptId },
          data: {
            status: "completed",
            score: scorePercent,
            scorePercent,
            correctCount,
            passed,
            results: diagnosticResults as any,
            userAnswers: answers as any,
            completedAt: new Date(),
          } as any,
        }),
        ...(passed
          ? [
              prisma.skillStep.update({
                where: { id: stepId },
                data: { status: "PASSED" } as any,
              }),
            ]
          : []),
      ]);

      return reply.send({
        attemptId: updatedAttempt.id,
        scorePercent,
        score: scorePercent,
        passed,
        passingThresholdPercent: Math.round(PASSING_THRESHOLD * 100),
        correctCount,
        totalQuestions,
        diagnostic: diagnosticResults,
      });
    } catch (err: any) {
      if (err?.code === "P2025") {
        return reply.status(404).send({ error: "Record not found in database." });
      }
      fastify.log.error(err);
      return reply.status(500).send({ error: err.message || "Failed to submit quiz evaluation" });
    }
  });
};

export default quizzesRoutes;
