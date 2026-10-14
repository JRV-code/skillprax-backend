import prisma from '../../lib/prisma';
import { LEARNING_CONFIG } from '../../config/learning';
import {
  callGroqJson,
  assertNoUrls,
  searchTavily,
  extractYouTubeId,
  checkYouTube,
  verifyLink,
  isSafePublicUrl,
  domainOf,
  normalizeUrl,
} from './foundation';

export interface QuizQuestionOption {
  id: string;
  text: string;
  position: number;
  isCorrect?: boolean;
}

export interface QuizQuestionRaw {
  topicKey: string;
  topicId?: string;
  resourceId?: string;
  evidenceFact: string;
  acuId: string;
  question: string;
  correctAnswer: string;
  distractors: string[];
  explanation: string;
  chapterKey?: string;
  anchorId?: string;
}

export interface StoredQuizQuestion {
  id: string;
  topicKey: string;
  topicId?: string;
  resourceId?: string;
  evidenceFact: string;
  acuId: string;
  question: string;
  explanation: string;
  correctOptionId: string;
  options: QuizQuestionOption[];
  chapterKey?: string;
  anchorId?: string;
}

function shuffle<T>(a: T[]): T[] {
  const r = [...a];
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}

export function checkLexicalGrounding(textA: string, textB: string): boolean {
  const get5LetterWords = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 5)
    );
  const factWords = get5LetterWords(textB);
  const testWords = get5LetterWords(textA);
  let shared = 0;
  for (const w of testWords) {
    if (factWords.has(w)) shared++;
  }
  return shared >= 2;
}

export function checkOptionLengths(opts: string[]): boolean {
  if (opts.length !== 4) return false;
  const wordCounts = opts.map((o) => o.trim().split(/\s+/).filter(Boolean).length);
  const minLen = Math.min(...wordCounts);
  const maxLen = Math.max(...wordCounts);
  if (maxLen <= 5) {
    return maxLen - minLen <= 2;
  }
  const avg = wordCounts.reduce((a, b) => a + b, 0) / 4;
  return wordCounts.every((len) => Math.abs(len - avg) <= avg * 0.35 || Math.abs(len - avg) <= 2);
}

export function buildBalancedQuestions(raw: QuizQuestionRaw[]): StoredQuizQuestion[] {
  const targets = shuffle(raw.map((_, i) => i % 4)); // Evenly distributes correct answer across positions 0-3
  return raw.map((q, i) => {
    const correctOpt: QuizQuestionOption = {
      id: `opt-${i}-c`,
      text: q.correctAnswer,
      position: 0,
      isCorrect: true,
    };

    const distractorOpts: QuizQuestionOption[] = shuffle(q.distractors)
      .slice(0, 3)
      .map((text, dIdx) => ({
        id: `opt-${i}-d${dIdx}`,
        text,
        position: 0,
        isCorrect: false,
      }));

    const options = [...distractorOpts];
    options.splice(targets[i], 0, correctOpt);

    const positionedOptions = options.map((o, position) => ({
      ...o,
      position,
    }));

    return {
      id: `q-${i + 1}`,
      topicKey: q.topicKey,
      topicId: q.topicId,
      resourceId: q.resourceId,
      evidenceFact: q.evidenceFact,
      acuId: q.acuId,
      chapterKey: q.chapterKey || q.topicKey,
      anchorId: q.anchorId || `anchor-${i + 1}`,
      question: q.question,
      explanation: q.explanation,
      correctOptionId: correctOpt.id,
      options: positionedOptions,
    };
  });
}

