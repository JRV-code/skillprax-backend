import { prisma } from '../../lib/prisma';
import { callGroqJson, assertNoUrls } from './foundation';
import { LEARNING_CONFIG } from '../../config/learning';

export function deepShapeMatches(original: any, translated: any): boolean {
  if (typeof original !== typeof translated) return false;
  if (original === null || translated === null) return original === translated;

  if (Array.isArray(original)) {
    if (!Array.isArray(translated)) return false;
    if (original.length !== translated.length) return false;
    for (let i = 0; i < original.length; i++) {
      if (!deepShapeMatches(original[i], translated[i])) return false;
    }
    return true;
  }

  if (typeof original === 'object') {
    const origKeys = Object.keys(original).sort();
    const transKeys = Object.keys(translated).sort();
    if (origKeys.length !== transKeys.length) return false;
    for (let i = 0; i < origKeys.length; i++) {
      if (origKeys[i] !== transKeys[i]) return false;
      if (!deepShapeMatches(original[origKeys[i]], translated[transKeys[i]])) return false;
    }
    return true;
  }

  return true;
}

export async function translateStepBook(stepId: string, languageCode: string) {
  if (languageCode === 'en' || !LEARNING_CONFIG.LANGUAGES.includes(languageCode as any)) {
    return { languageCode: 'en', translated: false };
  }

  // Check cache
  const cached = await prisma.translationCache.findUnique({
    where: {
      scope_scopeId_languageCode: {
        scope: 'STEP_BOOK',
        scopeId: stepId,
        languageCode,
      },
    },
  });

  if (cached) {
    return {
      languageCode,
      translated: true,
      payload: cached.payload,
    };
  }

  const step = await prisma.skillStep.findUnique({
    where: { id: stepId },
    include: {
      chapters: { orderBy: { orderIndex: 'asc' } },
    },
  });

  if (!step) throw new Error('Step not found');

  const sourcePayload = {
    stepTitle: step.title,
    approachBrief: step.approachBrief,
    chapters: step.chapters.map((ch) => ({
      key: ch.key,
      title: ch.title,
      covers: ch.covers,
      buildsOn: ch.buildsOn,
      newConcepts: (ch.newConcepts as string[]) || [],
      approachGuide: ch.approachGuide,
    })),
  };

  const promptSystem = `You are a Professional Educational Translator for SKILL-TRACK.
Translate the educational text values in the JSON object into "${languageCode}".
STRICT RULES:
1. Translate VALUES only.
2. Keep JSON keys, IDs ("c1", "key", etc.), numbers, timeboxes, and structural shapes EXACTLY unchanged.
3. Keep widely used technical and domain terms in their original form (optionally with brief native explanation in parentheses).
4. Do NOT add any URLs or markdown code fences.

Return ONLY the translated JSON matching the exact input structure.`;

  const translatedPayload = await callGroqJson<any>(
    promptSystem,
    JSON.stringify(sourcePayload),
    {
      validate: (data: any) => {
        assertNoUrls(data, 'Translation');
        if (!deepShapeMatches(sourcePayload, data)) {
          throw new Error('Translated JSON shape does not match source structure');
        }
        return data;
      },
      maxTokens: 3500,
      temperature: 0.1,
      retryCount: 1,
    }
  );

  // Store in TranslationCache
  await prisma.translationCache.upsert({
    where: {
      scope_scopeId_languageCode: {
        scope: 'STEP_BOOK',
        scopeId: step.id,
        languageCode,
      },
    },
    create: {
      scope: 'STEP_BOOK',
      scopeId: step.id,
      languageCode,
      payload: translatedPayload,
    },
    update: {
      payload: translatedPayload,
    },
  });

  return {
    languageCode,
    translated: true,
    payload: translatedPayload,
  };
}

