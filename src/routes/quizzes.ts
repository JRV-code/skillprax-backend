import { FastifyInstance, FastifyPluginAsync } from "fastify";
import prisma from "../lib/prisma";
import { callGroqWithFallback, synthesizeTargetedRemediation, FailedQuestionContext, ACU, CuratedResource } from "../lib/ai/pipeline";

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
  // Common handler for quiz generation
  const generateStepQuizHandler = async (req: any, reply: any) => {
    const { stepId } = req.params as { stepId: string };
    const { aiEngine, retestMode, focusAcus, priorityAcus } = (req.body || {}) as {
      aiEngine?: string;
      retestMode?: boolean;
      focusAcus?: string[];
      priorityAcus?: string[];
    };

    const targetFocusAcus = focusAcus || priorityAcus || [];

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

      // Build adaptive weighting directive for retest mode
      let weightingDirective = '';
      if (retestMode && Array.isArray(targetFocusAcus) && targetFocusAcus.length > 0) {
        const focusCount = Math.max(1, Math.round(dynamicQuestionCount * 0.7));
        const retentionCount = dynamicQuestionCount - focusCount;
        weightingDirective = `
ADAPTIVE RETEST MODE ACTIVE:
- Generate exactly ${focusCount} questions (70%) targeting these DEFICIENT ACU IDs/topics: ${JSON.stringify(targetFocusAcus)}.
- Generate exactly ${retentionCount} questions (30%) as retention checks on OTHER ACUs not in the focus list.
- All questions MUST be completely novel — never reuse scenarios or phrasing from prior evaluations.
- Prioritize testing the specific misconceptions that caused prior failure.`;
      }

      const systemPrompt = `You are a strict competency evaluator. Generate an evaluation of exactly ${dynamicQuestionCount} high-friction scenario-based multiple-choice questions for "${step.title}".
Entropy seed: ${entropySeed}. Ensure questions are 100% unique, scenario-focused, and never repetitive.
${weightingDirective}

STRICT DISTRACTOR EQUALITY RULES:
1. All 4 options (A, B, C, D) MUST have comparable word counts (within ±15% of each other).
2. NEVER make the correct option noticeably longer or more detailed than distractors.
3. Every distractor must be a sophisticated, realistic misconception.

Output strictly valid JSON with no markdown formatting:
{
  "questions": [
    {
      "id": "q1",
      "acuId": "acu-N",
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
          acuId: q.acuId || null,
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
        prompt: q.scenario || q.prompt || q.question || 'Scenario Evaluation',
        options: q.options,
        acuId: q.acuId || null,
      }));

      return reply.send({
        attemptId: attempt.id,
        questions: sanitizedQuestions,
        questionCount: sanitizedQuestions.length,
        passingThreshold: 0.8
      });
    } catch (err) {
      fastify.log.error(err, '[QuizGeneration] Failed');
      return reply.status(500).send({ error: 'Quiz generation failed' });
    }
  };

  // POST /api/steps/:stepId/prompt-quiz
  fastify.post('/api/steps/:stepId/prompt-quiz', generateStepQuizHandler);
  // POST /api/steps/:stepId/level-up-quiz
  fastify.post('/api/steps/:stepId/level-up-quiz', generateStepQuizHandler);

  // POST /api/steps/:stepId/submit-quiz (Evaluation route)
  fastify.post('/api/steps/:stepId/submit-quiz', async (req, reply) => {
    const { stepId } = req.params as { stepId: string };
    const { attemptId, answers } = (req.body || {}) as { attemptId?: string; answers: any };

    try {
      const step = await prisma.skillStep.findUnique({
        where: { id: stepId },
        include: { workspace: true },
      });
      if (!step) return reply.status(404).send({ error: 'Step not found' });

      let targetAttemptId = attemptId;
      if (!targetAttemptId) {
        const latestAttempt = await prisma.quizAttempt.findFirst({
          where: { stepId: step.id },
          orderBy: { createdAt: 'desc' },
        });
        targetAttemptId = latestAttempt?.id;
      }

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

        // Resolve option text for diagnostic enrichment
        const chosenOptionText = chosenOptionId && Array.isArray(q.options)
          ? q.options.find((o: any) => String(o.id).toUpperCase() === chosenOptionId)?.text || `Option ${chosenOptionId}`
          : null;
        const correctOptionText = Array.isArray(q.options)
          ? q.options.find((o: any) => String(o.id).toUpperCase() === correctOptionId)?.text || `Option ${correctOptionId}`
          : `Option ${correctOptionId}`;

        return {
          questionId: q.id,
          scenario: q.scenario,
          chosenOptionId,
          correctOptionId,
          chosenOptionText,
          correctOptionText,
          isCorrect,
          whyWrong: !isCorrect && chosenOptionId ? q.distractorExplanations?.[chosenOptionId] || 'Fails scenario constraints.' : null,
          acuId: q.acuId || null,
        };
      });

      const total = Math.max(blueprint.length, 1);
      const score = Math.round((correctCount / total) * 100);
      const passed = score >= 80;

      if (targetAttemptId) {
        await prisma.$transaction([
          prisma.quizAttempt.update({
            where: { id: targetAttemptId },
            data: { score, scorePercent: score, correctCount, passed, status: "completed", results: results as any, userAnswers: normalizedAnswers as any, completedAt: new Date() },
          }),
          prisma.skillStep.update({
            where: { id: step.id },
            data: { status: passed ? 'PASSED' : 'FAILED_REMEDIATION' },
          }),
        ]);
      } else {
        await prisma.skillStep.update({
          where: { id: step.id },
          data: { status: passed ? 'PASSED' : 'FAILED_REMEDIATION' },
        });
      }

      // On failure: trigger targeted weakness diagnostic & remediation
      let diagnosticPrescription = null;
      if (!passed) {
        try {
          const failedQuestions: FailedQuestionContext[] = results
            .filter((r: any) => !r.isCorrect)
            .map((r: any) => ({
              questionId: r.questionId,
              scenario: r.scenario,
              chosenOptionId: r.chosenOptionId,
              correctOptionId: r.correctOptionId,
              chosenOptionText: r.chosenOptionText,
              correctOptionText: r.correctOptionText,
              whyWrong: r.whyWrong,
              acuId: r.acuId,
            }));

          // Parse step ACUs and resources
          const acusRaw = step.assessableUnits;
          const acus: ACU[] = Array.isArray(acusRaw)
            ? acusRaw as unknown as ACU[]
            : typeof acusRaw === 'string'
              ? JSON.parse(acusRaw || '[]')
              : [];

          const resourcesRaw = step.resources;
          const resources: CuratedResource[] = Array.isArray(resourcesRaw)
            ? resourcesRaw as unknown as CuratedResource[]
            : typeof resourcesRaw === 'string'
              ? JSON.parse(resourcesRaw || '[]')
              : [];

          // Retrieve Groq key
          let config = await prisma.adminConfig.findUnique({ where: { id: "global" } });
          if (!config) config = await prisma.adminConfig.findFirst();
          const groqKey = config?.groqApiKey || config?.groqKey || process.env.GROQ_API_KEY;

          const domainCategory = step.workspace?.domainCategory || 'General Knowledge';

          diagnosticPrescription = await synthesizeTargetedRemediation(
            step.title,
            domainCategory,
            failedQuestions,
            acus,
            resources,
            groqKey || undefined
          );
        } catch (diagnosticErr) {
          fastify.log.warn(diagnosticErr, '[SubmitQuiz] Targeted remediation synthesis failed; returning results without prescription.');
        }
      }

      return reply.send({
        attemptId: targetAttemptId,
        score,
        scorePercentage: score,
        passed,
        passingThreshold: 80,
        totalQuestions: total,
        correctCount,
        results,
        ...(diagnosticPrescription ? { diagnosticPrescription } : {}),
      });
    } catch (err) {
      fastify.log.error(err, '[SubmitQuiz] Failed');
      return reply.status(500).send({ error: 'Evaluation failed' });
    }
  });
};

export default quizzesRoutes;
