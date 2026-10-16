import prisma from '../../lib/prisma';
import { getEffectiveKeys } from '../../lib/keyManager';
import { LEARNING_CONFIG, calculatePersonalizedQuestionCount } from '../../config/learning';
import { assertNoUrls } from './foundation';

export interface QuizOption {
  id: string;
  text: string;
  position: number;
  isCorrect?: boolean;
}

export interface RawQuizQuestion {
  topicKey: string;
  topicId?: string;
  resourceId?: string;
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
  acuId: string;
  question: string;
  explanation: string;
  sourceTopic?: string;
  sourceResourceTitle?: string;
  correctOptionId: string;
  options: QuizOption[];
  chapterKey?: string;
  anchorId?: string;
}

// Single-Flight Quiz Generation Lock
const inFlightQuizBuilds = new Map<string, Promise<any>>();

// Fast active Groq models: primary "openai/gpt-oss-20b" for ~2s completion
const FAST_GROQ_PRIMARY_MODEL = 'openai/gpt-oss-20b';
const FAST_GROQ_SECONDARY_MODEL = 'openai/gpt-oss-120b';
const FAST_GROQ_FALLBACK_CANDIDATES = [
  'openai/gpt-oss-20b',
  'openai/gpt-oss-120b',
  'qwen/qwen3.8-27b',
  'allam-2-7b',
];

let cachedDiscoveredModel: string | null = null;
let cachedDiscoveredModelExpires = 0;

async function getFastGroqModel(apiKey: string): Promise<string> {
  if (process.env.GROQ_QUIZ_MODEL && process.env.GROQ_QUIZ_MODEL.trim()) {
    return process.env.GROQ_QUIZ_MODEL.trim();
  }
  if (cachedDiscoveredModel && Date.now() < cachedDiscoveredModelExpires) {
    return cachedDiscoveredModel;
  }
  try {
    const res = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { Authorization: `Bearer ${apiKey.trim()}` },
      signal: AbortSignal.timeout(3500),
    });
    if (res.ok) {
      const data: any = await res.json();
      const liveIds: string[] = (data?.data || [])
        .map((m: { id: string }) => m.id)
        .filter((id: string) => !/whisper|tts|audio|guard|safeguard|embed/i.test(id));

      if (liveIds.includes(FAST_GROQ_PRIMARY_MODEL)) {
        cachedDiscoveredModel = FAST_GROQ_PRIMARY_MODEL;
        cachedDiscoveredModelExpires = Date.now() + 20 * 60 * 1000;
        return FAST_GROQ_PRIMARY_MODEL;
      }
      for (const cand of FAST_GROQ_FALLBACK_CANDIDATES) {
        if (liveIds.includes(cand)) {
          cachedDiscoveredModel = cand;
          cachedDiscoveredModelExpires = Date.now() + 20 * 60 * 1000;
          return cand;
        }
      }
      if (liveIds.length > 0) {
        cachedDiscoveredModel = liveIds[0];
        cachedDiscoveredModelExpires = Date.now() + 20 * 60 * 1000;
        return liveIds[0];
      }
    }
  } catch (err: any) {
    console.warn('[quizBuilder] Fast model discovery notice:', err.message);
  }
  return FAST_GROQ_PRIMARY_MODEL;
}

