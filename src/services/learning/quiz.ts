import { prisma } from '../../lib/prisma';
import { LEARNING_CONFIG } from '../../config/learning';
import {
  callGroqJson,
  assertNoUrls,
  searchTavily,
  canonicalKey,
  registrableDomain,
  extractYouTubeId,
  checkYouTube,
  verifyLink,
  isSafePublicUrl,
} from './foundation';

export interface QuizQuestionOption {
  id: string;
  text: string;
  position: number;
  isCorrect?: boolean;
}

export interface QuizQuestionRaw {
  anchorId: string;
  chapterKey: string;
  question: string;
  correctAnswer: string;
  distractors: string[];
  explanation: string;
}

export interface StoredQuizQuestion {
  id: string;
  anchorId: string;
  chapterKey: string;
  question: string;
  explanation: string;
  correctOptionId: string;
  options: QuizQuestionOption[];
}

function shuffle<T>(a: T[]): T[] {
  const r = [...a];
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}

export function buildBalancedQuestions(raw: QuizQuestionRaw[]): StoredQuizQuestion[] {
  const targets = shuffle(raw.map((_, i) => i % 4)); // as even as possible across A-D (positions 0-3)
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
      anchorId: q.anchorId,
      chapterKey: q.chapterKey,
      question: q.question,
      explanation: q.explanation,
      correctOptionId: correctOpt.id,
      options: positionedOptions,
    };
  });
}

// 14.5 DETERMINISTIC GRADING
export function gradeAttempt(
  questions: { id: string; chapterKey: string; correctOptionId: string }[],
  answers: Record<string, string>,
  thresholdPercent: number = LEARNING_CONFIG.PASS_THRESHOLD_PERCENT
) {
  const total = questions.length; // from the DB, never from the request
  if (total === 0) throw new Error('Cannot grade an empty evaluation');

  let correct = 0;
  const per = new Map<string, { correct: number; total: number }>();

  for (const q of questions) {
    const ok = answers[q.id] === q.correctOptionId; // unanswered = wrong; unknown ids ignored
    if (ok) correct++;
    const c = per.get(q.chapterKey) ?? { correct: 0, total: 0 };
    c.total++;
    if (ok) c.correct++;
    per.set(q.chapterKey, c);
  }

  const requiredCorrect = Math.floor((thresholdPercent * total + 99) / 100); // integer ceil, no float error

  return {
    total,
    correct,
    percent: Math.round((correct * 100) / total),
    requiredCorrect,
    passed: correct >= requiredCorrect, // compares counts, never a rounded percent
    chapters: [...per].map(([chapterKey, v]) => ({
      chapterKey,
      ...v,
      percent: Math.round((v.correct * 100) / v.total),
    })),
  };
}

