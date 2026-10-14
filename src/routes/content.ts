import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import prisma from '../lib/prisma';
import { callGroqJson } from '../lib/foundation';

const LANGUAGE_MAP: Record<string, string> = {
  en: 'English',
  hi: 'Hindi (हिन्दी)',
  gu: 'Gujarati (ગુજરાતી)',
  mr: 'Marathi (मराठी)',
  kn: 'Kannada (ಕನ್ನಡ)',
  ta: 'Tamil (தமிழ்)',
  te: 'Telugu (తెలుగు)',
  fr: 'French (Français)',
  es: 'Spanish (Español)',
  de: 'German (Deutsch)',
};

const DEFAULT_UI_STRINGS: Record<string, string> = {
  summaryCards: 'Summary Cards',
  fullGuide: 'Full Guide',
  toc: 'Table of Contents',
  verifiedSource: 'Verified Reference Link',
  readWholeGuide: 'Read the whole guide',
  gamePlan: 'Milestone Game Plan',
  gotIt: 'Got it — show me the chapters',
  howToStudy: 'How to study this milestone',
  mistakesToAvoid: 'Mistakes to avoid',
  selfCheck: 'Ungraded Self-Check',
  revealHint: 'Reveal Hint',
  linkBrokenReplace: 'Link broken? Replace',
  findLinkForTopic: 'Find a link for this topic',
  verifiedBadge: 'Verified',
  readGamePlanFirst: 'Read the game plan first',
  focusForResource: 'Focus for this resource',
  generateQuiz: 'Generate Socratic Evaluation',
};