// 11.3 ONE PURE SCORING FUNCTION ON SERVER (INTEGER MATH & FLOORED PERCENT)
export function scoreAttempt(
  questions: { id: string; correctOptionId: string; topicKey?: string | null; chapterKey?: string | null; acuId?: string | null }[],
  answers: Record<string, string | undefined>,
  passPercent: number = LEARNING_CONFIG.PASS_THRESHOLD_PERCENT
) {
  const totalCount = questions.length;
  const results = questions.map((q) => ({
    id: q.id,
    topicKey: q.topicKey ?? q.chapterKey ?? null,
    acuId: q.acuId ?? null,
    correct: answers[q.id] === q.correctOptionId,
  }));
  const correctCount = results.filter((r) => r.correct).length;
  const percent = totalCount === 0 ? 0 : Math.floor((correctCount * 100) / totalCount);
  const passed = totalCount > 0 && correctCount * 100 >= passPercent * totalCount;
  const byTopic = [...new Set(results.map((r) => r.topicKey ?? 'general'))].map((topicKey) => {
    const rs = results.filter((r) => (r.topicKey ?? 'general') === topicKey);
    const correct = rs.filter((r) => r.correct).length;
    return { topicKey, correct, total: rs.length, percent: Math.floor((correct * 100) / rs.length) };
  });
  return { totalCount, correctCount, percent, passed, results, byTopic };
}

// DETERMINISTIC GRADING
export function gradeAttempt(
  questions: { id: string; correctOptionId: string; topicKey?: string | null; chapterKey?: string | null }[],
  answers: Record<string, string>,
  thresholdPercent: number = LEARNING_CONFIG.PASS_THRESHOLD_PERCENT
) {
  const total = questions.length;
  if (total === 0) throw new Error('Cannot grade an empty evaluation');

  const scored = scoreAttempt(questions, answers, thresholdPercent);
  const requiredCorrect = Math.ceil((thresholdPercent * total) / 100);

  return {
    total: scored.totalCount,
    correct: scored.correctCount,
    percent: scored.percent,
    requiredCorrect,
    passed: scored.passed,
    chapters: scored.byTopic.map((t) => ({
      chapterKey: t.topicKey,
      correct: t.correct,
      total: t.total,
      percent: t.percent,
    })),
  };
}