// 14.1 & 14.2 GENERATE LEVEL UP QUIZ
export async function generateLevelUpQuiz(stepId: string) {
  const step = await prisma.skillStep.findUnique({
    where: { id: stepId },
    include: {
      chapters: {
        orderBy: { orderIndex: 'asc' },
        include: {
          resources: { where: { isPrimary: true } },
        },
      },
      attempts: { orderBy: { createdAt: 'desc' }, take: 1 },
    },
  });

  if (!step) {
    throw new Error('Step not found');
  }

  if (step.chapters.length === 0) {
    const err: any = new Error('Build the curriculum first');
    err.statusCode = 409;
    throw err;
  }

  // Collect anchors across chapters
  interface UsableAnchor {
    id: string;
    chapterKey: string;
    chapterTitle: string;
    text: string;
    origin: 'SOURCE_TEXT' | 'CHAPTER_OBJECTIVE';
  }

  const allAnchors: UsableAnchor[] = [];
  for (const ch of step.chapters) {
    const anchorsRaw = Array.isArray(ch.anchors) ? (ch.anchors as any[]) : [];
    for (const a of anchorsRaw) {
      if (a?.id && a?.text) {
        allAnchors.push({
          id: a.id,
          chapterKey: ch.key,
          chapterTitle: ch.title,
          text: a.text,
          origin: a.origin === 'SOURCE_TEXT' ? 'SOURCE_TEXT' : 'CHAPTER_OBJECTIVE',
        });
      }
    }
  }

  if (allAnchors.length < LEARNING_CONFIG.QUIZ_MIN_QUESTIONS) {
    const err: any = new Error('Not enough key ideas — rebuild the curriculum or replace thin resources');
    err.statusCode = 409;
    throw err;
  }

  // Count coverage
  const sourceTextCount = allAnchors.filter((a) => a.origin === 'SOURCE_TEXT').length;
  const objectiveCount = allAnchors.filter((a) => a.origin === 'CHAPTER_OBJECTIVE').length;

  // Decide target question count between QUIZ_MIN and QUIZ_MAX
  const targetCount = Math.min(
    LEARNING_CONFIG.QUIZ_MAX_QUESTIONS,
    Math.max(LEARNING_CONFIG.QUIZ_MIN_QUESTIONS, allAnchors.length)
  );

  // Maximum share of objective anchors
  const maxObjectiveQuestions = Math.floor(targetCount * LEARNING_CONFIG.QUIZ_MAX_OBJECTIVE_RATIO);

  // Select anchors: spread across chapters, SOURCE_TEXT first
  const selectedAnchors: UsableAnchor[] = [];
  const sourceAnchors = allAnchors.filter((a) => a.origin === 'SOURCE_TEXT');
  const objectiveAnchors = allAnchors.filter((a) => a.origin === 'CHAPTER_OBJECTIVE');

  // Spread source anchors
  for (const a of sourceAnchors) {
    if (selectedAnchors.length < targetCount) {
      selectedAnchors.push(a);
    }
  }

  // Fill with objective anchors up to maxObjectiveQuestions
  let objAdded = 0;
  for (const a of objectiveAnchors) {
    if (selectedAnchors.length < targetCount && objAdded < maxObjectiveQuestions) {
      selectedAnchors.push(a);
      objAdded++;
    }
  }

  // If still under min, add whatever anchors remain
  for (const a of allAnchors) {
    if (selectedAnchors.length < LEARNING_CONFIG.QUIZ_MIN_QUESTIONS && !selectedAnchors.includes(a)) {
      selectedAnchors.push(a);
    }
  }

  const promptSystem = `You are the Lead Psychometric Examiner for SKILL-TRACK.
Create rigorous, multiple-choice evaluation questions based EXCLUSIVELY on the provided Key Ideas (Anchors).

REQUIREMENTS:
1. Generate ${selectedAnchors.length} questions, with each question testing EXACTLY ONE provided Anchor.
2. The correct answer MUST be directly supported by that anchor's statement.
3. For each question, provide EXACTLY 3 distractors representing plausible misconceptions for that concept.
4. EQUAL LENGTH RULE: All 4 options (correctAnswer + 3 distractors) MUST be comparable in word count (within 10% length, or differing by at most 1 word for short options).
5. "explanation": 1-2 clear sentences explaining why the correct answer is accurate and why misconceptions fail.
6. NO URLs. Do NOT mention "the video", "the document", "the author", or "the text". State principles directly.

Return ONLY JSON:
{
  "questions": [
    {
      "anchorId": "c1-a1",
      "question": "Clear realistic scenario or challenge question...",
      "correctAnswer": "Accurate option text",
      "distractors": ["Plausible distractor 1", "Plausible distractor 2", "Plausible distractor 3"],
      "explanation": "Diagnostic reasoning..."
    }
  ]
}`;

  const promptUser = JSON.stringify({
    stepTitle: step.title,
    chapters: step.chapters.map((c) => ({ key: c.key, title: c.title })),
    anchors: selectedAnchors.map((a) => ({
      id: a.id,
      chapterKey: a.chapterKey,
      chapterTitle: a.chapterTitle,
      text: a.text,
      origin: a.origin,
    })),
  });

  const anchorMap = new Map(selectedAnchors.map((a) => [a.id, a]));

  const groqRes = await callGroqJson<{ questions: any[] }>(promptSystem, promptUser, {
    validate: (data: any) => {
      assertNoUrls(data, 'Quiz');
      if (!data || !Array.isArray(data.questions)) throw new Error('Missing questions array');
      if (data.questions.length < LEARNING_CONFIG.QUIZ_MIN_QUESTIONS) {
        throw new Error(`Expected at least ${LEARNING_CONFIG.QUIZ_MIN_QUESTIONS} questions, got ${data.questions.length}`);
      }
      return data;
    },
    maxTokens: 3500,
    temperature: 0.25,
  });

  // Server validation: anchorId exists, counts in range, 3 distractors, 4 distinct options, equal length
  const validRawQuestions: QuizQuestionRaw[] = [];
  for (const q of groqRes.questions) {
    const anchor = anchorMap.get(q.anchorId);
    if (!anchor) continue;
    if (typeof q.question !== 'string' || !q.question.trim()) continue;
    if (typeof q.correctAnswer !== 'string' || !q.correctAnswer.trim()) continue;
    if (!Array.isArray(q.distractors) || q.distractors.length !== 3) continue;

    const allOpts = [q.correctAnswer, ...q.distractors];
    const uniqueOpts = new Set(allOpts.map((s: string) => s.trim().toLowerCase()));
    if (uniqueOpts.size !== 4) continue;

    validRawQuestions.push({
      anchorId: q.anchorId,
      chapterKey: anchor.chapterKey,
      question: q.question.trim(),
      correctAnswer: q.correctAnswer.trim(),
      distractors: q.distractors.map((d: any) => String(d).trim()),
      explanation: (q.explanation || '').trim(),
    });
  }

  if (validRawQuestions.length < LEARNING_CONFIG.QUIZ_MIN_QUESTIONS) {
    throw new Error('Not enough generated questions passed server psychometric validation');
  }

  // CODE places correct answers evenly across positions (0-3)
  const balancedQuestions = buildBalancedQuestions(validRawQuestions);

  // Save blueprint to Step
  await prisma.skillStep.update({
    where: { id: step.id },
    data: {
      quizBlueprint: balancedQuestions as any,
      questionCount: balancedQuestions.length,
    },
  });

  // Calculate prior attempts count
  const priorAttemptsCount = await prisma.quizAttempt.count({
    where: { stepId: step.id },
  });

  // Create new QuizAttempt row
  const attempt = await prisma.quizAttempt.create({
    data: {
      stepId: step.id,
      score: 0,
      scorePercent: 0,
      correctCount: 0,
      questionCount: balancedQuestions.length,
      totalCount: balancedQuestions.length,
      attemptNumber: priorAttemptsCount + 1,
      passed: false,
      status: 'in_progress',
      questions: balancedQuestions as any,
    },
  });

  // Covered chapters set
  const coveredChapterKeys = Array.from(new Set(balancedQuestions.map((q) => q.chapterKey)));

  // Sanitized questions sent to browser: NEVER expose isCorrect, correctOptionId, or anchor text
  const sanitized = balancedQuestions.map((q) => ({
    id: q.id,
    chapterKey: q.chapterKey,
    question: q.question,
    options: q.options.map((o) => ({
      id: o.id,
      text: o.text,
      position: o.position,
    })),
  }));

  return {
    attemptId: attempt.id,
    questions: sanitized,
    questionCount: sanitized.length,
    passingThreshold: LEARNING_CONFIG.PASS_THRESHOLD_PERCENT,
    coveredChapters: coveredChapterKeys,
    anchorCoverage: {
      totalAnchors: allAnchors.length,
      sourceTextCount,
      objectiveCount,
    },
  };
}