export async function translateEvaluation(evaluationId: string, languageCode: string) {
  if (languageCode === 'en' || !LEARNING_CONFIG.LANGUAGES.includes(languageCode as any)) {
    return { languageCode: 'en', translated: false };
  }

  const cached = await prisma.translationCache.findUnique({
    where: {
      scope_scopeId_languageCode: {
        scope: 'QUIZ',
        scopeId: evaluationId,
        languageCode,
      },
    },
  });

  if (cached) {
    return {
      languageCode,
      translated: true,
      payload: cached.payload,
    };
  }

  const attempt = await prisma.quizAttempt.findUnique({
    where: { id: evaluationId },
  });

  if (!attempt) throw new Error('Evaluation not found');

  const questions: any[] = Array.isArray(attempt.questions) ? (attempt.questions as any[]) : [];
  if (questions.length === 0) return { languageCode, translated: false };

  const transSource = questions.map((q) => ({
    id: q.id,
    question: q.question,
    explanation: q.explanation,
    options: (q.options || []).map((o: any) => ({
      id: o.id,
      text: o.text,
      position: o.position,
    })),
  }));

  const promptSystem = `You are a Professional Psychometric Exam Translator for SKILL-TRACK.
Translate the quiz question prompts, option texts, and explanations into "${languageCode}".
STRICT RULES:
1. Translate question, option text, and explanation ONLY.
2. DO NOT change option IDs, question IDs, positions, or option order.
3. Keep technical terms natural.
4. Return ONLY valid JSON matching the exact input structure.`;

  const translated = await callGroqJson<any>(
    promptSystem,
    JSON.stringify(transSource),
    {
      validate: (data: any) => {
        assertNoUrls(data, 'QuizTranslation');
        if (!Array.isArray(data) || data.length !== transSource.length) {
          throw new Error('Translated quiz question array length mismatch');
        }
        return data;
      },
      maxTokens: 3000,
      temperature: 0.1,
    }
  );

  await prisma.translationCache.upsert({
    where: {
      scope_scopeId_languageCode: {
        scope: 'QUIZ',
        scopeId: evaluationId,
        languageCode,
      },
    },
    create: {
      scope: 'QUIZ',
      scopeId: evaluationId,
      languageCode,
      payload: translated,
    },
    update: {
      payload: translated,
    },
  });

  return {
    languageCode,
    translated: true,
    payload: translated,
  };
}

export const BASE_UI_STRINGS = {
  buildCurriculumBtn: '⚡ Build My Milestone Curriculum',
  buildingCurriculum: 'Curating milestone curriculum...',
  gamePlanTitle: 'Milestone Game Plan',
  gotItBtn: 'Got it — show me the chapters',
  scoreToUnlock: 'Score {passPercent}% or more to unlock the next milestone',
  focusStripTitle: 'Focus for this resource',
  verifiedBadge: 'Verified',
  linkBrokenReplace: 'Link broken? Replace',
  openYouTube: 'Open on YouTube',
  openDocument: 'Open in new tab',
  openTranslatedDoc: 'Read in {lang}',
  originalLink: 'Original',
  tryAltTranslator: 'Try alternate translator view',
  generateEvaluationBtn: '⚡ Generate Socratic Evaluation',
  generatingEvaluation: 'Generating psychometric evaluation...',
  submitQuizBtn: 'Submit Evaluation',
  evaluatingQuiz: 'Evaluating answers...',
  passedStatus: 'PASSED',
  notYetStatus: 'NOT YET',
  youNeededScore: 'You needed {requiredCorrect} of {total}',
  remediationTitle: 'Targeted Remediation Drills',
  retryEvaluationBtn: 'Retake Evaluation',
  chapterObjectivesTag: 'Based on chapter objectives',
  basedOnChapter: 'Based on: Chapter {chapterKey} — {resourceTitle}',
};

export async function getUiStrings(languageCode = 'en') {
  if (languageCode === 'en' || !LEARNING_CONFIG.LANGUAGES.includes(languageCode as any)) {
    return BASE_UI_STRINGS;
  }

  const cached = await prisma.translationCache.findUnique({
    where: {
      scope_scopeId_languageCode: {
        scope: 'UI',
        scopeId: 'ui',
        languageCode,
      },
    },
  });

  if (cached) {
    return cached.payload;
  }

  const promptSystem = `Translate the UI string dictionary values into "${languageCode}".
Keep keys unchanged. Keep placeholders like {passPercent}, {requiredCorrect}, {total}, {chapterKey}, {resourceTitle}, {lang} exactly unchanged.
Return ONLY valid JSON.`;

  try {
    const translated = await callGroqJson<any>(
      promptSystem,
      JSON.stringify(BASE_UI_STRINGS),
      {
        validate: (data: any) => {
          assertNoUrls(data, 'UiStrings');
          if (!deepShapeMatches(BASE_UI_STRINGS, data)) {
            throw new Error('UI string dictionary key mismatch');
          }
          return data;
        },
        maxTokens: 1200,
        temperature: 0.1,
      }
    );

    await prisma.translationCache.upsert({
      where: {
        scope_scopeId_languageCode: {
          scope: 'UI',
          scopeId: 'ui',
          languageCode,
        },
      },
      create: {
        scope: 'UI',
        scopeId: 'ui',
        languageCode,
        payload: translated,
      },
      update: {
        payload: translated,
      },
    });

    return translated;
  } catch (err: any) {
    console.warn('[translation] UI strings translation failed, returning English:', err.message);
    return BASE_UI_STRINGS;
  }
}