// 11.1 RUN QUIZ BUILD (BUILT FROM STORED FACTS)
export async function runQuizBuild(stepId: string): Promise<void> {
  const step = await prisma.skillStep.findUnique({
    where: { id: stepId },
    include: {
      workspace: true,
      stepTopics: {
        where: { status: 'READY' },
        include: { resources: true },
      },
    },
  });

  if (!step) throw new Error('Step not found');

  if (step.packStatus !== 'READY') {
    await prisma.skillStep.update({
      where: { id: stepId },
      data: { quizStatus: 'FAILED', quizError: 'Pack must be READY before quiz can be built' },
    });
    const err: any = new Error('Pack must be READY before quiz can be built');
    err.statusCode = 409;
    throw err;
  }

  interface UsableFact {
    topicKey: string;
    topicId: string;
    topicTitle: string;
    resourceId?: string;
    acuId: string;
    fact: string;
  }

  const allFacts: UsableFact[] = [];
  for (const topic of step.stepTopics) {
    const factsRaw = Array.isArray(topic.facts) ? (topic.facts as string[]) : [];
    const acuIds = Array.isArray(topic.acuIds) ? (topic.acuIds as string[]) : [];
    const primaryAcu = acuIds[0] || `${topic.key}-acu`;
    const resourceId = topic.resources[0]?.id;

    for (const factStr of factsRaw) {
      if (typeof factStr === 'string' && factStr.trim().length > 10) {
        allFacts.push({
          topicKey: topic.key,
          topicId: topic.id,
          topicTitle: topic.title,
          resourceId,
          acuId: primaryAcu,
          fact: factStr.trim(),
        });
      }
    }
  }

  if (allFacts.length < 12) {
    await prisma.skillStep.update({
      where: { id: stepId },
      data: { quizStatus: 'FAILED', quizError: 'Not enough source material' },
    });
    const err: any = new Error('Not enough source material');
    err.statusCode = 409;
    throw err;
  }

  await prisma.skillStep.update({
    where: { id: stepId },
    data: { quizStatus: 'BUILDING', quizStartedAt: new Date(), quizError: null },
  });

  try {
    const targetCount = Math.min(
      LEARNING_CONFIG.QUIZ_MAX_QUESTIONS,
      Math.max(LEARNING_CONFIG.QUIZ_MIN_QUESTIONS, Math.min(allFacts.length, 10))
    );

    // Group facts by topic
    const factsByTopic = new Map<string, UsableFact[]>();
    for (const f of allFacts) {
      if (!factsByTopic.has(f.topicKey)) factsByTopic.set(f.topicKey, []);
      factsByTopic.get(f.topicKey)!.push(f);
    }

    const selectedFacts: UsableFact[] = [];
    for (const [_, topicFacts] of factsByTopic.entries()) {
      if (selectedFacts.length < targetCount && topicFacts.length > 0) {
        selectedFacts.push(topicFacts[0]);
      }
    }
    for (const f of allFacts) {
      if (selectedFacts.length < targetCount && !selectedFacts.includes(f)) {
        selectedFacts.push(f);
      }
    }

    const promptSystem = `You are the Lead Psychometric Examiner for SKILL-TRACK.
Create rigorous, multiple-choice evaluation questions based EXCLUSIVELY on the provided facts.

REQUIREMENTS:
1. Generate ${selectedFacts.length} questions, with each question testing EXACTLY ONE provided fact.
2. Every ready topic provided must receive at least one question.
3. The correct answer MUST be directly supported by that fact's statement.
4. LEXICAL GROUNDING: The question or the correct answer MUST share at least TWO content words of 5+ letters with the cited evidenceFact.
5. For each question, provide EXACTLY 3 plausible distractors.
6. EQUAL LENGTH RULE: All 4 options (correctAnswer + 3 distractors) MUST be comparable in word count (within 10% length, or differing by at most 1 word for short options).
7. "explanation": 1-2 clear sentences explaining why the correct answer is accurate.
8. Absolutely NO URLs. Do NOT mention "the text", "the source", "the author", or "the fact". State principles directly.

Return ONLY JSON:
{
  "questions": [
    {
      "topicKey": "t1",
      "evidenceFact": "Exact fact text...",
      "acuId": "acu-1",
      "question": "Scenario or diagnostic question...",
      "correctAnswer": "Accurate option text",
      "distractors": ["Plausible distractor 1", "Plausible distractor 2", "Plausible distractor 3"],
      "explanation": "Diagnostic reasoning..."
    }
  ]
}`;

    const promptUser = JSON.stringify({
      stepTitle: step.title,
      topics: step.stepTopics.map((t) => ({ key: t.key, title: t.title })),
      facts: selectedFacts.map((f) => ({
        topicKey: f.topicKey,
        acuId: f.acuId,
        fact: f.fact,
      })),
    });

    const groqRes = await callGroqJson<{ questions: any[] }>(promptSystem, promptUser, {
      validate: (data: any) => {
        assertNoUrls(data, 'Quiz Questions');
        if (!data || !Array.isArray(data.questions)) throw new Error('Missing questions array');
        if (data.questions.length < LEARNING_CONFIG.QUIZ_MIN_QUESTIONS) {
          throw new Error(`Expected at least ${LEARNING_CONFIG.QUIZ_MIN_QUESTIONS} questions`);
        }
        return data;
      },
      maxTokens: 5500,
      temperature: 0.2,
    });

    const topicMap = new Map(step.stepTopics.map((t) => [t.key, t]));
    const validQuestions: QuizQuestionRaw[] = [];

    for (const q of groqRes.questions) {
      const topic = topicMap.get(q.topicKey);
      if (!topic) continue;
      if (!q.question || typeof q.question !== 'string') continue;
      if (!q.correctAnswer || typeof q.correctAnswer !== 'string') continue;
      if (!Array.isArray(q.distractors) || q.distractors.length !== 3) continue;

      const opts = [q.correctAnswer, ...q.distractors];
      const uniqueOpts = new Set(opts.map((s: string) => s.trim().toLowerCase()));
      if (uniqueOpts.size !== 4) continue;

      const factText = q.evidenceFact || '';
      const shares2Words = checkLexicalGrounding(`${q.question} ${q.correctAnswer}`, factText);
      const lengthsOk = checkOptionLengths(opts);

      if (shares2Words && lengthsOk) {
        validQuestions.push({
          topicKey: q.topicKey,
          topicId: topic.id,
          resourceId: topic.resources[0]?.id,
          evidenceFact: factText,
          acuId: q.acuId || `${q.topicKey}-acu`,
          question: q.question.trim(),
          correctAnswer: q.correctAnswer.trim(),
          distractors: q.distractors.map((d: any) => String(d).trim()),
          explanation: (q.explanation || '').trim(),
        });
      }
    }

    // Deterministic grounded fallback if psychometrics dropped below minimum
    if (validQuestions.length < LEARNING_CONFIG.QUIZ_MIN_QUESTIONS) {
      for (const sf of selectedFacts) {
        if (validQuestions.length >= LEARNING_CONFIG.QUIZ_MIN_QUESTIONS) break;
        if (!validQuestions.some((vq) => vq.evidenceFact === sf.fact)) {
          const topic = topicMap.get(sf.topicKey);
          if (topic) {
            validQuestions.push({
              topicKey: sf.topicKey,
              topicId: topic.id,
              resourceId: topic.resources[0]?.id,
              evidenceFact: sf.fact,
              acuId: sf.acuId,
              question: `In the context of ${topic.title}, which principle accurately characterizes verified execution?`,
              correctAnswer: sf.fact,
              distractors: [
                `Execution operates inversely to verified invariant conditions in ${topic.title}.`,
                `Procedural requirements in ${topic.title} may be omitted without functional variance.`,
                `Baseline outcomes are unrelated to structural coordination in ${topic.title}.`,
              ],
              explanation: `Directly supported by foundational principles: ${sf.fact}`,
            });
          }
        }
      }
    }

    const balanced = buildBalancedQuestions(validQuestions);

    await prisma.skillStep.update({
      where: { id: stepId },
      data: {
        quizBlueprint: balanced as any,
        questionCount: balanced.length,
        quizStatus: 'READY',
        quizError: null,
      },
    });

    console.log(`[runQuizBuild] Step ${stepId} quiz built with ${balanced.length} balanced questions.`);
  } catch (err: any) {
    console.error(`[runQuizBuild] Step ${stepId} quiz build failed:`, err);
    await prisma.skillStep.update({
      where: { id: stepId },
      data: {
        quizStatus: 'FAILED',
        quizError: err.message || 'Quiz build failed',
      },
    });
    throw err;
  }
}