// 14.5 SUBMIT AND GRADE QUIZ
export async function submitQuizAnswers(stepId: string, payload: {
  attemptId?: string;
  answers: Record<string, string>;
}) {
  const step = await prisma.skillStep.findUnique({
    where: { id: stepId },
    include: {
      workspace: true,
      chapters: true,
    },
  });

  if (!step) throw new Error('Step not found');

  const questions: StoredQuizQuestion[] = Array.isArray(step.quizBlueprint)
    ? (step.quizBlueprint as any)
    : [];

  if (questions.length === 0) {
    throw new Error('No active quiz blueprint found for step');
  }

  // Server-side deterministic grading
  const grade = gradeAttempt(questions, payload.answers, LEARNING_CONFIG.PASS_THRESHOLD_PERCENT);

  // Build question breakdown
  const detailedBreakdown = questions.map((q) => {
    const chosenOptionId = payload.answers[q.id];
    const isCorrect = chosenOptionId === q.correctOptionId;
    const chosenOption = q.options.find((o) => o.id === chosenOptionId);
    const correctOption = q.options.find((o) => o.id === q.correctOptionId);
    const chapter = step.chapters.find((c) => c.key === q.chapterKey);

    return {
      id: q.id,
      anchorId: q.anchorId,
      chapterKey: q.chapterKey,
      chapterTitle: chapter?.title || q.chapterKey,
      question: q.question,
      chosenOptionId: chosenOptionId || null,
      chosenOptionText: chosenOption?.text || null,
      correctOptionId: q.correctOptionId,
      correctOptionText: correctOption?.text || null,
      isCorrect,
      explanation: q.explanation,
    };
  });

  // Check if previously passed to grant XP and advance unlock ONLY ONCE
  const priorPassed = await prisma.quizAttempt.findFirst({
    where: { stepId: step.id, passed: true },
  });
  const isFirstTransitionToPassed = grade.passed && !priorPassed;

  // Next step unlock and XP calculation
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

    const grandmasterBonus = grade.percent === 100 ? 1000 : 0;
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
      } catch (_) {
        try {
          await (prisma as any).profile.update({
            where: { id: profileId },
            data: { totalXp: { increment: xpEarned } },
          });
        } catch (_) {}
      }
    }
  }

  // Update or create QuizAttempt
  let targetAttemptId = payload.attemptId;
  let attemptNumber = 1;

  if (targetAttemptId) {
    const existingAttempt = await prisma.quizAttempt.findUnique({
      where: { id: targetAttemptId },
    });
    if (existingAttempt) {
      attemptNumber = existingAttempt.attemptNumber;
      await prisma.quizAttempt.update({
        where: { id: targetAttemptId },
        data: {
          score: grade.percent,
          scorePercent: grade.percent,
          correctCount: grade.correct,
          totalCount: grade.total,
          passed: grade.passed,
          status: 'completed',
          results: detailedBreakdown as any,
          breakdown: grade.chapters as any,
          completedAt: new Date(),
        },
      });
    }
  } else {
    const count = await prisma.quizAttempt.count({ where: { stepId: step.id } });
    attemptNumber = count + 1;
    const created = await prisma.quizAttempt.create({
      data: {
        stepId: step.id,
        score: grade.percent,
        scorePercent: grade.percent,
        correctCount: grade.correct,
        totalCount: grade.total,
        questionCount: grade.total,
        attemptNumber,
        passed: grade.passed,
        status: 'completed',
        results: detailedBreakdown as any,
        breakdown: grade.chapters as any,
        completedAt: new Date(),
      },
    });
    targetAttemptId = created.id;
  }

  // Update step status
  await prisma.skillStep.update({
    where: { id: step.id },
    data: {
      status: grade.passed ? 'PASSED' : 'FAILED_REMEDIATION',
    },
  });

  return {
    evaluationId: targetAttemptId,
    attemptNumber,
    score: grade.percent,
    scorePercent: grade.percent,
    correctCount: grade.correct,
    totalCount: grade.total,
    requiredCorrect: grade.requiredCorrect,
    passed: grade.passed,
    passThresholdPercent: LEARNING_CONFIG.PASS_THRESHOLD_PERCENT,
    chapters: grade.chapters,
    results: detailedBreakdown,
    isFirstTransitionToPassed,
    xpEarned,
    isFinalStep,
    nextStepIndex,
    unlockedNextStepId,
  };
}