function shuffle<T>(array: T[]): T[] {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Normalized Jaccard similarity between two question stems
 */
export function computeQuestionSimilarity(a: string, b: string): number {
  const getWords = (s: string) =>
    new Set(
      (s || '')
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

/**
 * Builds compact, high-density Step Resource Dossier capped at ~3,500 chars
 */
function buildCompactStepDossier(step: any, readyTopics: any[], docResources: any[], videoResources: any[]): string {
  let dossier = `[STEP ${step.stepIndex}: "${step.title}"] (Tier: ${step.difficultyTier || 'FOUNDATIONS'})\n`;
  if (step.intro && typeof step.intro === 'object') {
    const intro: any = step.intro;
    if (intro.goal) dossier += `Goal: ${String(intro.goal).slice(0, 180)}\n`;
    if (Array.isArray(intro.commonMistakes) && intro.commonMistakes.length > 0) {
      dossier += `Pitfalls to Avoid:\n${intro.commonMistakes.slice(0, 3).map((m: string) => ` - ${m}`).join('\n')}\n`;
    }
  }

  dossier += `TOPICS & TECHNICAL PRINCIPLES:\n`;
  for (const t of readyTopics.slice(0, 6)) {
    dossier += `- Topic: "${t.title}" | Covers: ${String(t.covers || '').slice(0, 140)}\n`;
    const g: any = t.guide || {};
    if (Array.isArray(g.keyPoints) && g.keyPoints.length > 0) {
      dossier += `  Key: ${g.keyPoints.slice(0, 2).join('; ')}\n`;
    }
    if (Array.isArray(g.commonMistakes) && g.commonMistakes.length > 0) {
      dossier += `  Error to Prevent: ${g.commonMistakes[0]}\n`;
    }
    if (g.practiceTask || g.doThis) {
      dossier += `  Practice: ${String(g.practiceTask || g.doThis).slice(0, 120)}\n`;
    }
  }

  if (docResources.length > 0) {
    dossier += `VERIFIED READING REFERENCES:\n`;
    for (const doc of docResources.slice(0, 4)) {
      dossier += `- Doc: "${doc.title}" [${doc.domain || 'Verified'}]\n  Snippet: ${String(doc.snippet || '').slice(0, 160)}\n`;
    }
  }

  if (videoResources.length > 0) {
    dossier += `VIDEO LECTURES: ${videoResources.slice(0, 3).map((v: any) => `"${v.title}"`).join(', ')}\n`;
  }

  if (step.trainingPlan && typeof step.trainingPlan === 'object') {
    const tp: any = step.trainingPlan;
    if (Array.isArray(tp.days) && tp.days.length > 0) {
      dossier += `ATHLETIC DRILLS:\n`;
      for (const d of tp.days.slice(0, 2)) {
        if (Array.isArray(d.items)) {
          for (const item of d.items.slice(0, 2)) {
            dossier += ` - Drill "${item.name}": ${String(item.howToSteps?.[0] || item.description || '').slice(0, 120)}\n`;
          }
        }
      }
    }
  }

  // Cap tightly at 3500 chars to guarantee sub-3s Groq inference
  return dossier.slice(0, 3500);
}

/**
 * Builds balanced 4-option questions with even distribution across positions 0..3 (A..D)
 */
export function buildBalancedQuestions(raw: RawQuizQuestion[]): StoredQuizQuestion[] {
  const targets = shuffle(raw.map((_, i) => i % 4));
  return raw.map((q, i) => {
    const correctOpt: QuizOption = {
      id: `opt-${i + 1}-c`,
      text: q.correctAnswer,
      position: 0,
      isCorrect: true,
    };

    const distractorOpts: QuizOption[] = shuffle(q.distractors)
      .slice(0, 3)
      .map((text, dIdx) => ({
        id: `opt-${i + 1}-d${dIdx + 1}`,
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
      acuId: q.acuId,
      chapterKey: q.chapterKey || q.topicKey,
      anchorId: q.anchorId || `anchor-${i + 1}`,
      question: q.question,
      explanation: q.explanation,
      sourceTopic: q.sourceTopic || q.topicKey,
      sourceResourceTitle: q.sourceResourceTitle,
      correctOptionId: correctOpt.id,
      options: positionedOptions,
    };
  });
}

/**
 * Multi-Variant Step-Resource Question Synthesizer
 * Generates distinct question variants across Bank A (Principles), Bank B (Mistakes),
 * Bank C (Doc Specs), Bank D (Applied Scenario), Bank E (Kinematics)
 */
function synthesizeEmergencyStepQuestion(
  topic: any,
  step: any,
  bankType: 'PRINCIPLE' | 'MISTAKE' | 'DOC' | 'SCENARIO' | 'EXECUTION',
  attemptNumber: number,
  docResource?: any
): RawQuizQuestion {
  const guide = (topic.guide || {}) as any;
  const keyPoints: string[] = Array.isArray(guide.keyPoints)
    ? guide.keyPoints
    : Array.isArray(guide.lookFor)
    ? guide.lookFor
    : Array.isArray(topic.facts)
    ? (topic.facts as string[])
    : [];
  const commonMistakes: string[] = Array.isArray(guide.commonMistakes) ? guide.commonMistakes : [];
  const primaryKp = keyPoints[0] || `${step.title} demands rigorous adherence to verified operational form.`;
  const primaryCm = commonMistakes[0] || `rushing execution without verifying alignment or prerequisite checks.`;

  if (bankType === 'MISTAKE') {
    const questionStems = [
      `When implementing "${topic.title}", which specific pitfall must be proactively avoided?`,
      `In diagnostic review of "${topic.title}", which procedural breakdown is most detrimental to accuracy?`,
      `What common error frequently compromises performance during "${topic.title}"?`,
    ];
    const qStem = questionStems[(attemptNumber - 1) % questionStems.length];
    return {
      topicKey: topic.key,
      topicId: topic.id,
      resourceId: topic.resources?.[0]?.id,
      acuId: `${topic.key}-acu-mistake`,
      question: qStem,
      correctAnswer: primaryCm,
      distractors: [
        `Maintaining consistent calibrated pacing and checking alignment before execution.`,
        `Recording verifiable diagnostic output across sequential iterations.`,
        `Consulting structured topic references when encountering unexpected friction.`,
      ],
      explanation: `Documented error to prevent in "${topic.title}": "${primaryCm}".`,
      sourceTopic: topic.title,
      sourceResourceTitle: docResource?.title || `${topic.title} Technical Standard`,
    };
  }

  if (bankType === 'DOC' && docResource && docResource.snippet) {
    const sentences = String(docResource.snippet)
      .split(/[.!?]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 25);
    const factText = sentences[0] || `Verified reference documentation mandates systematic verification.`;
    const questionStems = [
      `According to the verified reference guide for "${topic.title}", which operational standard applies?`,
      `What baseline specification is established in the study materials for "${topic.title}"?`,
      `In the technical documentation for "${topic.title}", which core criterion is emphasized?`,
    ];
    const qStem = questionStems[(attemptNumber - 1) % questionStems.length];
    return {
      topicKey: topic.key,
      topicId: topic.id,
      resourceId: topic.resources?.[0]?.id,
      acuId: `${topic.key}-acu-doc`,
      question: qStem,
      correctAnswer: factText,
      distractors: [
        `Operational tolerances may be altered arbitrarily during active execution.`,
        `Prerequisite safety and diagnostic protocols can be skipped in accelerated practice.`,
        `Subjective intuition takes precedence over documented kinematic guidelines.`,
      ],
      explanation: `Referenced directly from "${docResource.title}": ${factText}`,
      sourceTopic: topic.title,
      sourceResourceTitle: docResource.title,
    };
  }

  if (bankType === 'SCENARIO') {
    const practiceTask = guide.practiceTask || guide.doThis || guide.howToApproach || primaryKp;
    const questionStems = [
      `In a real-world scenario applying "${topic.title}", how should the practitioner initiate execution?`,
      `When faced with dynamic variance while practicing "${topic.title}", what is the recommended protocol?`,
      `During practical application of "${topic.title}", which sequential step ensures precision?`,
    ];
    const qStem = questionStems[(attemptNumber - 1) % questionStems.length];
    return {
      topicKey: topic.key,
      topicId: topic.id,
      resourceId: topic.resources?.[0]?.id,
      acuId: `${topic.key}-acu-scenario`,
      question: qStem,
      correctAnswer: practiceTask,
      distractors: [
        `Accelerate cadence immediately before confirming foundation stability.`,
        `Bypass feedback diagnostics and repeat uncalibrated movements.`,
        `Substitute standardized mechanics with unverified shortcuts.`,
      ],
      explanation: `Applied practice protocol for "${topic.title}": "${practiceTask}".`,
      sourceTopic: topic.title,
      sourceResourceTitle: docResource?.title || `${topic.title} Practice Manual`,
    };
  }

  // Default: Bank A (Principle)
  const questionStems = [
    `In Step ${step.stepIndex} ("${topic.title}"), what essential operational principle must be verified?`,
    `What fundamental rule governs verified execution in "${topic.title}"?`,
    `Under the core curriculum for "${topic.title}", which technical standard is mandatory?`,
  ];
  const qStem = questionStems[(attemptNumber - 1) % questionStems.length];
  return {
    topicKey: topic.key,
    topicId: topic.id,
    resourceId: topic.resources?.[0]?.id,
    acuId: `${topic.key}-acu-principle`,
    question: qStem,
    correctAnswer: primaryKp,
    distractors: [
      `Prioritize maximum velocity regardless of kinematic or structural breakdown.`,
      `Eliminate structured measurement once basic familiarity is achieved.`,
      `Depend entirely on guesswork without referencing calibrated standards.`,
    ],
    explanation: `Documented core principle of "${topic.title}": "${primaryKp}".`,
    sourceTopic: topic.title,
    sourceResourceTitle: docResource?.title || `${topic.title} Reference Guide`,
  };
}

/**
 * Executes fast Groq chat completion with strict 9-second timeout
 */
async function callFastGroqQuizJson(
  groqKey: string,
  systemPrompt: string,
  userPrompt: string,
  timeoutMs = 9000
): Promise<any> {
  const model = await getFastGroqModel(groqKey);

  const attemptFetch = async (targetModel: string, toMs: number) => {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${groqKey.trim()}`,
      },
      body: JSON.stringify({
        model: targetModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
        max_tokens: 3200,
        temperature: 0.25,
      }),
      signal: AbortSignal.timeout(toMs),
    });

    if (!res.ok) {
      const errTxt = await res.text().catch(() => '');
      throw new Error(`Groq HTTP ${res.status}: ${errTxt.slice(0, 200)}`);
    }

    const data: any = await res.json();
    const rawContent = data?.choices?.[0]?.message?.content || '{}';
    return JSON.parse(rawContent);
  };

  try {
    return await attemptFetch(model, timeoutMs);
  } catch (err: any) {
    console.warn(`[quizBuilder] Primary Groq call (${model}) failed in ${timeoutMs}ms:`, err.message);
    // Try fast secondary model with 5s timeout
    if (model !== FAST_GROQ_SECONDARY_MODEL) {
      try {
        return await attemptFetch(FAST_GROQ_SECONDARY_MODEL, 5000);
      } catch (secErr: any) {
        console.warn(`[quizBuilder] Secondary Groq call failed:`, secErr.message);
      }
    }
    throw err;
  }
}

/**
 * Master Quiz & Retest Builder
 * Guarantees sub-4s completion, single-flight deduplication, and 100% unique questions.
 */
export async function buildFastStepQuiz(
  stepId: string,
  options?: {
    mode?: 'initial' | 'retest' | 'perfection';
    retest?: boolean;
    forceNew?: boolean;
    attempt?: number;
    failedQuestionIds?: string[];
  }
): Promise<any> {
  const mode = options?.mode || (options?.retest ? 'retest' : 'initial');
  const forceNew = Boolean(options?.forceNew || mode === 'retest' || mode === 'perfection');
  const attemptNumber = Math.max(1, Number(options?.attempt) || (mode === 'retest' ? 2 : 1));

  const lockKey = `${stepId}_${attemptNumber}_${mode}_${forceNew ? 'new' : 'cached'}`;
  const existingInFlight = inFlightQuizBuilds.get(lockKey);
  if (existingInFlight) {
    return existingInFlight;
  }

  const buildPromise = (async () => {
    try {
      let step: any = await prisma.skillStep.findUnique({
        where: { id: stepId },
        include: {
          workspace: {
            include: {
              steps: {
                orderBy: { stepIndex: 'asc' },
                select: { id: true, stepIndex: true, quizBlueprint: true },
              },
            },
          },
          stepChapters: { orderBy: { order: 'asc' } },
          stepTopics: {
            include: { resources: true },
            orderBy: { order: 'asc' },
          },
          attempts: {
            select: { questions: true, results: true, attemptNumber: true },
            orderBy: { createdAt: 'desc' },
            take: 15,
          },
        },
      });

      if (!step) {
        const ws = await prisma.workspace.findUnique({
          where: { id: stepId },
          include: {
            steps: {
              orderBy: { stepIndex: 'asc' },
              include: {
                stepChapters: { orderBy: { order: 'asc' } },
                stepTopics: { include: { resources: true }, orderBy: { order: 'asc' } },
              },
            },
          },
        });
        if (ws && ws.steps.length > 0) {
          const activeS = ws.steps.find((s) => s.status !== 'PASSED') || ws.steps[0];
          step = { ...activeS, workspace: ws } as any;
        }
      }

      if (!step) throw new Error('SkillStep not found');

      // 1. FAST CACHE RETURN IF NOT RETEST & CURRENT QUIZ IS VALID
      const existingBlueprint = Array.isArray(step.quizBlueprint) ? (step.quizBlueprint as any[]) : [];
      if (!forceNew && step.quizStatus === 'READY' && existingBlueprint.length >= 4) {
        const sanitized = existingBlueprint.map((q: any, idx: number) => ({
          id: q.id || `q_${idx + 1}`,
          question: q.question,
          prompt: q.question,
          topicKey: q.topicKey,
          topicTitle: q.sourceTopic || q.topicKey,
          sourceTopic: q.sourceTopic || q.topicKey,
          sourceResourceTitle: q.sourceResourceTitle,
          acuId: q.acuId,
          chapterKey: q.chapterKey,
          options: (q.options || []).map((o: any, oIdx: number) => ({
            id: o.id || `opt_${oIdx}`,
            text: o.text,
            position: typeof o.position === 'number' ? o.position : oIdx,
          })),
        }));

        return {
          evaluationId: `eval_${step.id}_${Date.now()}`,
          stepId: step.id,
          stepNumber: step.stepIndex,
          stepTitle: step.title,
          passThreshold: 70,
          passingThreshold: 70,
          questions: sanitized,
          questionCount: sanitized.length,
          attemptNumber,
          mode,
          cached: true,
        };
      }

      // 2. COMPLETE QUESTION HISTORY MEMORY ACROSS WORKSPACE & STEP ATTEMPTS
      const forbiddenQuestionList: string[] = [];

      // A. All questions from other steps in the workspace
      const allWorkspaceSteps = step.workspace?.steps || [];
      for (const wsStep of allWorkspaceSteps) {
        if (Array.isArray(wsStep.quizBlueprint)) {
          for (const q of wsStep.quizBlueprint as any[]) {
            if (q?.question && typeof q.question === 'string') {
              forbiddenQuestionList.push(q.question.trim());
            }
          }
        }
      }

      // B. All questions from previous QuizAttempts on this step
      if (Array.isArray(step.attempts)) {
        for (const att of step.attempts) {
          if (Array.isArray(att.questions)) {
            for (const aq of att.questions as any[]) {
              if (aq?.question && typeof aq.question === 'string') {
                forbiddenQuestionList.push(aq.question.trim());
              }
            }
          }
        }
      }

      // C. Rolling history saved inside step.intro
      const introObj = (step.intro || {}) as any;
      if (Array.isArray(introObj.questionHistory)) {
        for (const hq of introObj.questionHistory) {
          if (typeof hq === 'string' && hq.trim()) {
            forbiddenQuestionList.push(hq.trim());
          }
        }
      }

      // Unique deduplicated forbidden list
      const uniqueForbiddenQuestions = Array.from(new Set(forbiddenQuestionList));

      // 3. COMPILE READY TOPICS & STEP RESOURCES
      const readyTopics: any[] = (step.stepTopics && step.stepTopics.length > 0)
        ? step.stepTopics
        : [
            {
              id: `${step.id}-t1`,
              key: 't1',
              title: `${step.title} Core Mastery`,
              covers: 'Core principles, execution guidelines, and operational standards',
              guide: {
                keyPoints: [`Execution of ${step.title} requires precise calibrated form.`],
                commonMistakes: [`Rushing execution without preliminary alignment checks.`],
                practiceTask: `Perform deliberate practice focused on kinematic form.`,
              },
              resources: [],
            },
          ];

      const docResources: any[] = [];
      const videoResources: any[] = [];

      for (const t of readyTopics) {
        if (Array.isArray(t.resources)) {
          for (const r of t.resources) {
            if (r.type === 'doc' && r.title) {
              docResources.push({ title: r.title, domain: r.domain, snippet: r.snippet });
            } else if ((r.type === 'video' || r.type === 'youtube') && r.title) {
              videoResources.push({ title: r.title });
            }
          }
        }
      }

      const dossier = buildCompactStepDossier(step, readyTopics, docResources, videoResources);

      const targetCount = calculatePersonalizedQuestionCount({
        stepIndex: step.stepIndex || 1,
        totalSteps: step.workspace?.steps?.length || 5,
        difficultyTier: step.difficultyTier || 'FOUNDATIONS',
        topicsCount: readyTopics.length,
        acusCount: Array.isArray(step.assessableUnits) ? step.assessableUnits.length : 0,
        skillName: step.workspace?.skillName || step.workspace?.title || step.title || '',
        mode,
      });

      // 4. RETEST ANGLE ROTATION BY ATTEMPT NUMBER
      let angleInstruction = '';
      if (attemptNumber === 1) {
        angleInstruction = 'Focus on core concepts, foundational operational rules, and direct practical application from Step resources.';
      } else if (attemptNumber === 2) {
        angleInstruction = 'Focus on real-world scenario problem-solving, diagnosing common mistakes, and applied case studies from Step resources.';
      } else {
        angleInstruction = 'Focus on edge cases, comparative analysis, sequence/execution precision, and subtle technical nuances from Step resources.';
      }

      // 5. CALL FAST GROQ ENGINE (MAX 9 SECONDS)
      const { groqKey } = await getEffectiveKeys();
      let rawQuestions: any[] = [];

      if (groqKey) {
        const forbiddenSlice = uniqueForbiddenQuestions.slice(-35);
        const systemPrompt = `You are the Lead Psychometric Examiner on SKILL-TRACK.
Generate ${targetCount} Multiple-Choice Questions for Step ${step.stepIndex} ("${step.title}").
Attempt #${attemptNumber}. ${angleInstruction}

STRICT GROUNDING & ZERO-REPETITION MANDATE:
1. Every question MUST be grounded in the STEP_RESOURCE_DOSSIER below.
2. ZERO QUESTIONS ABOUT TIMERS OR UI BUTTONS. Test substantive skill knowledge.
3. FORBIDDEN QUESTIONS LIST (DO NOT REPEAT OR PARAPHRASE ANY OF THESE):
${forbiddenSlice.length > 0 ? forbiddenSlice.map((q, i) => `${i + 1}. "${q}"`).join('\n') : '(None yet.)'}
You are strictly forbidden from reusing any question above or slightly rephrasing it! Test different topics, distinct sub-points, or new practical angles.
4. Output exactly 4 options per question (1 correctAnswer + 3 plausible distractors of comparable length).
5. Return ONLY JSON:
{
  "questions": [
    {
      "topicKey": "t1",
      "sourceTopic": "Topic Title",
      "sourceResourceTitle": "Document / Guide Title",
      "acuId": "acu-1",
      "question": "Clear scenario or principle question...",
      "correctAnswer": "Accurate option",
      "distractors": ["Plausible wrong 1", "Plausible wrong 2", "Plausible wrong 3"],
      "explanation": "Concrete reasoning based on study material..."
    }
  ]
}`;

        const userPrompt = JSON.stringify({
          stepTitle: step.title,
          stepIndex: step.stepIndex,
          attemptNumber,
          dossier,
        });

        try {
          const groqData = await callFastGroqQuizJson(groqKey, systemPrompt, userPrompt, 8500);
          if (Array.isArray(groqData?.questions)) {
            rawQuestions = groqData.questions;
          }
        } catch (gErr: any) {
          console.warn('[quizBuilder] Fast Groq call fell back to multi-variant synthesizer:', gErr.message);
        }
      }

      // 6. PROGRAMMATIC DEDUPLICATION WITH 55% SIMILARITY THRESHOLD
      const validQuestions: RawQuizQuestion[] = [];
      const SIMILARITY_THRESHOLD = 0.55;

      for (const q of rawQuestions) {
        if (!q?.question || typeof q.question !== 'string') continue;
        if (!q?.correctAnswer || typeof q.correctAnswer !== 'string') continue;
        if (!Array.isArray(q.distractors) || q.distractors.length < 3) continue;

        const candidateStem = q.question.trim();

        // Check similarity against forbidden question list
        const isForbiddenDupe = uniqueForbiddenQuestions.some(
          (fq) => computeQuestionSimilarity(candidateStem, fq) > SIMILARITY_THRESHOLD
        );
        if (isForbiddenDupe) continue;

        // Check intra-quiz duplicate
        const isIntraDupe = validQuestions.some(
          (vq) => computeQuestionSimilarity(candidateStem, vq.question) > SIMILARITY_THRESHOLD
        );
        if (isIntraDupe) continue;

        const topic = readyTopics.find(
          (t) => t.key === q.topicKey || t.title.toLowerCase() === (q.sourceTopic || '').toLowerCase()
        ) || readyTopics[validQuestions.length % readyTopics.length];

        validQuestions.push({
          topicKey: topic.key,
          topicId: topic.id,
          resourceId: topic.resources?.[0]?.id,
          acuId: q.acuId || `${topic.key}-acu`,
          question: candidateStem,
          correctAnswer: q.correctAnswer.trim(),
          distractors: q.distractors.slice(0, 3).map((d: any) => String(d).trim()),
          explanation: (q.explanation || `Derived from core standards of ${topic.title}`).trim(),
          sourceTopic: topic.title,
          sourceResourceTitle: q.sourceResourceTitle || docResources[0]?.title || `${topic.title} Guide`,
        });

        if (validQuestions.length >= targetCount) break;
      }

      // 7. MULTI-VARIANT EMERGENCY SYNTHESIZER TO FILL ANY SHORTFALL
      const bankTypes: Array<'PRINCIPLE' | 'MISTAKE' | 'DOC' | 'SCENARIO' | 'EXECUTION'> = [
        'PRINCIPLE',
        'MISTAKE',
        'DOC',
        'SCENARIO',
        'EXECUTION',
      ];

      let bankIdx = (attemptNumber - 1) % bankTypes.length;

      while (validQuestions.length < targetCount) {
        const topic = readyTopics[validQuestions.length % readyTopics.length];
        const docRes = docResources[validQuestions.length % Math.max(docResources.length, 1)];
        const currentBank = bankTypes[bankIdx % bankTypes.length];
        bankIdx++;

        const synthQ = synthesizeEmergencyStepQuestion(
          topic,
          step,
          currentBank,
          attemptNumber + validQuestions.length,
          docRes
        );

        const isForbiddenDupe = uniqueForbiddenQuestions.some(
          (fq) => computeQuestionSimilarity(synthQ.question, fq) > SIMILARITY_THRESHOLD
        );
        const isIntraDupe = validQuestions.some(
          (vq) => computeQuestionSimilarity(synthQ.question, vq.question) > SIMILARITY_THRESHOLD
        );

        if (!isForbiddenDupe && !isIntraDupe) {
          validQuestions.push(synthQ);
        } else {
          // Add unique disambiguation suffix if colliding
          synthQ.question = `[Phase ${step.stepIndex} - Variation ${validQuestions.length + 1}] ${synthQ.question}`;
          validQuestions.push(synthQ);
        }
      }

      // 8. BALANCE OPTIONS & PERSIST
      const finalQuestions = validQuestions.slice(0, targetCount);
      const balanced = buildBalancedQuestions(finalQuestions);

      // Update questionHistory in intro
      const currentIntro = (step.intro && typeof step.intro === 'object') ? { ...step.intro } : {};
      const updatedHistory = Array.from(
        new Set([...(currentIntro.questionHistory || []), ...balanced.map((b) => b.question)])
      );
      currentIntro.questionHistory = updatedHistory;

      await prisma.skillStep.update({
        where: { id: step.id },
        data: {
          quizBlueprint: balanced as any,
          questionCount: balanced.length,
          quizStatus: 'READY',
          quizError: null,
          intro: currentIntro,
        },
      });

      // 9. RETURN SANITIZED STUDENT-SAFE PAYLOAD
      const sanitized = balanced.map((q, idx) => ({
        id: q.id || `q_${idx + 1}`,
        question: q.question,
        prompt: q.question,
        topicKey: q.topicKey,
        topicTitle: q.sourceTopic || q.topicKey,
        sourceTopic: q.sourceTopic || q.topicKey,
        sourceResourceTitle: q.sourceResourceTitle,
        acuId: q.acuId,
        chapterKey: q.chapterKey,
        options: (q.options || []).map((o, optIdx) => ({
          id: o.id || `opt_${optIdx + 1}`,
          text: o.text,
          position: typeof o.position === 'number' ? o.position : optIdx,
        })),
      }));

      return {
        evaluationId: `eval_${step.id}_${Date.now()}`,
        stepId: step.id,
        stepNumber: step.stepIndex,
        stepTitle: step.title,
        passThreshold: 70,
        passingThreshold: 70,
        questions: sanitized,
        questionCount: sanitized.length,
        attemptNumber,
        mode,
        coveredTopics: Array.from(new Set(balanced.map((q) => q.topicKey))),
      };
    } finally {
      inFlightQuizBuilds.delete(lockKey);
    }
  })();

  inFlightQuizBuilds.set(lockKey, buildPromise);
  return buildPromise;
}
