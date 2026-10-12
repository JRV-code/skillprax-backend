import { FastifyInstance, FastifyPluginAsync } from "fastify";
import prisma from "../lib/prisma";
import { callGroqWithFallback } from "../lib/ai/pipeline";
import { searchTavilyRemediation, SearchResultItem } from "../services/search";
import { synthesizeTargetedRemediationWithTavily } from "../services/ai";

// Fisher-Yates array shuffle helper
function shuffleArray<T>(array: T[]): T[] {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function safeJsonParse(str: any, fallback: any = []): any {
  if (typeof str !== "string") return str || fallback;
  try {
    return JSON.parse(str);
  } catch (_) {
    return fallback;
  }
}

const quizzesRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // Common handler for quiz generation
  const generateStepQuizHandler = async (req: any, reply: any) => {
    const { stepId } = req.params as { stepId: string };
    const { aiEngine, retestMode, focusAcus, priorityAcus, perfectionMode, failedQuestionIds } = (req.body || {}) as {
      aiEngine?: string;
      retestMode?: boolean;
      focusAcus?: string[];
      priorityAcus?: string[];
      perfectionMode?: boolean;
      failedQuestionIds?: string[];
    };

    const targetFocusAcus = focusAcus || priorityAcus || [];
    const isPerfection = Boolean(perfectionMode);

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

      // Dynamic question scaling: 8 to 12 scenario questions in standard mode, 2 to 4 in perfection mode
      const dynamicQuestionCount = isPerfection
        ? Math.min(4, Math.max(2, targetFocusAcus.length || 3))
        : Math.min(12, Math.max(8, Math.round((acus.length * 2.5) || 8)));

      const entropySeed = Math.random().toString(36).substring(7);

      // Mode-specific directives
      let modeDirective = '';
      if (isPerfection) {
        modeDirective = `
TARGETED PERFECTION DRILL (100% MASTERY TARGET):
- Generate exactly ${dynamicQuestionCount} high-precision scenario questions.
- Focus exclusively on the concepts missed in prior attempt: ${JSON.stringify(targetFocusAcus)}.
- Verify that previous misconception traps have been completely resolved.`;
      } else if (retestMode && Array.isArray(targetFocusAcus) && targetFocusAcus.length > 0) {
        const focusCount = Math.max(1, Math.round(dynamicQuestionCount * 0.7));
        const retentionCount = dynamicQuestionCount - focusCount;
        modeDirective = `
ADAPTIVE RETEST MODE ACTIVE:
- Generate exactly ${focusCount} questions (70%) targeting these DEFICIENT ACU IDs/topics: ${JSON.stringify(targetFocusAcus)}.
- Generate exactly ${retentionCount} questions (30%) as retention checks on OTHER ACUs not in the focus list.
- All questions MUST be completely novel — never reuse scenarios or phrasing from prior evaluations.
- Prioritize testing the specific misconceptions that caused prior failure.`;
      }

      const resourcesRaw = step.resources;
      const stepResources: any[] = Array.isArray(resourcesRaw) ? resourcesRaw : safeJsonParse(resourcesRaw as string, []);

      // Format the curated curriculum that the student actually studied
      const resourceContext = stepResources.length > 0
        ? stepResources.map((r: any) => `• [${r.badge || r.type || 'Resource'}] "${r.title}": ${r.studyGuidance || r.takeaway || r.subtitle || 'Assigned study material'}`).join('\n')
        : 'Foundational first-principles for this domain.';

      const systemPrompt = `You are the SKILL-TRACK Pedagogy & Curriculum Engine (v2.6) Socratic Evaluation Architect.
Milestone: "Step ${step.stepIndex} of ${step.workspace?.totalPlannedSteps || 5} - ${step.title}".
Entropy seed: ${entropySeed}. Ensure questions are 100% unique, scenario-focused, and never repetitive.

ASSIGNED STUDY CURRICULUM (Researched via Tavily & Curated for this Step):
${resourceContext}

ASSESSABLE COMPETENCY UNITS (ACUs to Test):
${acus.map((a: any) => `- [ID: ${a.id || a.acuId || 'acu-1'}] ${a.label || a.title || 'ACU'}: ${a.description || 'Description'}`).join('\n')}

${modeDirective}

CRITICAL GROUNDING DIRECTIVES:
1. Generate EXACTLY ${dynamicQuestionCount} scenario-grounded challenge questions.
2. Every scenario challenge MUST directly assess concepts, principles, takeaways, or edge cases from the ASSIGNED STUDY CURRICULUM and the ACUs.
3. EQUAL LENGTH RULE (MANDATORY): All 4 choices (A, B, C, D) for EVERY question MUST have strictly comparable sentence length and character counts (within ±10%). The correct answer must NOT be conspicuously longer or more detailed than the distractors.
4. Place the correct option at a completely RANDOM position (A, B, C, or D). DO NOT always place the correct answer as option A.
5. Provide specific diagnostic explanations for EVERY option (A, B, C, D) detailing why that option is correct or what specific misconception trap it represents.

Output strictly valid JSON with no markdown formatting:
{
  "questions": [
    {
      "id": "q1",
      "acuId": "${acus[0]?.id || 'acu-1'}",
      "scenario": "A scenario challenge grounded strictly in the assigned study curriculum...",
      "rawCorrectText": "The exact correct technical explanation",
      "correctExplanation": "First-principles verification based on assigned resources.",
      "rawDistractors": [
        { "text": "Balanced length wrong option 1", "whyWrong": "Specific misconception trap analysis..." },
        { "text": "Balanced length wrong option 2", "whyWrong": "Specific misconception trap analysis..." },
        { "text": "Balanced length wrong option 3", "whyWrong": "Specific misconception trap analysis..." }
      ]
    }
  ]
}`;

      const aiResponse = await callGroqWithFallback(
        [{ role: 'system', content: systemPrompt }, { role: 'user', content: `Generate ${dynamicQuestionCount} Socratic questions for ${step.title}` }],
        { apiKey: groqKey, jsonMode: true, model: aiEngine || step.workspace?.aiEngine || 'llama-3.3-70b-versatile', temperature: 0.85 }
      );

      let cleaned = aiResponse.content.trim().replace(/^```json\s*/i, '').replace(/\s*```$/, '');
      const parsed = JSON.parse(cleaned);

      // Randomize option order (A, B, C, D) so correct answer position is completely random
      const keys = ['A', 'B', 'C', 'D'];
      const finalizedBlueprint = (parsed.questions || []).map((q: any, qIdx: number) => {
        const optionPool = [
          { text: q.rawCorrectText, isCorrect: true, whyWrong: null, explanation: q.correctExplanation || 'Correct technical explanation based on step resources.' },
          ...(q.rawDistractors || []).map((d: any) => ({ text: d.text || d, isCorrect: false, whyWrong: d.whyWrong || 'Incorrect option', explanation: d.whyWrong || 'Incorrect option' })),
        ];

        const shuffled = shuffleArray(optionPool);
        const options: Array<{ id: string; text: string; explanation?: string }> = [];
        let correctOptionId = 'A';
        const distractorExplanations: Record<string, string> = {};
        const optionExplanations: Record<string, string> = {};

        shuffled.forEach((opt, idx) => {
          const key = keys[idx];
          options.push({ id: key, text: opt.text });
          optionExplanations[key] = opt.explanation || (opt.isCorrect ? 'Correct explanation' : 'Incorrect option');
          if (opt.isCorrect) {
            correctOptionId = key;
          } else if (opt.whyWrong) {
            distractorExplanations[key] = opt.whyWrong;
          }
        });

        return {
          id: `q_${qIdx + 1}_${entropySeed}`,
          acuId: q.acuId || null,
          scenario: q.scenario || q.question || 'Evaluation Scenario',
          options,
          correctOptionId,
          distractorExplanations,
          optionExplanations,
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
        passingThreshold: 0.70,
        isPerfectionMode: isPerfection,
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

  // POST /api/steps/:stepId/submit-quiz (Evaluation route - 70% Mastery Gate)
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

      // 75% STRICT SOCRATIC MASTERY THRESHOLD
      const passed = score >= 75;

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

      // On failure or score < 100%: isolate weak ACUs for targeted review / perfection mode
      let diagnosticPrescription = null;
      if (!passed || score < 100) {
        try {
          const acusRaw = step.assessableUnits;
          const acus: any[] = Array.isArray(acusRaw)
            ? acusRaw
            : typeof acusRaw === 'string'
              ? JSON.parse(acusRaw || '[]')
              : [];

          const failedItems = results
            .filter((r: any) => !r.isCorrect)
            .map((r: any) => {
              const matchedAcu = acus.find((a: any) => a.id === r.acuId);
              const acuTitle = matchedAcu?.label || matchedAcu?.title || r.acuId || 'Competency Gap';
              return {
                prompt: r.scenario || 'Scenario Evaluation',
                userOption: r.chosenOptionText || `Option ${r.chosenOptionId}`,
                correctOption: r.correctOptionText || `Option ${r.correctOptionId}`,
                acuTitle,
              };
            });

          if (failedItems.length > 0) {
            const uniqueWeakTopics: string[] = Array.from(new Set(failedItems.map((f: any) => String(f.acuTitle))));

            const tavilyResultsPerTopic: Record<string, SearchResultItem[]> = {};
            await Promise.all(
              uniqueWeakTopics.map(async (topic: string) => {
                const relatedFail = failedItems.find((f: any) => String(f.acuTitle) === topic);
                const searchResults = await searchTavilyRemediation(
                  step.workspace?.title || step.title,
                  topic,
                  relatedFail?.userOption || ''
                );
                tavilyResultsPerTopic[topic] = searchResults;
              })
            );

            diagnosticPrescription = await synthesizeTargetedRemediationWithTavily(
              step.title,
              failedItems,
              tavilyResultsPerTopic
            );
          }
        } catch (diagnosticErr) {
          fastify.log.warn(diagnosticErr, '[SubmitQuiz] Zero-hallucination Tavily remediation synthesis failed; returning results without prescription.');
        }
      }

      let unlockedNextStepId: string | null = null;
      let xpEarned = 0;
      let isFinalStep = false;
      let nextStepIndex: number | null = null;
      let workspaceProgress = 0;

      if (passed) {
        // Fetch all steps for this workspace
        const allWorkspaceSteps = await prisma.skillStep.findMany({
          where: { workspaceId: step.workspaceId },
          orderBy: { stepIndex: 'asc' },
        });

        const totalSteps = Math.max(allWorkspaceSteps.length, 1);
        const nextStep = allWorkspaceSteps.find((s) => s.stepIndex === step.stepIndex + 1);
        isFinalStep = step.stepIndex === totalSteps || !nextStep;

        if (nextStep && (nextStep.status === 'LOCKED' || nextStep.status === 'IN_PROGRESS')) {
          const updatedNext = await prisma.skillStep.update({
            where: { id: nextStep.id },
            data: { status: 'STUDY_UNGENERATED' },
          });
          unlockedNextStepId = updatedNext.id;
          nextStepIndex = nextStep.stepIndex;
        }

        // Calculate scaled XP: 500 XP * stepIndex + 1000 XP Grandmaster bonus if 100% + 1000 XP final track bonus
        const grandmasterBonus = score === 100 ? 1000 : 0;
        const completionBonus = isFinalStep ? 1000 : 0;
        xpEarned = step.stepIndex * 500 + grandmasterBonus + completionBonus;

        const passedCount = allWorkspaceSteps.filter((s) => s.status === 'PASSED').length + 1;
        workspaceProgress = Math.min(100, Math.round((passedCount / totalSteps) * 100));

        await (prisma.workspace as any).update({
          where: { id: step.workspaceId },
          data: { progress: workspaceProgress },
        });

        if (step.workspace?.userProfileId) {
          try {
            await (prisma.userProfile as any).update({
              where: { id: step.workspace.userProfileId },
              data: { totalXp: { increment: xpEarned } },
            });
          } catch (_) {
            try {
              await (prisma as any).profile?.update({
                where: { id: step.workspace.userProfileId },
                data: { totalXp: { increment: xpEarned } },
              });
            } catch (e) {}
          }
        }
      }

      return reply.send({
        attemptId: targetAttemptId,
        score,
        scorePercentage: score,
        passed,
        passingThreshold: 75,
        totalQuestions: total,
        correctCount,
        results,
        xpEarned,
        isFinalStep,
        nextStepIndex,
        unlockedNextStepId,
        workspaceProgress,
        ...(diagnosticPrescription ? { diagnosticPrescription } : {}),
      });
    } catch (err) {
      fastify.log.error(err, '[SubmitQuiz] Failed');
      return reply.status(500).send({ error: 'Evaluation failed' });
    }
  });
};

export default quizzesRoutes;