// 11.2 & 11.3 SERVE QUIZ QUESTIONS
export async function generateLevelUpQuiz(stepId: string) {
  const step = await prisma.skillStep.findUnique({
    where: { id: stepId },
    include: {
      stepTopics: { where: { status: 'READY' } },
    },
  });

  if (!step) throw new Error('Step not found');

  if (step.quizStatus === 'BUILDING') {
    return {
      preparing: true,
      quizStatus: 'BUILDING',
      message: 'Preparing your quiz…',
    };
  }

  if (step.quizStatus !== 'READY' || !Array.isArray(step.quizBlueprint) || (step.quizBlueprint as any[]).length === 0) {
    await runQuizBuild(stepId);
  }

  const updatedStep = await prisma.skillStep.findUnique({
    where: { id: stepId },
  });

  const balancedQuestions: StoredQuizQuestion[] = Array.isArray(updatedStep?.quizBlueprint)
    ? (updatedStep!.quizBlueprint as any)
    : [];

  // Sanitized questions sent to browser: NEVER expose isCorrect, correctOptionId, or evidenceFact
  const sanitized = balancedQuestions.map((q) => ({
    id: q.id,
    topicKey: q.topicKey,
    topicId: q.topicId,
    question: q.question,
    options: q.options.map((o) => ({
      id: o.id,
      text: o.text,
      position: o.position,
    })),
  }));

  const priorAttemptsCount = await prisma.attemptResult.count({
    where: { stepId },
  });

  return {
    questions: sanitized,
    questionCount: sanitized.length,
    passingThreshold: LEARNING_CONFIG.PASS_THRESHOLD_PERCENT,
    attemptNumber: priorAttemptsCount + 1,
    coveredTopics: Array.from(new Set(balancedQuestions.map((q) => q.topicKey))),
  };
}

