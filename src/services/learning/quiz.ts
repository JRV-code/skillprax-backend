import prisma from '../../lib/prisma';
import { LEARNING_CONFIG, calculatePersonalizedQuestionCount } from '../../config/learning';
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
  questions: StoredQuizQuestion[],
  answers: Record<string, string | undefined>,
  passPercent: number = LEARNING_CONFIG.PASS_THRESHOLD_PERCENT
) {
  const totalCount = questions.length;
  const results = questions.map((q) => {
    const rawAnswer = (answers[q.id] ?? '').toString().trim();
    let isCorrect = rawAnswer === q.correctOptionId;
    if (!isCorrect && Array.isArray(q.options)) {
      const correctOpt = q.options.find((o) => o.id === q.correctOptionId);
      if (correctOpt) {
        if (
          rawAnswer === String(correctOpt.position) ||
          rawAnswer.toLowerCase() === correctOpt.text.trim().toLowerCase()
        ) {
          isCorrect = true;
        }
      }
    }

    return {
      id: q.id,
      topicKey: q.topicKey ?? q.chapterKey ?? null,
      acuId: q.acuId ?? null,
      correct: isCorrect,
    };
  });
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
  questions: StoredQuizQuestion[],
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
        include: { resources: true },
      },
    },
  });

  if (!step) throw new Error('Step not found');

  interface UsableFact {
    topicKey: string;
    topicId: string;
    topicTitle: string;
    resourceId?: string;
    acuId: string;
    fact: string;
  }

  const allFacts: UsableFact[] = [];
  const readyTopics = step.stepTopics.length > 0
    ? step.stepTopics
    : [
        {
          id: `${step.id}-t1`,
          key: 't1',
          title: `${step.title} Fundamentals`,
          covers: 'Foundational principles and operational standards',
          guide: { lookFor: ['Core definitions', 'Procedural invariants'], doThis: 'Apply basic mechanics' },
          facts: [`${step.title} requires verified execution of core baseline techniques.`],
          acuIds: ['acu-1'],
          resources: [],
        } as any,
      ];

  for (const topic of readyTopics) {
    const factsRaw = Array.isArray(topic.facts) ? (topic.facts as string[]) : [];
    const acuIds = Array.isArray(topic.acuIds) ? (topic.acuIds as string[]) : [];
    const primaryAcu = acuIds[0] || `${topic.key}-acu`;
    const resourceId = topic.resources?.[0]?.id;

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

    // Enrich with guide highlights if facts are sparse
    const guide = topic.guide as any;
    if (guide) {
      if (Array.isArray(guide.lookFor)) {
        for (const lf of guide.lookFor) {
          if (typeof lf === 'string' && lf.trim().length > 6) {
            allFacts.push({
              topicKey: topic.key,
              topicId: topic.id,
              topicTitle: topic.title,
              resourceId,
              acuId: primaryAcu,
              fact: `In ${topic.title}, essential technique requires observing: ${lf.trim()}.`,
            });
          }
        }
      }
      if (guide.doThis && typeof guide.doThis === 'string' && guide.doThis.trim().length > 6) {
        allFacts.push({
          topicKey: topic.key,
          topicId: topic.id,
          topicTitle: topic.title,
          resourceId,
          acuId: primaryAcu,
          fact: `The recommended hands-on execution for ${topic.title} is: ${guide.doThis.trim()}.`,
        });
      }
    }

    if (topic.covers && typeof topic.covers === 'string' && topic.covers.trim().length > 8) {
      allFacts.push({
        topicKey: topic.key,
        topicId: topic.id,
        topicTitle: topic.title,
        resourceId,
        acuId: primaryAcu,
        fact: `${topic.title} systematically addresses: ${topic.covers.trim()}.`,
      });
    }
  }

  // Ensure minimum fact pool
  if (allFacts.length < 8) {
    for (const topic of readyTopics) {
      allFacts.push(
        {
          topicKey: topic.key,
          topicId: topic.id,
          topicTitle: topic.title,
          resourceId: topic.resources?.[0]?.id,
          acuId: `${topic.key}-acu`,
          fact: `Proper operational form in ${topic.title} ensures error-free execution under standard conditions.`,
        },
        {
          topicKey: topic.key,
          topicId: topic.id,
          topicTitle: topic.title,
          resourceId: topic.resources?.[0]?.id,
          acuId: `${topic.key}-acu`,
          fact: `Deliberate practice isolating ${topic.title} mechanics eliminates early variance before full milestone integration.`,
        }
      );
    }
  }

  await prisma.skillStep.update({
    where: { id: stepId },
    data: { quizStatus: 'BUILDING', quizStartedAt: new Date(), quizError: null },
  });

  try {
    const targetCount = calculatePersonalizedQuestionCount({
      stepIndex: step.stepIndex || 1,
      totalSteps: step.workspace?.totalPlannedSteps || 5,
      difficultyTier: step.difficultyTier || 'FOUNDATIONS',
      topicsCount: readyTopics.length,
      acusCount: Array.isArray(step.assessableUnits) ? step.assessableUnits.length : 0,
      skillName: step.workspace?.skillName || step.workspace?.title || step.title || '',
    });

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
1. Generate EXACTLY ${targetCount} Multiple-Choice Questions (calibrated to this step's ${step.difficultyTier || 'FOUNDATIONS'} tier and ${readyTopics.length} topics). Ensure every topic in this step is covered. Each question tests EXACTLY ONE provided fact.
2. Every ready topic provided must receive at least one question.
3. The correct answer MUST be directly supported by that fact's statement.
4. For each question, provide EXACTLY 3 plausible distractors.
5. All 4 options (correctAnswer + 3 distractors) MUST be comparable in word count.
6. "explanation": 1-2 clear sentences explaining why the correct answer is accurate.
7. Absolutely NO URLs. Do NOT mention "the text", "the source", or "the fact". State principles directly.

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
      topics: readyTopics.map((t) => ({ key: t.key, title: t.title })),
      facts: selectedFacts.map((f) => ({
        topicKey: f.topicKey,
        acuId: f.acuId,
        fact: f.fact,
      })),
    });

    let rawQuestions: any[] = [];
    try {
      const groqRes = await callGroqJson<{ questions: any[] }>(promptSystem, promptUser, {
        validate: (data: any) => {
          assertNoUrls(data, 'Quiz Questions');
          if (!data || !Array.isArray(data.questions)) throw new Error('Missing questions array');
          return data;
        },
        maxTokens: 5500,
        temperature: 0.2,
      });
      rawQuestions = groqRes.questions;
    } catch (gErr) {
      console.warn('[runQuizBuild] Groq generation fallback used:', gErr);
    }

    const topicMap = new Map(readyTopics.map((t) => [t.key, t]));
    const validQuestions: QuizQuestionRaw[] = [];

    for (const q of rawQuestions) {
      const topic = topicMap.get(q.topicKey) || readyTopics[0];
      if (!topic) continue;
      if (!q.question || typeof q.question !== 'string') continue;
      if (!q.correctAnswer || typeof q.correctAnswer !== 'string') continue;
      if (!Array.isArray(q.distractors) || q.distractors.length < 3) continue;

      const factText = q.evidenceFact || topic.title;

      validQuestions.push({
        topicKey: topic.key,
        topicId: topic.id,
        resourceId: topic.resources?.[0]?.id,
        evidenceFact: factText,
        acuId: q.acuId || `${topic.key}-acu`,
        question: q.question.trim(),
        correctAnswer: q.correctAnswer.trim(),
        distractors: q.distractors.slice(0, 3).map((d: any) => String(d).trim()),
        explanation: (q.explanation || `Supported by foundational principles of ${topic.title}`).trim(),
      });
    }

    // Deterministic grounded fallback so we are 100% guaranteed to reach targetCount questions
    if (validQuestions.length < targetCount) {
      for (const sf of selectedFacts) {
        if (validQuestions.length >= targetCount) break;
        if (!validQuestions.some((vq) => vq.evidenceFact === sf.fact)) {
          const topic = topicMap.get(sf.topicKey) || readyTopics[0];
          validQuestions.push({
            topicKey: sf.topicKey,
            topicId: topic.id,
            resourceId: topic.resources?.[0]?.id,
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

      // If still below targetCount, cycle through topics to generate complete set
      let fillIdx = 1;
      while (validQuestions.length < targetCount) {
        const topic = readyTopics[(validQuestions.length) % readyTopics.length];
        validQuestions.push({
          topicKey: topic.key,
          topicId: topic.id,
          resourceId: topic.resources?.[0]?.id,
          evidenceFact: `${topic.title} standard baseline verification ${fillIdx}`,
          acuId: `${topic.key}-acu`,
          question: `Which approach best prevents common errors when implementing ${topic.title}?`,
          correctAnswer: `Consistently follow verified mechanical steps and audit baseline invariants.`,
          distractors: [
            `Accelerate pace without confirming prior alignment checks in ${topic.title}.`,
            `Bypass foundational standards to target edge-case scenarios early.`,
            `Rely strictly on subjective intuition rather than repeatable technique.`,
          ],
          explanation: `Consistent alignment and deliberate procedural control are required for ${topic.title}.`,
        });
        fillIdx++;
      }
    }

    const finalQuestions = validQuestions.slice(0, targetCount);
    const balanced = buildBalancedQuestions(finalQuestions);

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
// 11.2 & 11.3 SERVE QUIZ QUESTIONS
export async function generateLevelUpQuiz(
  stepId: string,
  options?: {
    mode?: 'initial' | 'retest' | 'perfection';
    retestMode?: boolean;
    perfectionMode?: boolean;
    failedQuestionIds?: string[];
  }
) {
  let step = await prisma.skillStep.findUnique({
    where: { id: stepId },
    include: {
      workspace: true,
      stepTopics: { include: { resources: true } },
    },
  });

  if (!step) {
    const ws = await prisma.workspace.findUnique({
      where: { id: stepId },
      include: { steps: { orderBy: { stepIndex: 'asc' } } },
    });
    if (ws && ws.steps.length > 0) {
      const activeS = ws.steps.find((s) => s.status !== 'PASSED') || ws.steps[0];
      step = await prisma.skillStep.findUnique({
        where: { id: activeS.id },
        include: {
          workspace: true,
          stepTopics: { include: { resources: true } },
        },
      });
    }
  }

  if (!step) throw new Error('Step not found');

  const isRetestOrPerfection =
    options?.mode === 'retest' ||
    options?.mode === 'perfection' ||
    Boolean(options?.retestMode) ||
    Boolean(options?.perfectionMode);

  const existingBlueprint = Array.isArray(step.quizBlueprint) ? (step.quizBlueprint as any[]) : [];
  if (isRetestOrPerfection || step.quizStatus !== 'READY' || existingBlueprint.length === 0) {
    await runQuizBuild(step.id);
  }

  const updatedStep = await prisma.skillStep.findUnique({
    where: { id: step.id },
    include: { stepTopics: true },
  });

  const balancedQuestions: StoredQuizQuestion[] = Array.isArray(updatedStep?.quizBlueprint)
    ? (updatedStep!.quizBlueprint as any)
    : [];

  const topicMap = new Map((updatedStep?.stepTopics || []).map((t) => [t.key, t]));

  // Normalized JSON questions: NEVER expose isCorrect or correctOptionId
  const sanitized = balancedQuestions.map((q, idx) => {
    const topic = topicMap.get(q.topicKey);
    return {
      id: q.id || `q_${idx + 1}`,
      question: q.question,
      prompt: q.question,
      topicKey: q.topicKey,
      topicTitle: topic?.title || q.topicKey,
      acuId: q.acuId,
      chapterKey: q.chapterKey,
      options: (q.options || []).map((o, optIdx) => ({
        id: o.id || `opt_${optIdx}`,
        text: o.text,
        position: typeof o.position === 'number' ? o.position : optIdx,
      })),
    };
  });

  const priorAttemptsCount = await prisma.attemptResult.count({
    where: { stepId: step.id },
  });

  return {
    evaluationId: `eval_${step.id}_${Date.now()}`,
    stepId: step.id,
    stepNumber: step.stepIndex,
    stepTitle: step.title,
    passThreshold: 70,
    passingThreshold: 70,
    questions: sanitized,
    questionCount: sanitized.length,
    attemptNumber: priorAttemptsCount + 1,
    coveredTopics: Array.from(new Set(balancedQuestions.map((q) => q.topicKey))),
  };
}

// 11.3 SUBMIT AND GRADE QUIZ AT STRICT 70% CRITERIA WITH MISTAKE ANALYSIS & REMEDIATION
export async function submitQuizAnswers(
  stepId: string,
  payload: {
    attemptId?: string;
    answers: Record<string, string>;
    questionIds?: string[];
    mode?: string;
  }
) {
  let step = await prisma.skillStep.findUnique({
    where: { id: stepId },
    include: {
      workspace: true,
      stepTopics: { include: { resources: true } },
    },
  });

  if (!step) {
    const ws = await prisma.workspace.findUnique({
      where: { id: stepId },
      include: { steps: { orderBy: { stepIndex: 'asc' } } },
    });
    if (ws && ws.steps.length > 0) {
      const activeS = ws.steps.find((s) => s.status !== 'PASSED') || ws.steps[0];
      step = await prisma.skillStep.findUnique({
        where: { id: activeS.id },
        include: {
          workspace: true,
          stepTopics: { include: { resources: true } },
        },
      });
    }
  }

  if (!step) throw new Error('Step not found');

  const allQuestions: StoredQuizQuestion[] = Array.isArray(step.quizBlueprint)
    ? (step.quizBlueprint as any)
    : [];

  if (allQuestions.length === 0) {
    throw new Error('No active quiz blueprint found for step');
  }

  // 1. Grade strictly against the active attempt's questions (Denominator Fix)
  let activeQuestions: StoredQuizQuestion[] = allQuestions;
  if (Array.isArray(payload.questionIds) && payload.questionIds.length > 0) {
    const activeIdSet = new Set(payload.questionIds.map((id) => String(id)));
    const filtered = allQuestions.filter((q) => activeIdSet.has(String(q.id)));
    if (filtered.length > 0) {
      activeQuestions = filtered;
    }
  }

  const totalCount = activeQuestions.length;
  let correctCount = 0;

  // 2. Bulletproof Answer Matching (Numerator Fix)
  const detailedBreakdown = activeQuestions.map((q) => {
    // Order options by position ASC
    const sortedOptions = [...(q.options || [])].sort(
      (a, b) => (typeof a.position === 'number' ? a.position : 0) - (typeof b.position === 'number' ? b.position : 0)
    );

    const correctOption =
      sortedOptions.find((o) => o.id === q.correctOptionId || o.isCorrect) || sortedOptions[0];
    const correctIndex = sortedOptions.findIndex(
      (o) => o.id === q.correctOptionId || o.isCorrect
    );

    const rawAnswer = (payload.answers[q.id] ?? '').toString().trim();

    // Check match against: Option ID, 0-based option index, or option text
    const isMatchedById =
      Boolean(rawAnswer) &&
      Boolean(correctOption?.id) &&
      (rawAnswer === correctOption.id || rawAnswer.toLowerCase() === correctOption.id.toLowerCase());

    const isMatchedByIndex =
      Boolean(rawAnswer) &&
      correctIndex >= 0 &&
      !isNaN(Number(rawAnswer)) &&
      Number(rawAnswer) === correctIndex;

    const isMatchedByText =
      Boolean(rawAnswer) &&
      Boolean(correctOption?.text) &&
      rawAnswer.toLowerCase() === correctOption.text.trim().toLowerCase();

    const isCorrect = isMatchedById || isMatchedByIndex || isMatchedByText;

    if (isCorrect) correctCount++;

    // Find chosen option object for reporting
    let chosenOption = sortedOptions.find(
      (o) =>
        o.id === rawAnswer ||
        (rawAnswer && o.id.toLowerCase() === rawAnswer.toLowerCase()) ||
        (!isNaN(Number(rawAnswer)) && o.position === Number(rawAnswer)) ||
        o.text.trim().toLowerCase() === rawAnswer.toLowerCase()
    );

    const topic = step!.stepTopics.find((t) => t.key === q.topicKey);

    return {
      id: q.id,
      questionId: q.id,
      topicKey: q.topicKey,
      topicId: q.topicId || topic?.id,
      topicTitle: topic?.title || q.topicKey,
      resource: topic?.resources[0] || null,
      evidenceFact: q.evidenceFact,
      question: q.question,
      chosenOptionId: chosenOption?.id || rawAnswer || null,
      chosenOptionText: chosenOption?.text || rawAnswer || null,
      chosenText: chosenOption?.text || rawAnswer || 'No response recorded',
      correctOptionId: correctOption?.id || q.correctOptionId,
      correctOptionText: correctOption?.text || 'Correct principle',
      correctText: correctOption?.text || 'Correct principle',
      isCorrect,
      explanation: q.explanation,
    };
  });

  // 3. Exact standard percentage formula & 70% Gate
  const exactPercentage = totalCount > 0 ? Math.round((correctCount / totalCount) * 100) : 0;
  const passed = exactPercentage >= 70;
  const percent = exactPercentage;

  // Identify wrong answers
  const wrongQuestions = detailedBreakdown.filter((q) => !q.isCorrect);
  let wrongQuestionsWithAi = wrongQuestions.map((wq) => ({
    questionId: wq.id,
    question: wq.question,
    chosenText: wq.chosenText,
    correctText: wq.correctText,
    explanation: wq.explanation,
    mistakeExplanation: wq.explanation,
    topicKey: wq.topicKey,
    topicTitle: wq.topicTitle,
  }));

  // AI Mistake Analysis (Groq) for wrong questions
  if (wrongQuestions.length > 0) {
    try {
      const groqMistakeRes = await callGroqJson<{ analyses: Array<{ questionId: string; mistakeExplanation: string }> }>(
        `You are a Senior Socratic Evaluator. Analyze the learner's incorrect quiz answers.
For each question, provide a concise, personalized mistakeExplanation (1-2 sentences) explaining:
1. Why their selected answer is incorrect or reflects a misconception
2. The core principle behind the correct answer
3. How to remember or apply that concept correctly

Return JSON:
{
  "analyses": [
    { "questionId": "...", "mistakeExplanation": "..." }
  ]
}`,
        JSON.stringify({
          stepTitle: step.title,
          mistakes: wrongQuestions.map((wq) => ({
            questionId: wq.id,
            question: wq.question,
            userSelected: wq.chosenText,
            correctAnswer: wq.correctText,
            topic: wq.topicTitle,
          })),
        }),
        {
          validate: (data: any) => {
            if (!data || typeof data !== 'object') throw new Error('Invalid JSON response');
            return data;
          },
          maxTokens: 2500,
          temperature: 0.3,
        }
      );

      if (Array.isArray(groqMistakeRes?.analyses)) {
        const analysisMap = new Map(groqMistakeRes.analyses.map((a) => [a.questionId, a.mistakeExplanation]));
        wrongQuestionsWithAi = wrongQuestionsWithAi.map((wq) => ({
          ...wq,
          mistakeExplanation: analysisMap.get(wq.questionId) || wq.explanation,
        }));
      }
    } catch (gErr) {
      console.warn('[SubmitQuiz] Groq mistake analysis notice:', gErr);
    }
  }

  // IF FAILED (percent < 70) — Source Fresh Remediation Resources
  const remediationResources: Array<{
    id: string;
    topicTitle: string;
    type: 'VIDEO' | 'DOC';
    title: string;
    url: string;
    videoId: string | null;
    domain: string;
    whyWatchOrRead: string;
  }> = [];

  if (!passed) {
    const [existingResources, history] = await Promise.all([
      prisma.resource.findMany({
        where: { step: { workspaceId: step.workspaceId } },
        select: { videoId: true, url: true },
      }),
      prisma.resourceHistory.findMany({
        where: { workspaceId: step.workspaceId },
      }),
    ]);

    const usedVideoIds = new Set<string>();
    const usedDocUrls = new Set<string>();

    for (const r of existingResources) {
      if (r.videoId) usedVideoIds.add(r.videoId);
      if (r.url) {
        usedDocUrls.add(normalizeUrl(r.url));
        const yt = extractYouTubeId(r.url);
        if (yt) usedVideoIds.add(yt);
      }
    }

    for (const h of history) {
      if (h.identifier) {
        usedDocUrls.add(normalizeUrl(h.identifier));
        if (h.identifier.startsWith('yt:')) {
          usedVideoIds.add(h.identifier.slice(3));
        } else {
          const yt = extractYouTubeId(h.identifier);
          if (yt) usedVideoIds.add(yt);
        }
      }
    }

    const weakTopics = Array.from(new Set(wrongQuestions.map((w) => w.topicTitle))).slice(0, 3);
    const workspaceSkill = (step.workspace as any)?.skillName || step.workspace?.title || step.title;

    for (const topicTitle of weakTopics) {
      const vidQuery = `site:youtube.com/watch "${workspaceSkill}" "${topicTitle}" common mistakes explained tutorial`;
      const docQuery = `"${workspaceSkill}" "${topicTitle}" guide examples reference -site:youtube.com`;

      try {
        const [vidResults, docResults] = await Promise.all([
          searchTavily(vidQuery, {
            searchDepth: 'basic',
            maxResults: 6,
            includeDomains: ['youtube.com', 'youtu.be'],
          }).catch(() => []),
          searchTavily(docQuery, {
            searchDepth: 'advanced',
            maxResults: 6,
          }).catch(() => []),
        ]);

        // Find 1 fresh YouTube video
        for (const r of vidResults) {
          const ytId = extractYouTubeId(r.url);
          if (!ytId || usedVideoIds.has(ytId)) continue;
          const ytCheck = await checkYouTube(ytId);
          if (ytCheck.status === 'GONE') continue;

          remediationResources.push({
            id: `rem-vid-${remediationResources.length + 1}`,
            topicTitle,
            type: 'VIDEO',
            title: r.title || `${topicTitle} Video Tutorial`,
            url: r.url,
            videoId: ytId,
            domain: 'youtube.com',
            whyWatchOrRead: `Visual walkthrough of ${topicTitle} mechanics to overcome identified misconception.`,
          });

          usedVideoIds.add(ytId);
          usedDocUrls.add(normalizeUrl(r.url));

          try {
            await prisma.resourceHistory.upsert({
              where: {
                workspaceId_identifier: {
                  workspaceId: step.workspaceId,
                  identifier: `yt:${ytId}`,
                },
              },
              create: {
                workspaceId: step.workspaceId,
                profileId: step.workspace?.profileId || (step.workspace as any)?.userProfileId || 'anonymous',
                stepIndex: step.stepIndex,
                resourceType: 'YOUTUBE_VIDEO',
                identifier: `yt:${ytId}`,
                title: r.title,
                domain: 'youtube.com',
              },
              update: {},
            });
          } catch (_) {}
          break;
        }

        // Find 1 fresh Doc
        for (const r of docResults) {
          const norm = normalizeUrl(r.url);
          if (usedDocUrls.has(norm)) continue;
          if (r.url.includes('youtube.com') || r.url.includes('youtu.be')) continue;
          if (!(await isSafePublicUrl(r.url))) continue;
          const vLink = await verifyLink(r.url);
          if (vLink.status === 'DEAD') continue;

          const finalNorm = normalizeUrl(vLink.finalUrl);
          if (usedDocUrls.has(finalNorm)) continue;

          remediationResources.push({
            id: `rem-doc-${remediationResources.length + 1}`,
            topicTitle,
            type: 'DOC',
            title: r.title || `${topicTitle} Technical Guide`,
            url: vLink.finalUrl,
            videoId: null,
            domain: domainOf(vLink.finalUrl),
            whyWatchOrRead: `Official reference covering foundational principles of ${topicTitle}.`,
          });

          usedDocUrls.add(norm);
          usedDocUrls.add(finalNorm);

          try {
            await prisma.resourceHistory.upsert({
              where: {
                workspaceId_identifier: {
                  workspaceId: step.workspaceId,
                  identifier: finalNorm,
                },
              },
              create: {
                workspaceId: step.workspaceId,
                profileId: step.workspace?.profileId || (step.workspace as any)?.userProfileId || 'anonymous',
                stepIndex: step.stepIndex,
                resourceType: 'DOC',
                identifier: finalNorm,
                title: r.title,
                domain: domainOf(vLink.finalUrl),
              },
              update: {},
            });
          } catch (_) {}
          break;
        }
      } catch (remErr) {
        console.warn('[SubmitQuiz] Remediation search error for topic:', topicTitle, remErr);
      }
    }
  }

  // IF PASSED (percent >= 70) — Unlock Next Step
  const priorPassed = await prisma.attemptResult.findFirst({
    where: { stepId: step.id, passed: true },
  });
  const isFirstTransitionToPassed = passed && !priorPassed;

  let xpEarned = 0;
  let unlockedNextStepId: string | null = null;
  let isFinalStep = false;
  let nextStepIndex: number | null = null;

  if (passed) {
    const allWorkspaceSteps = await prisma.skillStep.findMany({
      where: { workspaceId: step.workspaceId },
      orderBy: { stepIndex: 'asc' },
    });
    const totalSteps = Math.max(allWorkspaceSteps.length, 1);
    const nextStep = allWorkspaceSteps.find((s) => s.stepIndex === step!.stepIndex + 1);
    isFinalStep = step.stepIndex === totalSteps || !nextStep;

    const grandmasterBonus = percent === 100 ? 1000 : 0;
    const completionBonus = isFinalStep ? 1000 : 0;
    xpEarned = isFirstTransitionToPassed
      ? step.stepIndex * 500 + grandmasterBonus + completionBonus
      : 100;

    if (nextStep) {
      const currentTier = step.difficultyTier || 'FOUNDATIONS';
      let nextTier = 'APPLICATIONS';
      if (currentTier === 'FOUNDATIONS') nextTier = 'APPLICATIONS';
      else if (currentTier === 'APPLICATIONS') nextTier = 'OPTIMIZATION';
      else if (currentTier === 'OPTIMIZATION') nextTier = 'MASTERY';
      else nextTier = 'MASTERY';

      const updatedNext = await prisma.skillStep.update({
        where: { id: nextStep.id },
        data: {
          status: 'STUDY_UNGENERATED',
          difficultyTier: nextTier,
        },
      });
      unlockedNextStepId = updatedNext.id;
      nextStepIndex = nextStep.stepIndex;

      try {
        await prisma.workspace.update({
          where: { id: step.workspaceId },
          data: {
            currentStep: Math.max(step.workspace.currentStep, nextStep.stepIndex),
            progress: Math.min(100, Math.floor((step.stepIndex / totalSteps) * 100)),
          },
        });
      } catch (_) {}
    }

    if (isFirstTransitionToPassed) {
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
  }

  // Determine kind: INITIAL | TARGETED_RETEST | PERFECTION
  const priorAttemptCount = await prisma.attemptResult.count({ where: { stepId: step.id } });
  const kind = priorAttemptCount === 0 ? 'INITIAL' : (percent === 100 ? 'PERFECTION' : 'TARGETED_RETEST');

  // Compute byTopic breakdown
  const scoredByTopic = [...new Set(detailedBreakdown.map((r) => r.topicKey ?? 'general'))].map((topicKey) => {
    const rs = detailedBreakdown.filter((r) => (r.topicKey ?? 'general') === topicKey);
    const c = rs.filter((r) => r.isCorrect).length;
    return { topicKey, correct: c, total: rs.length, percent: Math.floor((c * 100) / rs.length) };
  });

  // Persist AttemptResult
  const attemptResult = await prisma.attemptResult.create({
    data: {
      stepId: step.id,
      profileId: step.workspace?.profileId || (step.workspace as any)?.userProfileId,
      kind,
      correctCount,
      totalCount,
      percent,
      passed,
      topicBreakdown: scoredByTopic as any,
    },
  });

  // Also maintain QuizAttempt for backwards compatibility
  await prisma.quizAttempt.create({
    data: {
      id: attemptResult.id,
      stepId: step.id,
      score: percent,
      scorePercent: percent,
      correctCount,
      totalCount,
      questionCount: totalCount,
      attemptNumber: priorAttemptCount + 1,
      passed,
      status: 'completed',
      results: detailedBreakdown as any,
      breakdown: scoredByTopic as any,
      completedAt: new Date(),
    },
  });

  // Update current step status
  await prisma.skillStep.update({
    where: { id: step.id },
    data: {
      status: passed ? 'PASSED' : 'FAILED_REMEDIATION',
    },
  });

  // Module 2.1: Atomically update user profile telemetry & live quiz accuracy
  try {
    const targetProfileId = step.workspace?.userProfileId || (step.workspace as any)?.profileId || 'default-profile';
    const userProfile = await prisma.userProfile.findFirst({
      where: {
        OR: [
          { id: targetProfileId },
          { email: targetProfileId },
        ],
      },
    });

    if (userProfile) {
      const newTotalQuizzesTaken = (userProfile.totalQuizzesTaken || 0) + 1;
      const newTotalQuestionsAttempted = (userProfile.totalQuestionsAttempted || 0) + totalCount;
      const newTotalQuestionsCorrect = (userProfile.totalQuestionsCorrect || 0) + correctCount;
      const newAvgQuizAccuracy = newTotalQuestionsAttempted > 0
        ? Math.round((newTotalQuestionsCorrect / newTotalQuestionsAttempted) * 100)
        : 0;

      let newTotalXp = userProfile.totalXp || 0;
      let newLevel = userProfile.level || 1;
      let newCurrentStreak = userProfile.currentStreak || 1;
      let newLongestStreak = userProfile.longestStreak || 1;

      if (isFirstTransitionToPassed) {
        const bonusXp = percent === 100 ? 150 : 100;
        newTotalXp += bonusXp;
        newLevel = Math.floor(newTotalXp / 300) + 1;

        const now = new Date();
        const lastActive = userProfile.lastActiveDate ? new Date(userProfile.lastActiveDate) : null;
        if (lastActive) {
          const diffMs = now.getTime() - lastActive.getTime();
          const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
          if (diffDays === 1) {
            newCurrentStreak += 1;
            if (newCurrentStreak > newLongestStreak) newLongestStreak = newCurrentStreak;
          } else if (diffDays > 1) {
            newCurrentStreak = 1;
          }
        } else {
          newCurrentStreak = 1;
          newLongestStreak = Math.max(newLongestStreak, 1);
        }
      }

      await prisma.userProfile.update({
        where: { id: userProfile.id },
        data: {
          totalQuizzesTaken: newTotalQuizzesTaken,
          totalQuestionsAttempted: newTotalQuestionsAttempted,
          totalQuestionsCorrect: newTotalQuestionsCorrect,
          avgQuizAccuracy: newAvgQuizAccuracy,
          totalXp: newTotalXp,
          level: newLevel,
          currentStreak: newCurrentStreak,
          longestStreak: newLongestStreak,
          lastActiveDate: new Date(),
        },
      });

      if (userProfile.email) {
        try {
          await prisma.$queryRawUnsafe(`
            UPDATE users SET
              total_quizzes_taken = $1,
              total_questions_attempted = $2,
              total_questions_correct = $3,
              avg_quiz_accuracy = $4,
              xp = $5,
              level = $6,
              current_streak = $7,
              longest_streak = $8,
              last_active_date = CURRENT_DATE,
              updated_at = NOW()
            WHERE LOWER(email) = $9;
          `, newTotalQuizzesTaken, newTotalQuestionsAttempted, newTotalQuestionsCorrect, newAvgQuizAccuracy, newTotalXp, newLevel, newCurrentStreak, newLongestStreak, userProfile.email.toLowerCase().trim());
        } catch (_) {}
      }
    }
  } catch (profErr) {
    console.warn('[SubmitQuiz] Telemetry update notice:', profErr);
  }

  // Generate analysis
  let analysis: any = null;
  try {
    analysis = await generateEvaluationAnalysis(attemptResult.id);
  } catch (_) {}

  return {
    id: attemptResult.id,
    evaluationId: attemptResult.id,
    attemptNumber: priorAttemptCount + 1,
    kind,
    score: percent,
    scorePercent: percent,
    percent,
    correctCount,
    totalCount,
    requiredCorrect: Math.ceil((70 * totalCount) / 100),
    passed,
    passThresholdPercent: 70,
    passThreshold: 70,
    isPerfect: percent === 100,
    wrongQuestions: wrongQuestionsWithAi,
    remediationResources,
    aiSummary: analysis?.headline || (passed ? 'Milestone competency verified at 70% threshold.' : 'Targeted remediation required before retest.'),
    nextStepUnlocked: passed && Boolean(unlockedNextStepId),
    nextStepId: unlockedNextStepId,
    nextStepIndex,
    byTopic: scoredByTopic,
    chapters: scoredByTopic,
    results: detailedBreakdown,
    analysis,
    isFirstTransitionToPassed,
    xpEarned,
    isFinalStep,
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