export const contentRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // G1: GET /api/content/:documentId
  fastify.get('/api/content/:documentId', async (req, reply) => {
    const { documentId } = req.params as { documentId: string };

    try {
      const doc = await prisma.contentDocument.findUnique({
        where: { id: documentId },
      });

      if (!doc) {
        return reply.status(404).send({ error: 'ContentDocument not found' });
      }

      return reply.send({
        id: doc.id,
        stepId: doc.stepId,
        sourceType: doc.sourceType,
        sourceUrl: doc.sourceUrl,
        sourceTitle: doc.sourceTitle,
        markdown: doc.markdown,
        quadrants: doc.quadrants,
        topicMap: doc.topicMap,
        approachBrief: doc.approachBrief,
      });
    } catch (err: any) {
      fastify.log.error(err, '[GET /api/content/:documentId] Failed');
      return reply.status(500).send({ error: 'Failed to retrieve content document' });
    }
  });

  // G3: POST /api/content/:documentId/translate
  fastify.post('/api/content/:documentId/translate', async (req, reply) => {
    const { documentId } = req.params as { documentId: string };
    const { languageCode = 'en' } = (req.body || {}) as { languageCode?: string };

    const lang = languageCode.toLowerCase().slice(0, 2);
    const langName = LANGUAGE_MAP[lang] || 'English';

    try {
      const doc = await prisma.contentDocument.findUnique({
        where: { id: documentId },
      });

      if (!doc) {
        return reply.status(404).send({ error: 'ContentDocument not found' });
      }

      // en: return original, no AI call
      if (lang === 'en') {
        return reply.send({
          languageCode: 'en',
          markdown: doc.markdown,
          quadrants: doc.quadrants,
          topicMap: doc.topicMap,
          approachBrief: doc.approachBrief,
          uiStrings: DEFAULT_UI_STRINGS,
          cached: true,
        });
      }

      // Look up ContentTranslation cache
      const cached = await prisma.contentTranslation.findUnique({
        where: {
          contentDocumentId_languageCode: {
            contentDocumentId: documentId,
            languageCode: lang,
          },
        },
      });

      // Look up UiTranslation cache
      let uiCached = await prisma.uiTranslation.findUnique({
        where: { languageCode: lang },
      });

      let uiStrings = uiCached?.strings || null;
      if (!uiStrings) {
        try {
          const uiPrompt = `Translate the following UI interface labels accurately into ${langName}. Keep keys identical, return JSON:
${JSON.stringify(DEFAULT_UI_STRINGS)}`;

          const translatedUi = await callGroqJson<Record<string, string>>(
            'You are a professional localization expert. Return strictly valid JSON.',
            uiPrompt,
            { maxTokens: 1500, temperature: 0.1 }
          );

          uiStrings = translatedUi;
          await prisma.uiTranslation.upsert({
            where: { languageCode: lang },
            create: { languageCode: lang, strings: uiStrings as any },
            update: { strings: uiStrings as any },
          });
        } catch (_) {
          uiStrings = DEFAULT_UI_STRINGS;
        }
      }

      if (cached) {
        return reply.send({
          languageCode: lang,
          markdown: cached.markdown,
          quadrants: cached.quadrants,
          topicMap: cached.topicMap || doc.topicMap,
          approachBrief: cached.approachBrief || doc.approachBrief,
          uiStrings,
          cached: true,
        });
      }

      // Translation Miss: Translate quadrants, topicMap titles/covers, approachBrief and markdown
      const translationPayload = {
        quadrants: doc.quadrants,
        topicMap: Array.isArray(doc.topicMap)
          ? (doc.topicMap as any[]).map((t) => ({ key: t.key, title: t.title, covers: t.covers }))
          : [],
        approachBrief: doc.approachBrief,
      };

      const transSystem = `You are an expert pedagogical translator. Translate the educational metadata into ${langName}.
Rules:
- Preserve all keys, IDs, topicKeys, and numerical values unchanged.
- Keep fenced code, inline code, and URLs completely unchanged.
- Output JSON ONLY matching this structure:
{
  "quadrants": { "principle": "...", "mechanics": ["..."], "traps": ["..."] },
  "topics": [{ "key": "t1", "title": "...", "covers": "..." }],
  "approachBrief": { "goal": "...", "whyNow": "...", "beforeYouStart": ["..."], "howToStudy": ["..."], "commonMistakes": ["..."], "selfCheck": [{ "prompt": "...", "hint": "..." }] }
}`;

      const transResult = await callGroqJson<any>(
        transSystem,
        JSON.stringify(translationPayload),
        { maxTokens: 4500, temperature: 0.2 }
      );

      // Translate markdown chunked (if markdown exists)
      let translatedMarkdown: string | null = null;
      if (doc.markdown) {
        const mdPrompt = `Translate the following markdown technical study guide into ${langName}.
Keep all markdown headings (#, ##), lists, fenced code blocks, numbers, and URLs EXACTLY unchanged.
Do not omit any sections.
Text to translate:
${doc.markdown.slice(0, 5000)}`;

        try {
          const mdRes = await callGroqJson<{ markdown: string }>(
            'Translate markdown preserving all code fences and headings. Return JSON: {"markdown": "..."}',
            mdPrompt,
            { maxTokens: 5000, temperature: 0.2 }
          );
          translatedMarkdown = mdRes.markdown || doc.markdown;
        } catch (_) {
          translatedMarkdown = doc.markdown;
        }
      }

      // Merge translated topicMap with original
      const mergedTopicMap = Array.isArray(doc.topicMap)
        ? (doc.topicMap as any[]).map((t) => {
            const foundTrans = (transResult.topics || []).find((tr: any) => tr.key === t.key);
            return {
              ...t,
              title: foundTrans?.title || t.title,
              covers: foundTrans?.covers || t.covers,
            };
          })
        : doc.topicMap;

      const mergedApproachBrief = doc.approachBrief
        ? {
            ...(doc.approachBrief as any),
            ...(transResult.approachBrief || {}),
          }
        : null;

      // Save into ContentTranslation cache
      await prisma.contentTranslation.upsert({
        where: {
          contentDocumentId_languageCode: {
            contentDocumentId: documentId,
            languageCode: lang,
          },
        },
        create: {
          contentDocumentId: documentId,
          languageCode: lang,
          markdown: translatedMarkdown,
          quadrants: transResult.quadrants || doc.quadrants,
          topicMap: mergedTopicMap as any,
          approachBrief: mergedApproachBrief as any,
        },
        update: {
          markdown: translatedMarkdown,
          quadrants: transResult.quadrants || doc.quadrants,
          topicMap: mergedTopicMap as any,
          approachBrief: mergedApproachBrief as any,
        },
      });

      return reply.send({
        languageCode: lang,
        markdown: translatedMarkdown,
        quadrants: transResult.quadrants || doc.quadrants,
        topicMap: mergedTopicMap,
        approachBrief: mergedApproachBrief,
        uiStrings,
        cached: false,
      });
    } catch (err: any) {
      fastify.log.error(err, '[DocumentTranslate] Failed');
      return reply.status(500).send({ error: 'Translation failed' });
    }
  });

  // Legacy POST /api/content/translate (Kept for backwards compatibility)
  fastify.post('/api/content/translate', async (req, reply) => {
    const {
      contentId = 'doc-default',
      targetLanguage = 'en',
      quadrants,
      fullContentMarkdown = '',
    } = (req.body || {}) as any;

    const langCode = targetLanguage.toLowerCase().slice(0, 2);
    if (langCode === 'en') {
      return reply.send({
        success: true,
        targetLanguage: 'en',
        translatedQuadrants: quadrants,
        translatedMarkdown: fullContentMarkdown,
        cached: true,
      });
    }

    try {
      const cached = await prisma.contentTranslation.findFirst({
        where: { languageCode: langCode },
      });
      if (cached) {
        return reply.send({
          success: true,
          targetLanguage: langCode,
          translatedQuadrants: cached.quadrants,
          translatedMarkdown: cached.markdown,
          cached: true,
        });
      }
    } catch (_) {}

    return reply.send({
      success: true,
      targetLanguage: langCode,
      translatedQuadrants: quadrants,
      translatedMarkdown: fullContentMarkdown,
      cached: false,
    });
  });

  // Legacy POST /api/translate
  fastify.post('/api/translate', async (req, reply) => {
    const { text, targetLanguage = 'en' } = (req.body || {}) as { text?: string; targetLanguage?: string };
    if (!text || !text.trim()) {
      return reply.status(400).send({ error: 'Text to translate is required' });
    }
    const langCode = targetLanguage.toLowerCase().slice(0, 2);
    if (langCode === 'en') {
      return reply.send({ translatedText: text, targetLanguage: 'English' });
    }
    const langName = LANGUAGE_MAP[langCode] || 'English';

    try {
      const res = await callGroqJson<{ translatedText: string }>(
        `Translate text into ${langName}. Return JSON: {"translatedText": "..."}`,
        text,
        { maxTokens: 1000, temperature: 0.1 }
      );
      return reply.send({
        translatedText: res.translatedText || text,
        targetLanguage: langName,
      });
    } catch (_) {
      return reply.send({ translatedText: text, targetLanguage: langName });
    }
  });
};

export default contentRoutes;