// 11.3 SUBMIT AND GRADE QUIZ AT 70%
export async function submitQuizAnswers(
  stepId: string,
  payload: {
    attemptId?: string;
    answers: Record<string, string>;
  }
) {
  const step = await prisma.skillStep.findUnique({
    where: { id: stepId },
    include: {
      workspace: true,
      stepTopics: { include: { resources: true } },
    },
  });

  if (!step) throw new Error('Step not found');

  const questions: StoredQuizQuestion[] = Array.isArray(step.quizBlueprint)
    ? (step.quizBlueprint as any)
    : [];

  if (questions.length === 0) {
    throw new Error('No active quiz blueprint found for step');
  }

  // Pure server scoring function
  const scored = scoreAttempt(questions, payload.answers, LEARNING_CONFIG.PASS_THRESHOLD_PERCENT);

  const detailedBreakdown = questions.map((q) => {
    const chosenOptionId = payload.answers[q.id];
    const isCorrect = chosenOptionId === q.correctOptionId;
    const chosenOption = q.options.find((o) => o.id === chosenOptionId);
    const correctOption = q.options.find((o) => o.id === q.correctOptionId);
    const topic = step.stepTopics.find((t) => t.key === q.topicKey);

    return {
      id: q.id,
      topicKey: q.topicKey,
      topicId: q.topicId || topic?.id,
      topicTitle: topic?.title || q.topicKey,
      resource: topic?.resources[0] || null,
      evidenceFact: q.evidenceFact,
      question: q.question,
      chosenOptionId: chosenOptionId || null,
      chosenOptionText: chosenOption?.text || null,
      correctOptionId: q.correctOptionId,
      correctOptionText: correctOption?.text || null,
      isCorrect,
      explanation: q.explanation,
    };
  });

  const priorPassed = await prisma.attemptResult.findFirst({
    where: { stepId: step.id, passed: true },
  });
  const isFirstTransitionToPassed = scored.passed && !priorPassed;

  let xpEarned = 0;
  let unlockedNextStepId: string | null = null;
  let isFinalStep = false;
  let nextStepIndex: number | null = null;

  if (isFirstTransitionToPassed) {
    const allWorkspaceSteps = await prisma.skillStep.findMany({
      where: { workspaceId: step.workspaceId },
      orderBy: { stepIndex: 'asc' },
    });
    const totalSteps = Math.max(allWorkspaceSteps.length, 1);
    const nextStep = allWorkspaceSteps.find((s) => s.stepIndex === step.stepIndex + 1);
    isFinalStep = step.stepIndex === totalSteps || !nextStep;

    const grandmasterBonus = scored.percent === 100 ? 1000 : 0;
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

    const profileId = step.workspace?.profileId || (step.workspace as any)?.userProfileId;
    if (profileId) {
      try {
        await (prisma as any).userProfile.update({
          where: { id: profileId },
          data: { totalXp: { increment: xpEarned } },
        });
      } catch (_) {}
    }
  }

  // Determine kind: INITIAL | TARGETED_RETEST | PERFECTION
  const priorAttemptCount = await prisma.attemptResult.count({ where: { stepId: step.id } });
  const kind = priorAttemptCount === 0 ? 'INITIAL' : (scored.percent === 100 ? 'PERFECTION' : 'TARGETED_RETEST');

  // Persist AttemptResult
  const attemptResult = await prisma.attemptResult.create({
    data: {
      stepId: step.id,
      profileId: step.workspace?.profileId || (step.workspace as any)?.userProfileId,
      kind,
      correctCount: scored.correctCount,
      totalCount: scored.totalCount,
      percent: scored.percent,
      passed: scored.passed,
      topicBreakdown: scored.byTopic as any,
    },
  });

  // Also maintain QuizAttempt for backwards compatibility
  await prisma.quizAttempt.create({
    data: {
      id: attemptResult.id,
      stepId: step.id,
      score: scored.percent,
      scorePercent: scored.percent,
      correctCount: scored.correctCount,
      totalCount: scored.totalCount,
      questionCount: scored.totalCount,
      attemptNumber: priorAttemptCount + 1,
      passed: scored.passed,
      status: 'completed',
      results: detailedBreakdown as any,
      breakdown: scored.byTopic as any,
      completedAt: new Date(),
    },
  });

  // Update step status
  await prisma.skillStep.update({
    where: { id: step.id },
    data: {
      status: scored.passed ? 'PASSED' : 'FAILED_REMEDIATION',
    },
  });

  // Generate analysis
  const analysis = await generateEvaluationAnalysis(attemptResult.id);

  return {
    id: attemptResult.id,
    evaluationId: attemptResult.id,
    attemptNumber: priorAttemptCount + 1,
    kind,
    score: scored.percent,
    scorePercent: scored.percent,
    percent: scored.percent,
    correctCount: scored.correctCount,
    totalCount: scored.totalCount,
    passed: scored.passed,
    passThresholdPercent: LEARNING_CONFIG.PASS_THRESHOLD_PERCENT,
    byTopic: scored.byTopic,
    chapters: scored.byTopic,
    results: detailedBreakdown,
    analysis,
    isFirstTransitionToPassed,
    xpEarned,
    isFinalStep,
    nextStepIndex,
    unlockedNextStepId,
  };
}

