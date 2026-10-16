import prisma from '../../lib/prisma';
import { claimQuizBuild } from './packPipeline';
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
  sourceTopic?: string;
  sourceResourceTitle?: string;
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
  sourceTopic?: string;
  sourceResourceTitle?: string;
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
      sourceTopic: q.sourceTopic || q.topicKey,
      sourceResourceTitle: q.sourceResourceTitle || undefined,
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

function computeQuestionSimilarity(a: string, b: string): number {
  const getWords = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .split(/\s+/)
        .filter((w) => w.length >= 3)
    );
  const wordsA = getWords(a);
  const wordsB = getWords(b);
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let matches = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) matches++;
  }
  const union = new Set([...wordsA, ...wordsB]).size;
  return union > 0 ? matches / union : 0;
}

// 11.1 RUN QUIZ BUILD (BUILT FROM STORED FACTS WITH STRICT WORKSPACE ANTI-DUPLICATION)
export async function runQuizBuild(stepId: string): Promise<void> {
  const step: any = await prisma.skillStep.findUnique({
    where: { id: stepId },
    include: {
      workspace: true,
      stepChapters: { orderBy: { order: 'asc' } },
      stepTopics: {
        include: { resources: true },
        orderBy: { order: 'asc' },
      },
    },
  });

  if (!step) throw new Error('Step not found');

  // 1. GLOBAL WORKSPACE QUESTION TRACKER: Fetch questions previously generated for earlier steps
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
    orderBy: { stepIndex: 'asc' },
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

  const readyTopics: any[] = step.stepTopics.length > 0
    ? step.stepTopics
    : [
        {
          id: `${step.id}-t1`,
          key: 't1',
          title: `${step.title} Fundamentals`,
          covers: 'Foundational principles and operational standards',
          guide: { howToApproach: 'Apply core mechanics systematically.', keyPoints: [`${step.title} requires verified execution of core baseline techniques.`] },
          facts: [`${step.title} requires verified execution of core baseline techniques.`],
          acuIds: ['acu-1'],
          resources: [],
        } as any,
      ];

  // 2. BUILD STEP N RESOURCE DOSSIER
  const stepChapters = (step as any).stepChapters || [];
  const stepResources = (step as any).resources || [];

  const docResources: Array<{ title: string; domain: string; snippet: string; topicTitle?: string }> = [];
  const videoResources: Array<{ title: string; topicTitle?: string }> = [];

  for (const topic of readyTopics) {
    if (Array.isArray(topic.resources)) {
      for (const r of topic.resources) {
        if (r.type === 'doc' && r.title) {
          docResources.push({
            title: r.title,
            domain: r.domain || '',
            snippet: r.snippet || '',
            topicTitle: topic.title,
          });
        } else if (r.type === 'video' && r.title) {
          videoResources.push({
            title: r.title,
            topicTitle: topic.title,
          });
        }
      }
    }
  }

  for (const r of stepResources) {
    if (r.type === 'doc' && r.title && !docResources.some((d) => d.title === r.title)) {
      docResources.push({
        title: r.title,
        domain: r.domain || '',
        snippet: r.snippet || '',
      });
    } else if (r.type === 'video' && r.title && !videoResources.some((v) => v.title === r.title)) {
      videoResources.push({
        title: r.title,
      });
    }
  }

  let dossier = `=== STEP N IDENTIFIERS ===\nStep Index: ${step.stepIndex}\nStep Title: "${step.title}"\nDifficulty Tier: ${step.difficultyTier || 'FOUNDATIONS'}\nFocus: ${step.focus || step.title}\n`;
  if (step.intro && typeof step.intro === 'object') {
    const intro: any = step.intro;
    if (intro.goal) dossier += `Goal: ${intro.goal}\n`;
    if (intro.whyNow) dossier += `Context: ${intro.whyNow}\n`;
    if (Array.isArray(intro.commonMistakes)) {
      dossier += `Common Pitfalls to Avoid:\n${intro.commonMistakes.map((m: string) => `  - ${m}`).join('\n')}\n`;
    }
  }

  dossier += `\n=== STEP CHAPTERS ===\n`;
  for (const ch of stepChapters) {
    dossier += `Chapter: "${ch.title}" (${ch.overview || 'Core section'})\n`;
  }

  dossier += `\n=== STEP TOPICS & DEEP TECHNICAL GUIDES ===\n`;
  for (const t of readyTopics) {
    dossier += `\n[TOPIC: "${t.title}"]\n`;
    if (t.covers) dossier += `Covers: ${t.covers}\n`;
    const g: any = t.guide || {};
    if (g.howToApproach) dossier += `How to Approach: ${g.howToApproach}\n`;
    if (Array.isArray(g.keyPoints)) {
      dossier += `Key Technical Principles:\n${g.keyPoints.map((kp: string) => `  * ${kp}`).join('\n')}\n`;
    } else if (Array.isArray(g.lookFor)) {
      dossier += `Observational Cues:\n${g.lookFor.map((lf: string) => `  * ${lf}`).join('\n')}\n`;
    }
    if (g.practiceTask || g.doThis) dossier += `Practice Execution: ${g.practiceTask || g.doThis}\n`;
    if (Array.isArray(g.commonMistakes)) {
      dossier += `Common Errors in this Topic:\n${g.commonMistakes.map((cm: string) => `  ! ${cm}`).join('\n')}\n`;
    }
  }

  dossier += `\n=== VERIFIED READING DOCUMENTS & SPECIFICATIONS ===\n`;
  if (docResources.length > 0) {
    for (const doc of docResources) {
      dossier += `- Document: "${doc.title}" [${doc.domain}] (Topic: ${doc.topicTitle || 'General'})\n  Summary: ${doc.snippet}\n`;
    }
  } else {
    dossier += `(Synthesize questions from the topic technical guides above.)\n`;
  }

  if (videoResources.length > 0) {
    dossier += `\n=== VERIFIED VIDEO LECTURES ===\n`;
    for (const vid of videoResources) {
      dossier += `- Video Lecture: "${vid.title}"\n`;
    }
  }

  if (step.trainingPlan && typeof step.trainingPlan === 'object') {
    const tp: any = step.trainingPlan;
    if (Array.isArray(tp.days)) {
      dossier += `\n=== ATHLETIC DRILLS & TECHNICAL KINEMATICS ===\n`;
      for (const d of tp.days.slice(0, 3)) {
        if (Array.isArray(d.items)) {
          for (const item of d.items.slice(0, 3)) {
            dossier += `Drill: "${item.name}" (Kinematics: ${item.howToSteps?.join(', ') || ''}; Safety: ${item.medicalSafetyNote || ''})\n`;
          }
        }
      }
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

    const promptSystem = `You are the Lead Psychometric Examiner for SKILL-TRACK.
Generate ${targetCount} Multiple-Choice Questions for Step ${step.stepIndex} ("${step.title}").

MANDATORY RULES:
1. 100% RESOURCE GROUNDED: Every question MUST be derived directly from the STEP RESOURCE DOSSIER provided. Test specific techniques, code patterns, kinematics, rules, and common mistakes explicitly detailed in the dossier.
2. ZERO QUESTIONS ABOUT TIMERS OR UI APPARATUS: Do not ask questions about how many seconds a timer ran or app UI buttons. Ask about substantive domain knowledge and execution.
3. ABSOLUTE ANTI-DUPLICATION: The following questions were already asked in earlier steps of this workspace. You MUST NOT repeat, paraphrase, or ask anything substantially similar to these prior questions:
${previousQuestionSignatures.length > 0 ? previousQuestionSignatures.slice(-30).map((q, i) => `${i + 1}. "${q}"`).join('\n') : '(None. This is Step 1).'}
4. MANDATORY TRACEABILITY:
   For every question you MUST output:
   - "sourceTopic": The exact title of the Topic from the dossier that this question tests.
   - "sourceResourceTitle": The specific Reading Document title, Study Guide, or Video Lecture title from which this question was derived.
   - "explanation": Concrete technical explanation referencing the step's material.
5. OPTION QUALITY:
   - Exactly 4 options per question: 1 correctAnswer + 3 plausible distractors of comparable word length.
   - Evenly distribute the correct answer across all 4 positions (A, B, C, D).
6. NO EXTERNAL URLS: State technical principles directly without including http links.

Return ONLY JSON:
{
  "questions": [
    {
      "topicKey": "t1",
      "sourceTopic": "Exact Topic Title",
      "sourceResourceTitle": "Specific Document / Guide Title",
      "acuId": "acu-1",
      "question": "Scenario or diagnostic application question...",
      "correctAnswer": "Accurate option text",
      "distractors": ["Plausible distractor 1", "Plausible distractor 2", "Plausible distractor 3"],
      "explanation": "Diagnostic reasoning referencing the study material..."
    }
  ]
}`;

    const promptUser = JSON.stringify({
      stepTitle: step.title,
      stepIndex: step.stepIndex,
      skillName: step.workspace?.skillName || step.workspace?.title || '',
      difficultyTier: step.difficultyTier,
      resourceDossier: dossier,
      topics: readyTopics.map((t) => ({ key: t.key, title: t.title })),
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

    // STRICT DEDUPLICATION (>75% TEXTUAL SIMILARITY DISCARDED)
    for (const q of rawQuestions) {
      const topic = readyTopics.find((t) => t.key === q.topicKey || t.title.toLowerCase() === (q.sourceTopic || '').toLowerCase()) || readyTopics[0];
      if (!topic) continue;
      if (!q.question || typeof q.question !== 'string') continue;
      if (!q.correctAnswer || typeof q.correctAnswer !== 'string') continue;
      if (!Array.isArray(q.distractors) || q.distractors.length < 3) continue;

      const candidateQ = q.question.trim();

      // Check similarity against prior step questions
      const isDuplicateOfPrior = previousQuestionSignatures.some(
        (prevQ) => computeQuestionSimilarity(candidateQ, prevQ) > 0.75
      );
      if (isDuplicateOfPrior) {
        console.warn(`[runQuizBuild] Discarding duplicate question from earlier step: "${candidateQ}"`);
        continue;
      }

      // Check similarity against questions already accepted in current quiz
      const isDuplicateInCurrent = validQuestions.some(
        (existingQ) => computeQuestionSimilarity(candidateQ, existingQ.question) > 0.75
      );
      if (isDuplicateInCurrent) {
        console.warn(`[runQuizBuild] Discarding intra-quiz duplicate question: "${candidateQ}"`);
        continue;
      }

      validQuestions.push({
        topicKey: topic.key,
        topicId: topic.id,
        resourceId: topic.resources?.[0]?.id,
        evidenceFact: q.explanation || `${topic.title} verified standard`,
        acuId: q.acuId || `${topic.key}-acu`,
        question: candidateQ,
        correctAnswer: q.correctAnswer.trim(),
        distractors: q.distractors.slice(0, 3).map((d: any) => String(d).trim()),
        explanation: (q.explanation || `Supported by verified principles of ${topic.title}`).trim(),
        sourceTopic: q.sourceTopic || topic.title,
        sourceResourceTitle: q.sourceResourceTitle || topic.resources?.[0]?.title || `${topic.title} Guide`,
      });
    }

    // RESOURCE-DERIVED DETERMINISTIC FALLBACK (IF NEEDED — NEVER GENERIC STATIC TEMPLATES!)
    if (validQuestions.length < targetCount) {
      for (const topic of readyTopics) {
        if (validQuestions.length >= targetCount) break;
        const guide = (topic.guide || {}) as any;
        const keyPoints: string[] = Array.isArray(guide.keyPoints)
          ? guide.keyPoints
          : Array.isArray(guide.lookFor)
          ? guide.lookFor
          : (Array.isArray(topic.facts) ? (topic.facts as string[]) : []);
        const commonMistakes: string[] = Array.isArray(guide.commonMistakes) ? guide.commonMistakes : [];
        const topicDoc = docResources.find((d) => d.topicTitle === topic.title) || docResources[0];

        // 1. Question from Key Points
        if (keyPoints.length > 0) {
          const kp = keyPoints[validQuestions.length % keyPoints.length];
          const candidateQ = `In Step ${step.stepIndex} (${topic.title}), what essential technical principle is emphasized for verified execution?`;
          const isDupe =
            previousQuestionSignatures.some((pq) => computeQuestionSimilarity(candidateQ, pq) > 0.75) ||
            validQuestions.some((vq) => computeQuestionSimilarity(candidateQ, vq.question) > 0.75);

          if (!isDupe) {
            validQuestions.push({
              topicKey: topic.key,
              topicId: topic.id,
              resourceId: topic.resources?.[0]?.id,
              evidenceFact: kp,
              acuId: `${topic.key}-acu`,
              question: candidateQ,
              correctAnswer: kp,
              distractors: [
                `Prioritize speed over kinematic form when executing ${topic.title}.`,
                `Omit preliminary verification checks once familiar with ${topic.title}.`,
                `Rely entirely on subjective guesswork rather than calibrated technique.`,
              ],
              explanation: `Documented in the ${topic.title} curriculum: "${kp}".`,
              sourceTopic: topic.title,
              sourceResourceTitle: topicDoc?.title || `${topic.title} Guide`,
            });
          }
        }

        // 2. Question from Common Mistakes
        if (validQuestions.length < targetCount && commonMistakes.length > 0) {
          const cm = commonMistakes[validQuestions.length % commonMistakes.length];
          const candidateQ = `When executing "${topic.title}", which specific pitfall must be proactively avoided?`;
          const isDupe =
            previousQuestionSignatures.some((pq) => computeQuestionSimilarity(candidateQ, pq) > 0.75) ||
            validQuestions.some((vq) => computeQuestionSimilarity(candidateQ, vq.question) > 0.75);

          if (!isDupe) {
            validQuestions.push({
              topicKey: topic.key,
              topicId: topic.id,
              resourceId: topic.resources?.[0]?.id,
              evidenceFact: cm,
              acuId: `${topic.key}-acu`,
              question: candidateQ,
              correctAnswer: cm,
              distractors: [
                `Maintaining consistent alignment and deliberate biomechanical pacing.`,
                `Following structured incremental progression through each milestone.`,
                `Reviewing diagnostic feedback before repeating the cycle.`,
              ],
              explanation: `In the study material for ${topic.title}, a critical mistake to prevent is: "${cm}".`,
              sourceTopic: topic.title,
              sourceResourceTitle: topicDoc?.title || `${topic.title} Error Prevention Guide`,
            });
          }
        }

        // 3. Question from Verified Document snippet
        if (validQuestions.length < targetCount && topicDoc && topicDoc.snippet) {
          const sentences = topicDoc.snippet.split(/[.!?]/).map((s: string) => s.trim()).filter((s: string) => s.length > 20);
          if (sentences.length > 0) {
            const correctFact = sentences[0];
            const candidateQ = `According to the reference text for "${topic.title}", which operational standard applies?`;
            const isDupe =
              previousQuestionSignatures.some((pq) => computeQuestionSimilarity(candidateQ, pq) > 0.75) ||
              validQuestions.some((vq) => computeQuestionSimilarity(candidateQ, vq.question) > 0.75);

            if (!isDupe) {
              validQuestions.push({
                topicKey: topic.key,
                topicId: topic.id,
                resourceId: topic.resources?.[0]?.id,
                evidenceFact: correctFact,
                acuId: `${topic.key}-acu`,
                question: candidateQ,
                correctAnswer: correctFact,
                distractors: [
                  `Baseline standards are purely discretionary and may be altered arbitrarily.`,
                  `Technique should vary unpredictably between consecutive training blocks.`,
                  `Prerequisite safety checks can be bypassed in accelerated sessions.`,
                ],
                explanation: `Referenced directly from "${topicDoc.title}": ${correctFact}`,
                sourceTopic: topic.title,
                sourceResourceTitle: topicDoc.title,
              });
            }
          }
        }
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

  // 1. PREREQUISITE GUARD: Ensure Step N's study pack is READY before building quiz
  if (step.packStatus !== 'READY' || step.stepTopics.length === 0) {
    console.log(`[generateLevelUpQuiz] Step ${step.id} pack not READY (status: ${step.packStatus}). Triggering pack build now...`);
    const isSports =
      (step.workspace as any)?.category === 'SPORTS' ||
      step.workspace?.domainCategory === 'sports' ||
      step.workspace?.domain === 'sports' ||
      Boolean((step.workspace as any)?.isSports);

    try {
      if (isSports) {
        const { runSportsPackBuild } = await import('../sports/sportsPackBuilder');
        await runSportsPackBuild(step.id);
      } else {
        const { runPackBuild: triggerPackBuild } = await import('./packBuilder');
        await triggerPackBuild(step.id);
      }
    } catch (buildErr) {
      console.warn(`[generateLevelUpQuiz] Pack build error (non-fatal, continuing to reload):`, buildErr);
    }

    const reloaded = await prisma.skillStep.findUnique({
      where: { id: step.id },
      include: {
        workspace: true,
        stepTopics: { include: { resources: true } },
      },
    });
    if (reloaded) step = reloaded;
  }

  const isRetestOrPerfection =
    options?.mode === 'retest' ||
    options?.mode === 'perfection' ||
    Boolean(options?.retestMode) ||
    Boolean(options?.perfectionMode);

  // 2. DETECT & PURGE STALE / DUPLICATE / GENERIC QUIZZES
  const existingBlueprint = Array.isArray(step.quizBlueprint) ? (step.quizBlueprint as any[]) : [];
  
  const isStaleQuiz = existingBlueprint.some((q) => {
    const qText = (q?.question || '').toLowerCase();
    return (
      qText.includes('which principle accurately characterizes verified execution') ||
      qText.includes('what key verification ensures precision') ||
      qText.includes('proper operational form in') ||
      qText.includes('deliberate practice isolating') ||
      !q.question ||
      !Array.isArray(q.options) ||
      q.options.length < 4
    );
  });

  // Cross-step duplicate check against prior steps
  let hasCrossStepDuplicate = false;
  if (!isStaleQuiz && existingBlueprint.length > 0) {
    const priorSteps = await prisma.skillStep.findMany({
      where: {
        workspaceId: step.workspaceId,
        id: { not: step.id },
        stepIndex: { lt: step.stepIndex },
      },
      select: { quizBlueprint: true },
    });
    const priorQuestions: string[] = [];
    for (const ps of priorSteps) {
      if (Array.isArray(ps.quizBlueprint)) {
        for (const pq of ps.quizBlueprint as any[]) {
          if (pq?.question) priorQuestions.push(pq.question.trim().toLowerCase());
        }
      }
    }
    hasCrossStepDuplicate = existingBlueprint.some((q) =>
      priorQuestions.includes((q?.question || '').trim().toLowerCase())
    );
  }

  if (
    isRetestOrPerfection ||
    step.quizStatus !== 'READY' ||
    existingBlueprint.length === 0 ||
    isStaleQuiz ||
    hasCrossStepDuplicate
  ) {
    if (isStaleQuiz || hasCrossStepDuplicate) {
      console.log(`[generateLevelUpQuiz] Purging stale/duplicate quiz for Step ${step.id} (stale: ${isStaleQuiz}, crossStepDupe: ${hasCrossStepDuplicate})`);
      await prisma.skillStep.update({
        where: { id: step.id },
        data: { quizBlueprint: [] as any, quizStatus: 'NOT_STARTED' },
      });
    }
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
      topicTitle: topic?.title || q.sourceTopic || q.topicKey,
      sourceTopic: q.sourceTopic || topic?.title || q.topicKey,
      sourceResourceTitle: q.sourceResourceTitle || undefined,
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
      topicTitle: topic?.title || q.sourceTopic || q.topicKey,
      sourceTopic: q.sourceTopic || topic?.title || q.topicKey,
      sourceResourceTitle: q.sourceResourceTitle || topic?.resources?.[0]?.title,
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

  // Identify wrong answers baseline
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

  // Baseline deterministic remediation resources from step's own topics
  let remediationResources: Array<{
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
    const weakTopics = Array.from(new Set(wrongQuestions.map((w) => w.topicTitle))).slice(0, 3);
    for (let i = 0; i < weakTopics.length; i++) {
      const wTitle = weakTopics[i];
      const matchTopic = step.stepTopics.find((t) => t.title === wTitle || t.key === wTitle);
      const docRes = matchTopic?.resources.find((r) => r.type === 'doc');
      const vidRes = matchTopic?.resources.find((r) => r.type === 'youtube' || Boolean(r.videoId));

      if (vidRes) {
        remediationResources.push({
          id: `rem-vid-${remediationResources.length + 1}`,
          topicTitle: wTitle,
          type: 'VIDEO',
          title: vidRes.title || `${wTitle} Tutorial`,
          url: vidRes.url,
          videoId: vidRes.videoId,
          domain: 'youtube.com',
          whyWatchOrRead: `Visual walkthrough of ${wTitle} mechanics to overcome identified misconception.`,
        });
      }
      if (docRes) {
        remediationResources.push({
          id: `rem-doc-${remediationResources.length + 1}`,
          topicTitle: wTitle,
          type: 'DOC',
          title: docRes.title || `${wTitle} Technical Guide`,
          url: docRes.url,
          videoId: null,
          domain: docRes.domain || 'reference.org',
          whyWatchOrRead: `Official reference covering foundational principles of ${wTitle}.`,
        });
      }
    }
  }

  // IF PASSED (percent >= 70) — Immediately unlock Next Step in PostgreSQL
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

  // Bounded AI Enrichment: Skip completely on pass (zero delay); cap at 3500ms on fail
  if (!passed) {
    try {
      const enrichPromise = async () => {
        // 1. Groq Mistake Analysis
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
                maxTokens: 1500,
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
          } catch (_) {}
        }

        // 2. Parallel Tavily Remediation Search for failed step
        try {
          const weakTopics = Array.from(new Set(wrongQuestions.map((w) => w.topicTitle))).slice(0, 2);
          const workspaceSkill = (step.workspace as any)?.skillName || step.workspace?.title || step.title;
          const freshRemediation: typeof remediationResources = [];

          const topicSearchPromises = weakTopics.map(async (topicTitle) => {
            const vidQuery = `site:youtube.com/watch "${workspaceSkill}" "${topicTitle}" mistakes tutorial`;
            const docQuery = `"${workspaceSkill}" "${topicTitle}" guide examples -site:youtube.com`;

            const [vidResults, docResults] = await Promise.all([
              searchTavily(vidQuery, { searchDepth: 'basic', maxResults: 3, includeDomains: ['youtube.com', 'youtu.be'] }).catch(() => []),
              searchTavily(docQuery, { searchDepth: 'basic', maxResults: 3 }).catch(() => []),
            ]);

            for (const r of vidResults) {
              const ytId = extractYouTubeId(r.url);
              if (ytId) {
                freshRemediation.push({
                  id: `rem-vid-${freshRemediation.length + 1}`,
                  topicTitle,
                  type: 'VIDEO',
                  title: r.title || `${topicTitle} Tutorial`,
                  url: r.url,
                  videoId: ytId,
                  domain: 'youtube.com',
                  whyWatchOrRead: `Visual walkthrough of ${topicTitle} mechanics.`,
                });
                break;
              }
            }

            for (const r of docResults) {
              if (!r.url.includes('youtube.com')) {
                freshRemediation.push({
                  id: `rem-doc-${freshRemediation.length + 1}`,
                  topicTitle,
                  type: 'DOC',
                  title: r.title || `${topicTitle} Guide`,
                  url: r.url,
                  videoId: null,
                  domain: domainOf(r.url),
                  whyWatchOrRead: `Reference covering core principles of ${topicTitle}.`,
                });
                break;
              }
            }
          });

          await Promise.all(topicSearchPromises);

          if (freshRemediation.length > 0) {
            remediationResources = freshRemediation;
          }
        } catch (_) {}
      };

      const timeoutPromise = new Promise((resolve) => setTimeout(resolve, 3500));
      await Promise.race([enrichPromise(), timeoutPromise]);
    } catch (enrichErr) {
      console.warn('[SubmitQuiz] Bounded AI enrichment notice:', enrichErr);
    }
  }


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

  // Instant structured analysis (non-blocking, 0ms latency)
  const analysis = {
    headline: passed
      ? (percent === 100 ? 'Flawless Socratic Gate Performance (100%)' : `Milestone Verified at ${percent}% Threshold`)
      : `Threshold Not Met (${percent}%) — Remediation Required`,
    summary: passed
      ? `Demonstrated verified operational grasp of ${step.title}. You have met the 70% threshold.`
      : `Scored ${percent}%. Socratic gate requires 70% to unlock milestone progression. Complete the targeted remediation items below.`,
    strengthAreas: scoredByTopic.filter((t) => t.percent >= 70).map((t) => t.topicKey),
    growthAreas: scoredByTopic.filter((t) => t.percent < 70).map((t) => t.topicKey),
    recommendation: passed ? 'Proceed to next milestone or take targeted perfection quiz for 100%.' : 'Review weak topics and retest.',
  };

  // If passed and next step is unlocked, prefetch Step N+1's quiz in the background
  if (passed && unlockedNextStepId) {
    void Promise.allSettled([
      claimQuizBuild(unlockedNextStepId).then((c) => {
        if (c) return runQuizBuild(unlockedNextStepId);
      }),
    ]);
  }

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
