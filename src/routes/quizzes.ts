// skillprax-backend/src/routes/quizzes.ts

import { FastifyInstance, FastifyPluginAsync } from "fastify";
import prisma from "../lib/prisma";
import { synthesizeQuizFromMaterial, GroqConfigError } from "../lib/ai/pipeline";

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

// Normalize answers: accepts EITHER array of { questionId, selectedOptionId } OR dict { [questionId]: selectedOptionId }
interface NormalizedAnswer {
  questionId: string;
  selectedOptionId: string;
}

function normalizeAnswers(input: any): NormalizedAnswer[] {
  if (Array.isArray(input)) {
    return input.map((a: any) => ({
      questionId: String(a.questionId || a.id || ""),
      selectedOptionId: String(a.selectedOptionId || a.selectedOption || a.optionId || "").toUpperCase(),
    }));
  }
  if (typeof input === "object" && input !== null) {
    return Object.entries(input).map(([qId, optId]) => ({
      questionId: String(qId),
      selectedOptionId: String(optId).toUpperCase(),
    }));
  }
  return [];
}

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
  // ============================================================
  // 1. POST /api/steps/:stepId/prompt-quiz
  // ============================================================
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
      });

      if (!step) {
        return reply.status(404).send({ error: `SkillStep with ID "${cleanStepId}" was not found.` });
      }

      const acus = safeJsonParse(step.assessableUnits, []);
      const resources = safeJsonParse(step.resources, []);

      // ALWAYS generate a fresh, novel set of questions on every quiz launch or retake
      let freshQuestions: any[] = [];
      const groqKey = await getGroqApiKey().catch(() => null);

      if (groqKey && acus.length > 0) {
        try {
          const seed = Math.random().toString(36).substring(7);
          freshQuestions = await synthesizeQuizFromMaterial(
            acus,
            resources,
            groqKey,
            { seed, temperature: 0.8 } // Forces novelty in question generation
          );
        } catch (genErr) {
          fastify.log.warn(`[Quiz] Fresh quiz generation warning: ${(genErr as Error).message}`);
        }
      }

      // Fallback questions if Groq synthesis returned empty
      if (!freshQuestions || freshQuestions.length === 0) {
        const fallbackAcus = acus.length > 0 ? acus : [
          { id: "acu-1", label: "Core Principles", description: "Foundational step principles" },
        ];
        freshQuestions = fallbackAcus.map((acu: any, idx: number) => ({
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

      // Overwrite step blueprint with newly generated questions
      await prisma.skillStep.update({
        where: { id: step.id },
        data: {
          quizBlueprint: freshQuestions as any,
        },
      });

      // Create a new QuizAttempt record
      const newAttempt = await prisma.quizAttempt.create({
        data: {
          stepId: step.id,
          status: "in_progress",
          questionCount: freshQuestions.length,
          questions: freshQuestions as any,
          score: 0,
          passed: false,
        },
      });

      const studentSafeQuestions = formatStudentSafeQuestions(freshQuestions);

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

  // ============================================================
  // 2. POST /api/steps/:stepId/submit-quiz
  // ============================================================
  fastify.post("/api/steps/:stepId/submit-quiz", async (request, reply) => {
    try {
      const { stepId } = request.params as { stepId: string };
      const cleanStepId = (stepId || "").trim();

      if (!cleanStepId || (!CUID_REGEX.test(cleanStepId) && cleanStepId.length < 5)) {
        return reply.status(400).send({ error: `Invalid stepId "${stepId}".` });
      }

      const step: any = await prisma.skillStep.findUnique({
        where: { id: cleanStepId },
      });

      if (!step) {
        return reply.status(404).send({ error: `SkillStep with ID "${cleanStepId}" was not found.` });
      }

      const body: any = request.body || {};
      const attemptId = String(body.attemptId || "").trim();

      let attempt: any = null;
      if (attemptId) {
        attempt = await prisma.quizAttempt.findUnique({
          where: { id: attemptId },
        });
      }

      // If attempt is already completed, return existing result payload
      if (attempt && attempt.status === "completed") {
        const previousResults = safeJsonParse(attempt.results, []);
        const prevScore = attempt.score ?? attempt.scorePercent ?? 0;
        const prevPassed = attempt.passed ?? false;
        return reply.status(200).send({
          attemptId: attempt.id,
          score: prevScore,
          passed: prevPassed,
          passingThreshold: 80,
          totalQuestions: attempt.questionCount,
          correctCount: attempt.correctCount,
          results: previousResults,
          evaluation: {
            score: prevScore,
            passed: prevPassed,
            results: previousResults,
          },
        });
      }

      // Parse blueprint defensively
      let rawBlueprint: any[] = [];
      try {
        rawBlueprint = Array.isArray(step.quizBlueprint)
          ? step.quizBlueprint
          : JSON.parse(step.quizBlueprint || "[]");
      } catch (_) {
        rawBlueprint = safeJsonParse(step.quizBlueprint, []);
      }

      if ((!rawBlueprint || rawBlueprint.length === 0) && attempt?.questions) {
        rawBlueprint = safeJsonParse(attempt.questions, []);
      }

      const rawAnswers = body.answers !== undefined ? body.answers : body;
      const normalizedAnswers = normalizeAnswers(rawAnswers);

      let correctCount = 0;
      const results = rawBlueprint.map((q: any) => {
        const qId = String(q.id);
        const userAns = normalizedAnswers.find((a: any) => String(a.questionId) === qId);
        const chosenOptionId = userAns ? String(userAns.selectedOptionId) : null;
        const correctOptionId = String(q.correctOptionId);
        const isCorrect = Boolean(chosenOptionId && chosenOptionId.toUpperCase() === correctOptionId.toUpperCase());

        if (isCorrect) correctCount++;

        let whyWrong: string | null = null;
        if (!isCorrect && chosenOptionId) {
          whyWrong =
            q.distractorExplanations?.[chosenOptionId] ||
            q.distractorExplanations?.[chosenOptionId.toUpperCase()] ||
            q.distractorAnalysis?.[chosenOptionId] ||
            `Selected option ${chosenOptionId} fails to resolve the scenario's constraint.`;
        }

        return {
          questionId: qId,
          scenario: q.scenario || q.question || "Scenario assessment",
          chosenOptionId,
          correctOptionId,
          isCorrect,
          whyWrong,
        };
      });

      const totalQuestions = Math.max(rawBlueprint.length, 1);
      const score = Math.round((correctCount / totalQuestions) * 100);
      const passed = score >= 80;

      const targetAttemptId = attempt?.id || attemptId;

      const transactionOps: any[] = [];
      if (targetAttemptId && attempt) {
        transactionOps.push(
          prisma.quizAttempt.update({
            where: { id: targetAttemptId },
            data: {
              status: "completed",
              score,
              scorePercent: score,
              correctCount,
              passed,
              results: results as any,
              userAnswers: normalizedAnswers as any,
              completedAt: new Date(),
            },
          })
        );
      } else {
        const createdAttempt = await prisma.quizAttempt.create({
          data: {
            stepId: step.id,
            status: "completed",
            questionCount: rawBlueprint.length,
            questions: rawBlueprint as any,
            score,
            scorePercent: score,
            correctCount,
            passed,
            results: results as any,
            userAnswers: normalizedAnswers as any,
            completedAt: new Date(),
          },
        });
        attempt = createdAttempt;
      }

      if (passed) {
        transactionOps.push(
          prisma.skillStep.update({
            where: { id: step.id },
            data: { status: "PASSED" },
          })
        );
      }

      if (transactionOps.length > 0) {
        await prisma.$transaction(transactionOps);
      }

      const finalAttemptId = attempt?.id || targetAttemptId || cleanStepId;

      return reply.status(200).send({
        attemptId: finalAttemptId,
        score,
        passed,
        passingThreshold: 80,
        totalQuestions,
        correctCount,
        results,
        evaluation: {
          score,
          passed,
          results,
        },
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