// 11.4 AI ANALYSIS AT SUBMIT (STRICTLY CONSTRAINED)
export async function generateEvaluationAnalysis(evaluationId: string, languageCode = 'en') {
  const attempt = await prisma.attemptResult.findUnique({
    where: { id: evaluationId },
    include: {
      step: {
        include: {
          stepTopics: { include: { resources: true } },
          workspace: true,
        },
      },
    },
  });

  if (!attempt) throw new Error('Evaluation attempt not found');

  const topicBreakdown: any[] = Array.isArray(attempt.topicBreakdown) ? (attempt.topicBreakdown as any[]) : [];
  const topicMap = new Map(attempt.step.stepTopics.map((t) => [t.key, t]));

  const promptSystem = `You are the Lead Socratic Evaluator for SKILL-TRACK.
Provide an objective, constructive evaluation analysis of the learner's milestone evaluation.
Strict Rules:
- Language: Output in "${languageCode}".
- NO URLs anywhere in the output.
- NO PERCENTAGE FIGURES in model text (do NOT write "%" or fabricated score numbers). Numbers come only from code.
- Headline: 5-8 words summarizing mastery trajectory.
- Strengths: Array of strings highlighting solid topic areas.
- Gaps: Array of objects [{ "topicKey": "...", "why": "one sentence", "whatToDo": "actionable technique note" }]
- NextAction: One concrete practice recommendation.
- Encouragement: One grounded sentence.

Return ONLY JSON:
{
  "headline": "...",
  "strengths": ["..."],
  "gaps": [ { "topicKey": "t1", "why": "...", "whatToDo": "..." } ],
  "nextAction": "...",
  "encouragement": "..."
}`;

  const promptUser = JSON.stringify({
    passed: attempt.passed,
    correctCount: attempt.correctCount,
    totalCount: attempt.totalCount,
    topics: topicBreakdown.map((tb) => ({
      topicKey: tb.topicKey,
      topicTitle: topicMap.get(tb.topicKey)?.title || tb.topicKey,
      correct: tb.correct,
      total: tb.total,
    })),
  });

  let analysis: any = null;
  try {
    analysis = await callGroqJson<any>(promptSystem, promptUser, {
      validate: (data: any) => {
        assertNoUrls(data, 'Analysis');
        if (!data || !data.headline || !Array.isArray(data.strengths) || !Array.isArray(data.gaps)) {
          throw new Error('Missing analysis fields');
        }
        // Validate: NO percentage figures in model text
        const textStr = JSON.stringify(data);
        if (/\d\s*%/.test(textStr)) {
          throw new Error('Model included percentage figure in text');
        }
        return data;
      },
      maxTokens: 2000,
      temperature: 0.2,
    });
  } catch (err: any) {
    console.warn('[quiz] Groq analysis fallback used:', err.message);
    const weakestTopic = [...topicBreakdown].sort((a, b) => (a.percent || 0) - (b.percent || 0))[0];
    const weakTitle = topicMap.get(weakestTopic?.topicKey)?.title || weakestTopic?.topicKey || 'weakest areas';

    analysis = {
      headline: attempt.passed ? 'Milestone Benchmark Standard Achieved' : 'Target Threshold Not Yet Reached',
      strengths: topicBreakdown
        .filter((t) => t.correct === t.total)
        .map((t) => `Consistent precision in ${topicMap.get(t.topicKey)?.title || t.topicKey}.`),
      gaps: topicBreakdown
        .filter((t) => t.correct < t.total)
        .map((t) => ({
          topicKey: t.topicKey,
          why: `Observed variances in ${topicMap.get(t.topicKey)?.title || t.topicKey}.`,
          whatToDo: `Review primary guidance and focus on structural mechanics.`,
        })),
      nextAction: `Revisit foundational resource for ${weakTitle} before subsequent attempt.`,
      encouragement: attempt.passed
        ? 'Solid technical comprehension demonstrated. Proceed to the next milestone.'
        : 'Deliberate review of identified variances will bridge the requirement on your next attempt.',
    };
  }

  // Augment gaps with verified resource links in code
  if (Array.isArray(analysis.gaps)) {
    analysis.gaps = analysis.gaps.map((g: any) => {
      const topic = topicMap.get(g.topicKey);
      const res = topic?.resources[0];
      return {
        ...g,
        topicTitle: topic?.title || g.topicKey,
        resource: res ? { url: res.url, title: res.title, domain: res.domain } : null,
      };
    });
  }

  // Store analysis in AttemptResult and QuizAttempt
  await prisma.attemptResult.update({
    where: { id: attempt.id },
    data: { analysis: analysis as any },
  });

  try {
    await prisma.quizAttempt.update({
      where: { id: attempt.id },
      data: { analysis: analysis as any },
    });
  } catch (_) {}

  return analysis;
}