// 14.6 AI ANALYSIS (AI-written, code-constrained, R8)
export async function generateEvaluationAnalysis(evaluationId: string, languageCode = 'en') {
  const attempt = await prisma.quizAttempt.findUnique({
    where: { id: evaluationId },
    include: {
      step: {
        include: {
          chapters: true,
          workspace: true,
        },
      },
    },
  });

  if (!attempt) throw new Error('Evaluation not found');

  const results: any[] = Array.isArray(attempt.results) ? (attempt.results as any[]) : [];
  const chaptersBreakdown: any[] = Array.isArray(attempt.breakdown) ? (attempt.breakdown as any[]) : [];
  const missedQuestions = results.filter((r) => !r.isCorrect);

  const chaptersMap = new Map(attempt.step.chapters.map((c) => [c.key, c.title]));

  const promptSystem = `You are the Lead Socratic Evaluator for SKILL-TRACK.
Provide an objective, constructive evaluation analysis of the learner's milestone evaluation.
Strict Rules:
- Language: Output in "${languageCode}".
- DO NOT recompute, alter, or contradict the official test scores.
- Be blunt, specific, and actionable. Never inflated or generic.
- Headline: 5-8 words summarizing performance.
- Summary: At most 40 words.
- Strengths: Highlight specific chapters where they succeeded.
- Gaps: For missed areas, explain what went wrong and how to fix it.
- NextActions: Exactly 3 concrete, active study/practice actions.
- Encouragement: One brief, grounded closing sentence.
- NO URLs anywhere in the output.

Return ONLY JSON:
{
  "headline": "...",
  "summary": "...",
  "strengths": [ { "chapterKey": "c1", "note": "..." } ],
  "gaps": [ { "chapterKey": "c2", "whatWentWrong": "...", "fix": "..." } ],
  "nextActions": ["Action 1", "Action 2", "Action 3"],
  "encouragement": "..."
}`;

  const promptUser = JSON.stringify({
    scorePercent: attempt.scorePercent,
    correctCount: attempt.correctCount,
    totalCount: attempt.totalCount || results.length,
    passed: attempt.passed,
    chapters: chaptersBreakdown,
    missedQuestions: missedQuestions.map((m) => ({
      chapterKey: m.chapterKey,
      chapterTitle: m.chapterTitle,
      question: m.question,
      chosenOptionText: m.chosenOptionText,
      correctOptionText: m.correctOptionText,
      explanation: m.explanation,
    })),
  });

  const allowedNumbers = new Set<number>([
    attempt.scorePercent,
    attempt.correctCount,
    attempt.totalCount || results.length,
    LEARNING_CONFIG.PASS_THRESHOLD_PERCENT,
    ...chaptersBreakdown.map((c) => c.percent),
    ...chaptersBreakdown.map((c) => c.correct),
    ...chaptersBreakdown.map((c) => c.total),
  ]);

  let analysis: any = null;
  try {
    analysis = await callGroqJson<any>(promptSystem, promptUser, {
      validate: (data: any) => {
        assertNoUrls(data, 'Analysis');
        if (!data || !data.headline || !data.summary || !Array.isArray(data.nextActions)) {
          throw new Error('Missing fields in analysis JSON');
        }

        // Validate number consistency: numbers mentioned should match allowed stats
        const allText = JSON.stringify(data);
        const numbersFound = allText.match(/\b\d{1,3}\b/g) || [];
        for (const numStr of numbersFound) {
          const num = parseInt(numStr, 10);
          if (num > 0 && num <= 100) {
            // If it appears to be a percentage or count, check if plausible
            // We allow reasonable day/action indexes or allowed numbers
            const isPlausible = allowedNumbers.has(num) || num <= 10;
            if (!isPlausible) {
              throw new Error(`Model fabricated score or metric number: ${num}`);
            }
          }
        }
        return data;
      },
      maxTokens: 1800,
      temperature: 0.2,
      retryCount: 1,
    });
  } catch (err: any) {
    console.warn('[quiz] Groq analysis generation failed, using code-built summary:', err.message);
    const weakestChapter = chaptersBreakdown.sort((a, b) => a.percent - b.percent)[0];
    analysis = {
      headline: attempt.passed ? 'Milestone Benchmark Achieved' : 'Target Threshold Not Yet Reached',
      summary: `You scored ${attempt.scorePercent}% (${attempt.correctCount} of ${attempt.totalCount}). Pass threshold is ${LEARNING_CONFIG.PASS_THRESHOLD_PERCENT}%.`,
      strengths: chaptersBreakdown
        .filter((c) => c.percent >= LEARNING_CONFIG.PASS_THRESHOLD_PERCENT)
        .map((c) => ({
          chapterKey: c.chapterKey,
          note: `Strong comprehension demonstrated in ${chaptersMap.get(c.chapterKey) || c.chapterKey}.`,
        })),
      gaps: chaptersBreakdown
        .filter((c) => c.percent < LEARNING_CONFIG.PASS_THRESHOLD_PERCENT)
        .map((c) => ({
          chapterKey: c.chapterKey,
          whatWentWrong: `Inconsistent accuracy (${c.correct}/${c.total}) in ${chaptersMap.get(c.chapterKey) || c.chapterKey}.`,
          fix: 'Review the chapter approach guide and focus on the core execution mechanic.',
        })),
      nextActions: [
        `Revisit the primary resource for ${weakestChapter ? chaptersMap.get(weakestChapter.chapterKey) || weakestChapter.chapterKey : 'weakest areas'}.`,
        'Self-check your understanding against the chapter checklist before retesting.',
        'Retake the milestone evaluation when ready to meet the 70% threshold.',
      ],
      encouragement: attempt.passed
        ? 'Great execution. You are ready to advance to the next milestone.'
        : 'Deliberate review of the identified gaps will bridge the difference on your next attempt.',
    };
  }

  // Store in QuizAttempt
  await prisma.quizAttempt.update({
    where: { id: attempt.id },
    data: {
      analysis: analysis as any,
      analysisLanguage: languageCode,
    },
  });

  return analysis;
}

