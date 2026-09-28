import { FastifyInstance, FastifyPluginAsync } from "fastify";
import prisma from "../lib/prisma";
import { callGroqWithFallback } from "../lib/ai/pipeline";

// Fisher-Yates array shuffle helper
function shuffleArray<T>(array: T[]): T[] {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const quizzesRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // POST /api/steps/:stepId/prompt-quiz - On-demand, unique, randomized evaluation
  fastify.post('/api/steps/:stepId/prompt-quiz', async (req, reply) => {
    const { stepId } = req.params as { stepId: string };
    const { aiEngine } = (req.body || {}) as { aiEngine?: string };

    try {
      const step = await prisma.skillStep.findUnique({
        where: { id: stepId },
        include: { workspace: true },
      });

      if (!step) return reply.status(404).send({ error: 'Step not found' });

      let config = await prisma.adminConfig.findUnique({ where: { id: "global" } });
      if (!config) config = await prisma.adminConfig.findFirst();
      const groqKey = config?.groqApiKey || config?.groqKey || process.env.GROQ_API_KEY;

      if (!groqKey) return reply.status(500).send({ error: 'Inference key missing' });

      const acusRaw = step.assessableUnits;
      const acus = Array.isArray(acusRaw) ? acusRaw : (typeof acusRaw === 'string' ? JSON.parse(acusRaw || '[]') : []);

      // Determine dynamic question count based on ACU complexity (3 to 6 questions)
      const dynamicQuestionCount = Math.min(6, Math.max(3, acus.length || 4));
      const entropySeed = Math.random().toString(36).substring(7);

      const systemPrompt = `You are a strict competency evaluator. Generate an evaluation of exactly ${dynamicQuestionCount} high-friction scenario-based multiple-choice questions for "${step.title}".
Entropy seed: ${entropySeed}. Ensure questions are 100% unique, scenario-focused, and never repetitive.

Output strictly valid JSON with no markdown formatting:
{
  "questions": [
    {
      "id": "q1",
      "scenario": "A realistic real-world problem statement...",
      "rawCorrectText": "The exact correct technical explanation",
      "rawDistractors": [
        { "text": "Plausible wrong option 1", "whyWrong": "Specific misconception analysis..." },
        { "text": "Plausible wrong option 2", "whyWrong": "Specific misconception analysis..." },
        { "text": "Plausible wrong option 3", "whyWrong": "Specific misconception analysis..." }
      ]
    }
  ]
}`;

      const aiResponse = await callGroqWithFallback(
        [{ role: 'system', content: systemPrompt }, { role: 'user', content: `Material ACUs: ${JSON.stringify(acus)}` }],
        { apiKey: groqKey, jsonMode: true, model: aiEngine || step.workspace?.aiEngine || 'llama-3.3-70b-versatile', temperature: 0.85 }
      );

      let cleaned = aiResponse.content.trim().replace(/^```json\s*/i, '').replace(/\s*```$/, '');
      const parsed = JSON.parse(cleaned);

      // Randomize option order (A, B, C, D) so correct answer is NOT consistently "A"
      const keys = ['A', 'B', 'C', 'D'];
      const finalizedBlueprint = (parsed.questions || []).map((q: any, qIdx: number) => {
        const optionPool = [
          { text: q.rawCorrectText, isCorrect: true, whyWrong: null },
          ...(q.rawDistractors || []).map((d: any) => ({ text: d.text || d, isCorrect: false, whyWrong: d.whyWrong || 'Incorrect option' })),
        ];

        const shuffled = shuffleArray(optionPool);
        const options: Array<{ id: string; text: string }> = [];
        let correctOptionId = 'A';
        const distractorExplanations: Record<string, string> = {};

        shuffled.forEach((opt, idx) => {
          const key = keys[idx];
          options.push({ id: key, text: opt.text });
          if (opt.isCorrect) correctOptionId = key;
          else if (opt.whyWrong) distractorExplanations[key] = opt.whyWrong;
        });

        return {
          id: `q_${qIdx + 1}_${entropySeed}`,
          scenario: q.scenario || q.question || 'Evaluation Scenario',
          options,
          correctOptionId,
          distractorExplanations,
        };
      });

      await prisma.skillStep.update({
        where: { id: step.id },
        data: {
          quizBlueprint: finalizedBlueprint as any,
          questionCount: finalizedBlueprint.length,
        },
      });

      const attempt = await prisma.quizAttempt.create({
        data: { stepId: step.id, score: 0, passed: false, questionCount: finalizedBlueprint.length, status: "in_progress", questions: finalizedBlueprint as any },
      });

      const sanitizedQuestions = finalizedBlueprint.map((q: any) => ({
        id: q.id,
        scenario: q.scenario,
        options: q.options,
      }));

      return reply.send({
        attemptId: attempt.id,
        questions: sanitizedQuestions,
        questionCount: sanitizedQuestions.length,
        passingThreshold: 0.8
      });
    } catch (err) {
      fastify.log.error(err, '[PromptQuiz] Failed');
      return reply.status(500).send({ error: 'Quiz generation failed' });
    }
  });

  // POST /api/steps/:stepId/submit-quiz (Evaluation route)
  fastify.post('/api/steps/:stepId/submit-quiz', async (req, reply) => {
    const { stepId } = req.params as { stepId: string };
    const { attemptId, answers } = (req.body || {}) as { attemptId: string; answers: any };

    try {
      const step = await prisma.skillStep.findUnique({ where: { id: stepId } });
      if (!step) return reply.status(404).send({ error: 'Step not found' });

      const blueprintRaw = step.quizBlueprint;
      const blueprint = Array.isArray(blueprintRaw) ? blueprintRaw : JSON.parse((blueprintRaw as string) || '[]');

      let correctCount = 0;
      const normalizedAnswers = Array.isArray(answers) ? answers : (
        typeof answers === 'object' && answers !== null ? Object.entries(answers).map(([questionId, selectedOptionId]) => ({ questionId, selectedOptionId })) : []
      );

      const results = blueprint.map((q: any) => {
        const userAns = normalizedAnswers.find((a: any) => String(a.questionId) === String(q.id));
        const chosenOptionId = userAns ? String(userAns.selectedOptionId || userAns.selectedOption).toUpperCase() : null;
        const correctOptionId = String(q.correctOptionId).toUpperCase();
        const isCorrect = chosenOptionId === correctOptionId;

        if (isCorrect) correctCount++;

        return {
          questionId: q.id,
          scenario: q.scenario,
          chosenOptionId,
          correctOptionId,
          isCorrect,
          whyWrong: !isCorrect && chosenOptionId ? q.distractorExplanations?.[chosenOptionId] || 'Fails scenario constraints.' : null,
        };
      });

      const total = Math.max(blueprint.length, 1);
      const score = Math.round((correctCount / total) * 100);
      const passed = score >= 80;

      await prisma.$transaction([
        prisma.quizAttempt.update({
          where: { id: attemptId },
          data: { score, scorePercent: score, correctCount, passed, status: "completed", results: results as any, userAnswers: normalizedAnswers as any, completedAt: new Date() },
        }),
        ...(passed ? [prisma.skillStep.update({ where: { id: step.id }, data: { status: 'PASSED' } })] : []),
      ]);

      return reply.send({
        attemptId,
        score,
        passed,
        passingThreshold: 80,
        totalQuestions: total,
        correctCount,
        results,
      });
    } catch (err) {
      fastify.log.error(err, '[SubmitQuiz] Failed');
      return reply.status(500).send({ error: 'Evaluation failed' });
    }
  });
};

export default quizzesRoutes;