// 11.6 REMEDIATION SEARCH
export async function findRemediationResources(stepId: string, topicKey?: string) {
  const step = await prisma.skillStep.findUnique({
    where: { id: stepId },
    include: {
      workspace: true,
      stepTopics: { include: { resources: true } },
    },
  });

  if (!step) throw new Error('Step not found');

  const history = await prisma.resourceHistory.findMany({
    where: { workspaceId: step.workspaceId },
  });
  const historyIdentifiers = new Set(history.map((h) => h.identifier));

  const targetTopics = topicKey
    ? step.stepTopics.filter((t) => t.key === topicKey)
    : step.stepTopics;

  const remediationLinks: Array<{
    type: 'video' | 'doc';
    title: string;
    url: string;
    domain: string;
    snippet: string;
    embeddable?: boolean;
    videoId?: string | null;
  }> = [];

  for (const topic of targetTopics) {
    const docQuery = `${step.workspace.title} ${topic.title} deep dive guide`;
    const vidQuery = `${step.workspace.title} ${topic.title} breakdown`;

    const [docRes, vidRes] = await Promise.all([
      searchTavily(docQuery, { searchDepth: 'advanced', maxResults: 3 }),
      searchTavily(vidQuery, {
        searchDepth: 'basic',
        maxResults: 3,
        includeDomains: ['youtube.com'],
      }),
    ]);

    for (const r of [...docRes, ...vidRes]) {
      const normalized = normalizeUrl(r.url);
      if (historyIdentifiers.has(normalized)) continue;
      if (!(await isSafePublicUrl(r.url))) continue;

      const ytId = extractYouTubeId(r.url);
      let embeddable = true;
      if (ytId) {
        const yt = await checkYouTube(ytId);
        if (yt.status === 'GONE') continue;
        if (yt.status === 'NO_EMBED') embeddable = false;
      }

      const verified = await verifyLink(r.url);
      if (verified.status === 'DEAD') continue;

      remediationLinks.push({
        type: ytId ? 'video' : 'doc',
        title: r.title,
        url: verified.finalUrl,
        domain: domainOf(verified.finalUrl),
        snippet: (r.content || '').slice(0, 180),
        embeddable,
        videoId: ytId,
      });

      if (remediationLinks.length >= 4) break;
    }
  }

  return remediationLinks;
}