// 14.8 REMEDIATION SEARCH
export async function findRemediationResources(stepId: string, chapterKey?: string) {
  const step = await prisma.skillStep.findUnique({
    where: { id: stepId },
    include: {
      workspace: true,
      chapters: { include: { resources: true } },
    },
  });

  if (!step) throw new Error('Step not found');

  const history = await prisma.resourceHistory.findMany({
    where: { workspaceId: step.workspaceId },
  });
  const historyIdentifiers = new Set(history.map((h) => h.identifier));

  const targetChapters = chapterKey
    ? step.chapters.filter((c) => c.key === chapterKey)
    : step.chapters;

  const remediationLinks: Array<{
    type: 'video' | 'doc';
    title: string;
    url: string;
    domain: string;
    snippet: string;
    embeddable?: boolean;
    videoId?: string | null;
  }> = [];

  for (const ch of targetChapters) {
    const docQuery = `${step.workspace.title} ${ch.title} deep dive guide`;
    const vidQuery = `${step.workspace.title} ${ch.title} tutorial breakdown`;

    const [docRes, vidRes] = await Promise.all([
      searchTavily(docQuery, { searchDepth: 'advanced', maxResults: 4 }),
      searchTavily(vidQuery, {
        searchDepth: 'basic',
        maxResults: 4,
        includeDomains: ['youtube.com'],
      }),
    ]);

    for (const r of [...docRes, ...vidRes]) {
      const key = canonicalKey(r.url);
      if (historyIdentifiers.has(key)) continue;
      if (!(await isSafePublicUrl(r.url))) continue;

      const ytId = extractYouTubeId(r.url);
      let embeddable = true;
      if (ytId) {
        const yt = await checkYouTube(ytId);
        if (yt.status === 'GONE') continue;
        if (yt.status === 'NO_EMBED') embeddable = false;
      }

      const status = await verifyLink(r.url);
      if (status === 'DEAD') continue;

      remediationLinks.push({
        type: ytId ? 'video' : 'doc',
        title: r.title,
        url: r.url,
        domain: registrableDomain(r.url),
        snippet: (r.content || '').slice(0, 220),
        embeddable,
        videoId: ytId,
      });

      // Save to ResourceHistory
      await prisma.resourceHistory.upsert({
        where: {
          workspaceId_identifier: {
            workspaceId: step.workspaceId,
            identifier: key,
          },
        },
        create: {
          profileId: step.workspace.profileId || (step.workspace as any).userProfileId || 'default-profile',
          workspaceId: step.workspaceId,
          stepIndex: step.stepIndex,
          resourceType: ytId ? 'YOUTUBE_VIDEO' : 'DOC_URL',
          identifier: key,
          title: r.title,
          domain: registrableDomain(r.url),
        },
        update: {
          title: r.title,
        },
      });

      if (remediationLinks.length >= 4) break;
    }
  }

  return remediationLinks;
}
