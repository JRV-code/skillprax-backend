import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import prisma from '../lib/prisma';
import { LEARNING_CONFIG, calculatePersonalizedQuestionCount } from '../config/learning';
import {
  callGroqJson,
  searchTavily,
  extractYouTubeId,
  normalizeUrl,
  isSafePublicUrl,
  verifyLink,
  checkYouTube,
  assertNoUrls,
} from '../lib/foundation';

function shuffle<T>(a: T[]): T[] {
  const r = [...a];
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}

export function buildBalancedQuestions(raw: {
  acuId: string;
  question: string;
  correctAnswer: string;
  distractors: string[];
  explanation: string;
}[]) {
  const targets = shuffle(raw.map((_, i) => i % 4)); // as even as possible across A-D
  return raw.map((q, i) => {
    const options = shuffle(q.distractors).slice(0, 3).map((text) => ({ text, isCorrect: false }));
    options.splice(targets[i], 0, { text: q.correctAnswer, isCorrect: true });
    return {
      ...q,
      options: options.map((o, position) => ({
        id: ['A', 'B', 'C', 'D'][position],
        text: o.text,
        isCorrect: o.isCorrect,
        position,
      })),
      correctOptionId: ['A', 'B', 'C', 'D'][targets[i]],
    };
  });
}

function wordsCount(str: string): number {
  return str.trim().split(/\s+/).filter(Boolean).length;
}

function validateOptionLengths(options: string[]): boolean {
  if (options.length !== 4) return false;
  const counts = options.map(wordsCount);
  const avg = counts.reduce((a, b) => a + b, 0) / 4;
  return counts.every((c) => Math.abs(c - avg) <= Math.max(1, avg * 0.15));
}

const quizzesRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // POST /api/steps/:stepId/level-up-quiz — Grounded Socratic Quiz Generation
  const generateStepQuizHandler = async (req: any, reply: any) => {
    const { stepId } = req.params as { stepId: string };
    const { perfectionMode, focusAcus } = (req.body || {}) as {
      perfectionMode?: boolean;
      focusAcus?: string[];
    };

    try {
      const step: any = await prisma.skillStep.findUnique({
        where: { id: stepId },
        include: { workspace: true, contentDocument: true },
      });

      if (!step) {
        return reply.status(404).send({ error: 'Step not found' });
      }

      // F1: Grounding Text verification
      const doc = step.contentDocument;
      let groundingText = (doc?.markdown || '').trim();
      if (!groundingText) {
        if (step.documentation_markdown) {
          groundingText = step.documentation_markdown.trim();
        } else if (step.step_explanation) {
          groundingText = step.step_explanation.trim();
        } else if (step.topics) {
          try {
            const tList = Array.isArray(step.topics) ? step.topics : (typeof step.topics === 'string' ? JSON.parse(step.topics) : []);
            groundingText = tList.map((t: any) => `[Topic: ${t.title || 'Core'}] ${t.coreObjective || ''} ${t.sourceDomain || ''}`).join('\n\n');
          } catch (_) {}
        }
      }

      if (!groundingText) {
        const stepResources: any[] = Array.isArray(step.resources) ? step.resources : [];
        groundingText = stepResources
          .map((r: any) => `[Topic: ${r.topicKey || 'Core'}] ${r.title}: ${r.snippet || r.focusNote || ''}`)
          .join('\n\n')
          .trim();
      }

      if (!groundingText || groundingText.length < 30) {
        groundingText = `Core foundational principles, execution mechanics, and invariant rules for ${step.title || 'Milestone'}. Focus on practical mastery and avoiding common misconceptions.`;
      }

      const acusRaw = step.assessableUnits;
      const acus: any[] = Array.isArray(acusRaw) ? acusRaw : [];
      const isPerfection = Boolean(perfectionMode);

      const targetQuestionCount = isPerfection
        ? Math.min(4, Math.max(2, (focusAcus || []).length || 3))
        : calculatePersonalizedQuestionCount({
            stepIndex: step.stepIndex || 1,
            totalSteps: step.workspace?.totalPlannedSteps || 5,
            difficultyTier: step.difficultyTier || 'FOUNDATIONS',
            topicsCount: Array.isArray(step.topics) ? step.topics.length : (step.stepTopics?.length || 3),
            acusCount: acus.length,
            skillName: step.workspace?.skillName || step.workspace?.title || step.title || '',
            mode: isPerfection ? 'perfection' : 'initial',
          });

      // Global Workspace Question Tracker: fetch questions from prior steps
      const priorSteps = await prisma.skillStep.findMany({
        where: {
          workspaceId: step.workspaceId,
          id: { not: stepId },
          stepIndex: { lt: step.stepIndex },
        },
        select: {
          stepIndex: true,
          quizBlueprint: true,
        },
      });

      const previousQuestionSignatures: string[] = [];
      for (const ps of priorSteps) {
        if (Array.isArray(ps.quizBlueprint)) {
          for (const q of ps.quizBlueprint as any[]) {
            if (q?.question && typeof q.question === 'string') {
              previousQuestionSignatures.push(q.question.trim());
            }
          }
        }
      }

      const quizSystem = `You are a Principal Psychometrician & Socratic Evaluation Architect.
Generate scenario-grounded challenge questions derived EXCLUSIVELY from the provided Grounding Text and study resources.
Every question must test a principle, trap, or edge case present in the text.

CRITICAL ANTI-DUPLICATION RULE:
The following questions were already asked in earlier steps of this skill. You MUST NOT repeat any of these questions, concepts, or identical wordings. Every question for Step ${step.stepIndex} must be 100% unique:
${previousQuestionSignatures.length > 0 ? previousQuestionSignatures.slice(-25).map((q, i) => `${i + 1}. "${q}"`).join('\n') : 'None (First step).'}

Rules:
- Generate EXACTLY ${targetQuestionCount} Multiple-Choice Questions (calibrated to this step's ${step.difficultyTier || 'FOUNDATIONS'} tier and ${acus.length} topics). Ensure every topic in this step is covered.
- Every question MUST have:
  * "acuId": The ACU tested.
  * "question": The scenario challenge prompt.
  * "correctAnswer": The accurate technical solution.
  * "distractors": An array of EXACTLY 3 misconceptions discussed in the text.
  * "explanation": Why correctAnswer is right and why the distractors fail.
- EQUAL LENGTH RULE (MANDATORY): All 4 choices (correctAnswer + 3 distractors) MUST be comparable in length (within ±10% word count, or differing by at most 1 word).
- STRICT: NO URLs anywhere in the output.
Output JSON ONLY:
{
  "questions": [
    {
      "acuId": "${acus[0]?.id || 'acu-1'}",
      "question": "Scenario prompt...",
      "correctAnswer": "Accurate option text",
      "distractors": ["Wrong misconception 1", "Wrong misconception 2", "Wrong misconception 3"],
      "explanation": "Diagnostic reasoning..."
    }
  ]
}`;

      const quizUser = `Milestone: "${step.title}".
ACUs: ${JSON.stringify(acus)}.
${isPerfection ? `Focus ACUs Missed in Prior Attempt: ${JSON.stringify(focusAcus)}.` : ''}

GROUNDING TEXT & STUDY RESOURCES:
${groundingText.slice(0, 8000)}`;

      const generated = await callGroqJson<{ questions: any[] }>(quizSystem, quizUser, {
        validate: (v: any) =>
          Array.isArray(v?.questions) &&
          v.questions.length >= (isPerfection ? 2 : LEARNING_CONFIG.QUIZ_MIN_QUESTIONS) &&
          v.questions.every(
            (q: any) =>
              typeof q.question === 'string' &&
              typeof q.correctAnswer === 'string' &&
              Array.isArray(q.distractors) &&
              q.distractors.length === 3
          ),
        maxTokens: 3500,
        temperature: 0.4,
      });
      assertNoUrls(generated, 'QuizGeneration');

      // Helper for similarity check
      const computeSim = (a: string, b: string) => {
        const getW = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter((w) => w.length >= 3));
        const setA = getW(a);
        const setB = getW(b);
        if (setA.size === 0 || setB.size === 0) return 0;
        let match = 0;
        for (const w of setA) if (setB.has(w)) match++;
        const union = new Set([...setA, ...setB]).size;
        return union > 0 ? match / union : 0;
      };

      // Filter, validate length, and deduplicate (>75% similarity discarded)
      const validQuestions: any[] = [];
      for (const q of generated.questions || []) {
        const allOpts = [q.correctAnswer, ...q.distractors];
        const uniqueOpts = new Set(allOpts.map((s: string) => s.trim().toLowerCase()));
        if (uniqueOpts.size !== 4) continue;

        const candidateQ = q.question.trim();
        const isDupeOfPrior = previousQuestionSignatures.some((pq) => computeSim(candidateQ, pq) > 0.75);
        if (isDupeOfPrior) continue;

        const isDupeInCurrent = validQuestions.some((vq) => computeSim(candidateQ, vq.question) > 0.75);
        if (isDupeInCurrent) continue;

        validQuestions.push(q);
      }

      if (!isPerfection && validQuestions.length < LEARNING_CONFIG.QUIZ_MIN_QUESTIONS) {
        return reply.status(500).send({ error: 'Quiz generation failed strict question count standards' });
      }

      // F4: Server-side balanced placement across A-D
      const balancedQuestions = buildBalancedQuestions(validQuestions);

      await prisma.skillStep.update({
        where: { id: step.id },
        data: {
          quizBlueprint: balancedQuestions as any,
          questionCount: balancedQuestions.length,
        },
      });

      const attempt = await prisma.quizAttempt.create({
        data: {
          stepId: step.id,
          score: 0,
          passed: false,
          questionCount: balancedQuestions.length,
          status: 'in_progress',
          questions: balancedQuestions as any,
        },
      });

      // Sanitized client questions: NEVER expose isCorrect or correctOptionId
      const sanitizedQuestions = balancedQuestions.map((q) => ({
        id: q.question, // question prompt
        prompt: q.question,
        acuId: q.acuId,
        options: q.options.map((o) => ({
          id: o.id,
          text: o.text,
          position: o.position,
        })),
      }));

      return reply.send({
        attemptId: attempt.id,
        questions: sanitizedQuestions,
        questionCount: sanitizedQuestions.length,
        passingThreshold: LEARNING_CONFIG.PASS_THRESHOLD_PERCENT,
        isPerfectionMode: isPerfection,
      });
    } catch (err: any) {
      fastify.log.error(err, '[LevelUpQuiz] Failed');
      return reply.status(500).send({ error: err.message || 'Quiz generation failed' });
    }
  };

  fastify.post('/api/steps/:stepId/level-up-quiz', generateStepQuizHandler);
  fastify.post('/api/steps/:stepId/prompt-quiz', generateStepQuizHandler);
  fastify.post('/api/quizzes/generate/:stepId', generateStepQuizHandler);

  // POST /api/steps/:stepId/submit-quiz — Deterministic Server-Side Grading
  fastify.post('/api/steps/:stepId/submit-quiz', async (req, reply) => {
    const { stepId } = req.params as { stepId: string };
    const { attemptId, answers, questionIds } = (req.body || {}) as {
      attemptId?: string;
      answers: Record<string, string> | Array<{ questionId: string; selectedOptionId: string }>;
      questionIds?: string[];
    };

    try {
      const step: any = await prisma.skillStep.findUnique({
        where: { id: stepId },
        include: { workspace: true, contentDocument: true },
      });

      if (!step) {
        return reply.status(404).send({ error: 'Step not found' });
      }

      const blueprintRaw = step.quizBlueprint;
      let blueprint: any[] = Array.isArray(blueprintRaw) ? blueprintRaw : [];

      if (blueprint.length === 0) {
        return reply.status(400).send({ error: 'No active quiz blueprint found for this step.' });
      }

      if (Array.isArray(questionIds) && questionIds.length > 0) {
        const idSet = new Set(questionIds.map(String));
        const filtered = blueprint.filter((q) => idSet.has(String(q.id)));
        if (filtered.length > 0) {
          blueprint = filtered;
        }
      }

      // Normalize answers object: { [questionPromptOrId]: chosenOptionId }
      const answersMap: Record<string, string> = {};
      if (Array.isArray(answers)) {
        answers.forEach((a) => {
          if (a?.questionId) answersMap[a.questionId] = String(a.selectedOptionId).trim();
        });
      } else if (typeof answers === 'object' && answers !== null) {
        Object.entries(answers).forEach(([k, v]) => {
          answersMap[k] = String(v).trim();
        });
      }

      // F6: Deterministic grading strictly on the server
      let correctCount = 0;
      const failedAcus = new Set<string>();
      const breakdown = blueprint.map((q: any) => {
        const rawAns = answersMap[q.id] || answersMap[q.question] || '';
        const sortedOptions = [...(q.options || [])].sort((a: any, b: any) => (a.position ?? 0) - (b.position ?? 0));
        const correctOpt = sortedOptions.find((o: any) => o.id === q.correctOptionId || o.isCorrect) || sortedOptions[0];
        const correctIndex = sortedOptions.findIndex((o: any) => o.id === correctOpt?.id || o.isCorrect);

        const isCorrect =
          Boolean(rawAns) &&
          (rawAns === correctOpt?.id ||
            rawAns.toLowerCase() === (correctOpt?.id || '').toLowerCase() ||
            (!isNaN(Number(rawAns)) && Number(rawAns) === correctIndex) ||
            rawAns.toLowerCase() === (correctOpt?.text || '').trim().toLowerCase());

        if (isCorrect) {
          correctCount++;
        } else if (q.acuId) {
          failedAcus.add(q.acuId);
        }

        const chosenOption = sortedOptions.find(
          (o: any) =>
            o.id === rawAns ||
            o.id?.toLowerCase() === rawAns.toLowerCase() ||
            (!isNaN(Number(rawAns)) && o.position === Number(rawAns)) ||
            o.text?.trim().toLowerCase() === rawAns.toLowerCase()
        );

        return {
          question: q.question,
          acuId: q.acuId,
          chosenOptionId: chosenOption?.id || rawAns || null,
          correctOptionId: correctOpt?.id || q.correctOptionId,
          chosenOptionText: chosenOption?.text || rawAns || null,
          correctOptionText: correctOpt?.text || null,
          isCorrect,
          explanation: q.explanation || 'Comprehension analysis.',
        };
      });

      const total = blueprint.length;
      const percent = total > 0 ? Math.round((correctCount / total) * 100) : 0;
      const passed = percent >= 70;

      // Check if previously passed to grant XP and advance unlock ONLY ONCE (F7)
      const priorPassed = await prisma.quizAttempt.findFirst({
        where: { stepId: step.id, passed: true },
      });
      const isFirstTransitionToPassed = passed && !priorPassed;

      // Update attempt in DB
      let targetAttemptId = attemptId;
      if (targetAttemptId) {
        try {
          await prisma.quizAttempt.update({
            where: { id: targetAttemptId },
            data: {
              score: percent,
              scorePercent: percent,
              correctCount,
              passed,
              status: 'completed',
              results: breakdown as any,
              completedAt: new Date(),
            },
          });
        } catch (_) {}
      } else {
        const created = await prisma.quizAttempt.create({
          data: {
            stepId: step.id,
            score: percent,
            scorePercent: percent,
            correctCount,
            questionCount: total,
            passed,
            status: 'completed',
            results: breakdown as any,
            completedAt: new Date(),
          },
        });
        targetAttemptId = created.id;
      }

      // Update step status
      await prisma.skillStep.update({
        where: { id: step.id },
        data: {
          status: passed ? 'PASSED' : 'FAILED_REMEDIATION',
        },
      });

      // Calculate single-grant XP and unlock
      let xpEarned = 0;
      let unlockedNextStepId: string | null = null;
      let isFinalStep = false;
      let nextStepIndex: number | null = null;

      const allWorkspaceSteps = await prisma.skillStep.findMany({
        where: { workspaceId: step.workspaceId },
        orderBy: { stepIndex: 'asc' },
      });
      const totalSteps = Math.max(allWorkspaceSteps.length, 1);
      const nextStep = allWorkspaceSteps.find((s) => s.stepIndex === step.stepIndex + 1);
      isFinalStep = step.stepIndex === totalSteps || !nextStep;

      if (isFirstTransitionToPassed) {
        const grandmasterBonus = percent === 100 ? 1000 : 0;
        const completionBonus = isFinalStep ? 1000 : 0;
        xpEarned = step.stepIndex * 500 + grandmasterBonus + completionBonus;

        if (nextStep && (nextStep.status === 'LOCKED' || nextStep.status === 'IN_PROGRESS')) {
          const updatedNext = await prisma.skillStep.update({
            where: { id: nextStep.id },
            data: { status: 'STUDY_UNGENERATED' },
          });
          unlockedNextStepId = updatedNext.id;
          nextStepIndex = nextStep.stepIndex;
        }

        // Increment user XP
        const profileId = step.workspace?.userProfileId;
        if (profileId) {
          try {
            await (prisma.userProfile as any).update({
              where: { id: profileId },
              data: { totalXp: { increment: xpEarned } },
            });
          } catch (_) {
            try {
              await (prisma as any).profile?.update({
                where: { id: profileId },
                data: { totalXp: { increment: xpEarned } },
              });
            } catch (_) {}
          }
        }
      }

      // F8: Remediation Fallback for failed ACUs (Zero search trampoline)
      let diagnosticPrescription: any = null;
      if (!passed && failedAcus.size > 0) {
        const history = await prisma.resourceHistory.findMany({
          where: { workspaceId: step.workspaceId },
          select: { identifier: true },
        });
        const historySet = new Set(history.map((h) => h.identifier));

        const weakAreas: any[] = [];
        const stepBookResources: any[] = Array.isArray(step.resources) ? step.resources : [];

        for (const failedAcuId of Array.from(failedAcus)) {
          const acuObj = (step.assessableUnits as any[])?.find((a: any) => a.id === failedAcuId);
          const acuTitle = acuObj?.title || acuObj?.label || failedAcuId;

          // Two separate searches
          const docQuery = `${step.workspace?.title || ''} "${acuTitle}" technical guide 2026`.trim();
          const vidQuery = `${step.workspace?.title || ''} "${acuTitle}" tutorial drills 2026`.trim();

          const [docCands, vidCands] = await Promise.all([
            searchTavily(docQuery, { searchDepth: 'basic', maxResults: 3 }),
            searchTavily(vidQuery, { searchDepth: 'basic', maxResults: 3, includeDomains: ['youtube.com'] }),
          ]);

          let chosenDoc = docCands.find((d) => !historySet.has(normalizeUrl(d.url)));
          let chosenVid = vidCands.find((v) => {
            const vId = extractYouTubeId(v.url);
            return vId && !historySet.has(vId);
          });

          // Fallback to book links if search returned nothing usable
          if (!chosenDoc) {
            const bookDoc = stepBookResources.find((r: any) => r.type === 'doc' && r.linkStatus !== 'DEAD');
            if (bookDoc) chosenDoc = { title: bookDoc.title, url: bookDoc.url, content: bookDoc.snippet || '' };
          }
          if (!chosenVid) {
            const bookVid = stepBookResources.find((r: any) => r.type === 'video' && r.linkStatus !== 'DEAD');
            if (bookVid) chosenVid = { title: bookVid.title, url: bookVid.url, content: bookVid.snippet || '' };
          }

          weakAreas.push({
            topic: acuTitle,
            acuId: failedAcuId,
            misconceptionAnalysis: `Targeted review needed for competency: ${acuTitle}.`,
            coreConcept: acuObj?.description || `Master foundational execution of ${acuTitle}.`,
            resources: {
              docTitle: chosenDoc?.title || `${acuTitle} Reference`,
              docUrl: chosenDoc?.url || '#',
              videoTitle: chosenVid?.title || `${acuTitle} Walkthrough`,
              videoUrl: chosenVid?.url || '#',
              criticalTakeaway: chosenDoc?.content?.slice(0, 160) || `Focus on ${acuTitle} invariants.`,
            },
          });
        }

        diagnosticPrescription = {
          overallDiagnosis: 'Conceptual review required before re-attempting milestone evaluation.',
          weakAreas,
        };
      }

      return reply.send({
        attemptId: targetAttemptId,
        score: percent,
        scorePercentage: percent,
        passed,
        passingThreshold: LEARNING_CONFIG.PASS_THRESHOLD_PERCENT,
        totalQuestions: total,
        correctCount,
        results: breakdown,
        xpEarned,
        isFinalStep,
        nextStepIndex,
        unlockedNextStepId,
        ...(diagnosticPrescription ? { diagnosticPrescription } : {}),
      });
    } catch (err: any) {
      fastify.log.error(err, '[SubmitQuiz] Failed');
      return reply.status(500).send({ error: 'Evaluation failed' });
    }
  });

  // POST /api/quizzes/evaluate and /api/quiz/evaluate (Aliases for legacy client compatibility)
  fastify.post('/api/quizzes/evaluate', async (req, reply) => {
    const { stepId } = (req.body || {}) as { stepId?: string };
    if (!stepId) return reply.status(400).send({ error: 'stepId is required' });
    return (fastify as any).inject({
      method: 'POST',
      url: `/api/steps/${stepId}/submit-quiz`,
      payload: req.body,
    });
  });

  fastify.post('/api/quiz/evaluate', async (req, reply) => {
    const { stepId } = (req.body || {}) as { stepId?: string };
    if (!stepId) return reply.status(400).send({ error: 'stepId is required' });
    return (fastify as any).inject({
      method: 'POST',
      url: `/api/steps/${stepId}/submit-quiz`,
      payload: req.body,
    });
  });
};

export default quizzesRoutes;
export { quizzesRoutes as quizRoutes };
