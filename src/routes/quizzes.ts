// skillprax-backend/src/routes/quizzes.ts

import { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import prisma from "../lib/prisma";
import { generateQuizBlueprint, GroqConfigError } from "../lib/ai/pipeline";

export const PASSING_THRESHOLD = 0.8; // 80% passing threshold
const ADMIN_CONFIG_ID = "global";

const CUID_REGEX = /^[a-z0-9_-]{20,32}$/i;

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

function formatStudentSafeQuestions(questions: any[]): any[] {
  if (!Array.isArray(questions)) return [];
  return questions.map((q: any) => ({
    id: q.id,
    acuId: q.acuId || "acu-1",
    scenario: q.scenario || "",
    question: q.question || "",
    options: Array.isArray(q.options)
      ? q.options.map((opt: any, idx: number) => {
          if (typeof opt === "string") {
            const keys = ["A", "B", "C", "D"];
            return { id: keys[idx] || String(idx), text: opt };
          }
          return { id: String(opt.id || opt.key || "A"), text: String(opt.text || "") };
        })
      : [],
  }));
}

const quizzesRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // 1. POST /api/steps/:stepId/prompt-quiz — Generate or retrieve active quiz attempt
  fastify.post("/api/steps/:stepId/prompt-quiz", async (request, reply) => {
    try {
      const { stepId } = request.params as { stepId: string };
      const cleanStepId = (stepId || "").trim();

      if (!cleanStepId || (!CUID_REGEX.test(cleanStepId) && cleanStepId.length < 5)) {
        return reply.status(400).send({
          error: `Bad Request: Invalid or malformed stepId "${stepId}".`,
        });
      }

      const step: any = await prisma.skillStep.findUnique({
        where: { id: cleanStepId },
        include: { workspace: true },
      });

      if (!step) {
        return reply.status(404).send({ error: `SkillStep with ID "${cleanStepId}" was not found.` });
      }

      let storedBlueprint = safeJsonParse(step.quizBlueprint, []);

      // SELF-HEALING BLUEPRINT: If quizBlueprint is empty, generate on demand via Phase B
      if (storedBlueprint.length === 0) {
        fastify.log.info(`[Quiz] Blueprint empty for step "${cleanStepId}". Triggering Phase B auto-healing...`);
        try {
          const groqKey = await getGroqApiKey();
          const acus = safeJsonParse(step.assessableUnits, []);
          const takeaways = safeJsonParse(step.coreKeyTakeaways || step.keyTakeaways, []);

          const generatedQuestions = await generateQuizBlueprint(
            step.workspace?.title || step.title,
            step.title,
            acus,
            takeaways,
            groqKey
          );

          if (generatedQuestions.length > 0) {
            await prisma.skillStep.update({
              where: { id: cleanStepId },
              data: {
                quizBlueprint: generatedQuestions as any,
                questionCount: generatedQuestions.length,
              } as any,
            });
            storedBlueprint = generatedQuestions;
          }
        } catch (healErr) {
          fastify.log.warn(`[Quiz] Phase B auto-healing quiz blueprint failed: ${(healErr as Error).message}`);
        }
      }

      // IDEMPOTENCY: Check for existing unsubmitted QuizAttempt for this stepId
      const existingAttempt: any = await prisma.quizAttempt.findFirst({
        where: {
          stepId: cleanStepId,
          status: "in_progress",
        } as any,
        orderBy: { createdAt: "desc" },
      });

      if (existingAttempt && existingAttempt.questions) {
        const rawQuestions = safeJsonParse(existingAttempt.questions, []);
        if (rawQuestions.length > 0) {
          const studentSafeQuestions = formatStudentSafeQuestions(rawQuestions);
          return reply.send({
            attemptId: existingAttempt.id,
            passingThreshold: PASSING_THRESHOLD,
            passingScorePercent: Math.round(PASSING_THRESHOLD * 100),
            questionCount: studentSafeQuestions.length,
            questions: studentSafeQuestions,
          });
        }
      }

      // Fallback questions if blueprint is still empty
      if (storedBlueprint.length === 0) {
        const acus = safeJsonParse(step.assessableUnits, [
          { id: "acu-1", label: "Core Principles", description: "Foundational step principles" },
        ]);
        storedBlueprint = acus.map((acu: any, idx: number) => ({
          id: `q${idx + 1}`,
          acuId: acu.id || `acu-${idx + 1}`,
          scenario: `Evaluating competency in ${acu.label || "Principles"} for ${step.title}.`,
          question: `Which approach correctly addresses ${acu.description || acu.label}?`,
          options: [
            { id: "A", text: `Apply standard architectural validation for ${acu.label || "Core Principles"}.` },
            { id: "B", text: "Ignore system constraints during initialization." },
            { id: "C", text: "Bypass edge case handling in production handlers." },
            { id: "D", text: "Hardcode configuration values without environment flags." },
          ],
          correctOptionId: "A",
          distractorExplanations: {
            A: "Correct application of foundational principles.",
            B: "Ignoring constraints causes unhandled exceptions.",
            C: "Bypassing edge cases creates race conditions.",
            D: "Hardcoding values breaks portability.",
          },
        }));
      }

      const attemptData: any = {
        stepId: step.id,
        status: "in_progress",
        questionCount: storedBlueprint.length,
        questions: storedBlueprint as any,
      };

      const newAttempt = await prisma.quizAttempt.create({
        data: attemptData,
      });

      const studentSafeQuestions = formatStudentSafeQuestions(storedBlueprint);

      return reply.status(201).send({
        attemptId: newAttempt.id,
        passingThreshold: PASSING_THRESHOLD,
        passingScorePercent: Math.round(PASSING_THRESHOLD * 100),
        questionCount: studentSafeQuestions.length,
        questions: studentSafeQuestions,
      });
    } catch (err: any) {
      if (err?.code === "P2025") {
        return reply.status(404).send({ error: "Step not found in database." });
      }
      fastify.log.error(err);
      return reply.status(500).send({ error: err.message || "Failed to generate evaluation quiz" });
    }
  });

  // 2. POST /api/steps/:stepId/submit-quiz — Score quiz server-side & record attempt
  fastify.post("/api/steps/:stepId/submit-quiz", async (request, reply) => {
    try {
      const { stepId } = request.params as { stepId: string };
      const cleanStepId = (stepId || "").trim();

      if (!cleanStepId) {
        return reply.status(400).send({ error: "Invalid stepId parameter" });
      }

      const body: any = request.body || {};
      const attemptId = String(body.attemptId || "").trim();

      if (!attemptId || (!CUID_REGEX.test(attemptId) && attemptId.length < 5)) {
        return reply.status(400).send({ error: `Invalid or malformed attemptId "${attemptId}".` });
      }

      // NORMALIZE ANSWERS: Accept array of { questionId, selectedOptionId } OR dictionary { [questionId]: selectedOptionId }
      let answersArray: Array<{ questionId: string; selectedOptionId: string }> = [];
      if (Array.isArray(body.answers)) {
        answersArray = body.answers.map((a: any) => ({
          questionId: String(a.questionId || a.id),
          selectedOptionId: String(a.selectedOptionId || a.selectedOption || a.optionId || "").toUpperCase(),
        }));
      } else if (typeof body.answers === "object" && body.answers !== null) {
        answersArray = Object.entries(body.answers).map(([qId, optId]) => ({
          questionId: String(qId),
          selectedOptionId: String(optId).toUpperCase(),
        }));
      }

      const attempt: any = await prisma.quizAttempt.findUnique({
        where: { id: attemptId },
      });

      if (!attempt) {
        return reply.status(404).send({ error: `Quiz attempt "${attemptId}" not found.` });
      }

      if (attempt.stepId !== cleanStepId) {
        return reply.status(400).send({ error: "Quiz attempt does not belong to this step." });
      }

      // IDEMPOTENCY: If already submitted, return previous result
      if (attempt.status === "completed") {
        const previousResults = safeJsonParse(attempt.results, []);
        return reply.send({
          attemptId: attempt.id,
          scorePercent: attempt.scorePercent,
          score: attempt.scorePercent,
          passed: attempt.passed,
          passingThresholdPercent: Math.round(PASSING_THRESHOLD * 100),
          correctCount: attempt.correctCount,
          totalQuestions: attempt.questionCount,
          results: previousResults,
        });
      }

      const storedQuestions: any[] = safeJsonParse(attempt.questions, []);
      const answerMap = new Map<string, string>();
      for (const a of answersArray) {
        answerMap.set(a.questionId, a.selectedOptionId);
      }

      let correctCount = 0;
      const diagnosticResults: any[] = [];

      for (const q of storedQuestions) {
        const userChoiceKey = answerMap.get(q.id) || "NONE";
        const correctKey = String(q.correctOptionId || "A").toUpperCase();
        const isCorrect = userChoiceKey === correctKey;

        if (isCorrect) {
          correctCount++;
        }

        const optionsArray: Array<{ id: string; text: string }> = Array.isArray(q.options)
          ? q.options.map((opt: any, idx: number) => {
              if (typeof opt === "string") {
                const keys = ["A", "B", "C", "D"];
                return { id: keys[idx] || String(idx), text: opt };
              }
              return { id: String(opt.id || opt.key || "A"), text: String(opt.text || "") };
            })
          : [];

        const chosenOptObj = optionsArray.find((o) => o.id.toUpperCase() === userChoiceKey);
        const correctOptObj = optionsArray.find((o) => o.id.toUpperCase() === correctKey);

        const distractorExps = q.distractorExplanations || {};
        const whyWrong = distractorExps[userChoiceKey] || "Selected option does not demonstrate required ACU competency.";

        diagnosticResults.push({
          questionId: q.id,
          acuId: q.acuId || "acu-1",
          question: q.question,
          isCorrect,
          chosenOptionId: userChoiceKey,
          chosenOption: chosenOptObj ? chosenOptObj.text : "No Answer",
          correctOptionId: correctKey,
          correctOption: correctOptObj ? correctOptObj.text : "Correct Option",
          whyWrong: isCorrect ? "Correct application of competency." : whyWrong,
        });
      }

      const totalQuestions = Math.max(storedQuestions.length, 1);
      const scoreFraction = correctCount / totalQuestions;
      const scorePercent = Math.round(scoreFraction * 100);
      const passed = scoreFraction >= PASSING_THRESHOLD;

      // SINGLE PRISMA TRANSACTION: update attempt + update step status if passed
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
            userAnswers: answersArray as any,
            completedAt: new Date(),
          } as any,
        }),
        ...(passed
          ? [
              prisma.skillStep.update({
                where: { id: cleanStepId },
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
        results: diagnosticResults,
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
