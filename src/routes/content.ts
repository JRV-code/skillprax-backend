import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { callGroqWithFallback } from '../lib/ai/pipeline';
import { getEffectiveKeys } from '../lib/keyManager';

const LANGUAGE_MAP: Record<string, string> = {
  en: 'English',
  hi: 'Hindi (हिन्दी)',
  fr: 'French (Français)',
  es: 'Spanish (Español)',
  de: 'German (Deutsch)',
};

export const contentRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // 1. POST /api/translate — Translate learning text / milestone guide into target language
  fastify.post('/api/translate', async (req, reply) => {
    try {
      const { text, targetLanguage = 'en', context = '' } = (req.body || {}) as {
        text: string;
        targetLanguage: string;
        context?: string;
      };

      if (!text || !text.trim()) {
        return reply.status(400).send({ error: 'Text to translate is required.' });
      }

      if (targetLanguage === 'en' || targetLanguage === 'English') {
        return reply.status(200).send({ translatedText: text, targetLanguage: 'English' });
      }

      const langName = LANGUAGE_MAP[targetLanguage] || targetLanguage;

      const systemPrompt = `You are a high-precision pedagogical translation engine. Translate the following educational material accurately into ${langName}. Preserve all markdown formatting, code snippets, mathematical notation, and key terminology while providing natural, fluent, and precise translations. Output ONLY the translated text without introductory commentary.`;

      const { groqKey } = await getEffectiveKeys();
      const apiKey = groqKey || process.env.GROQ_API_KEY || '';

      const response = await callGroqWithFallback([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: text },
      ], { apiKey, model: 'llama-3.3-70b-versatile', temperature: 0.2 });

      return reply.status(200).send({
        translatedText: response.content?.trim() || text,
        targetLanguage: langName,
      });
    } catch (err: any) {
      fastify.log.error(err, '[POST /api/translate] Failed');
      return reply.status(500).send({ error: 'Translation failed', fallbackText: (req.body as any)?.text });
    }
  });

  // 2. POST /api/content/verify-and-extract — Dead link filtering & in-app content extraction
  fastify.post('/api/content/verify-and-extract', async (req, reply) => {
    try {
      const { url, title = 'Educational Document', domain = 'General' } = (req.body || {}) as {
        url?: string;
        title?: string;
        domain?: string;
      };

      let isAccessible = false;
      let fetchedContent = '';

      if (url && url.startsWith('http')) {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 4000);
          const headRes = await fetch(url, {
            method: 'GET',
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) SkillpraxBot/1.0' },
            signal: controller.signal,
          });
          clearTimeout(timeout);
          if (headRes.ok) {
            isAccessible = true;
            const rawText = await headRes.text();
            // simple text extraction
            fetchedContent = rawText.replace(/<[^>]+>/g, ' ').slice(0, 3000);
          }
        } catch (_) {
          isAccessible = false;
        }
      }

      // If inaccessible or missing, synthesize canonical pedagogical 4-quadrant reference
      const prompt = `Synthesize an authoritative in-app pedagogical reference for "${title}" in the domain "${domain}".
Produce a JSON response with:
{
  "sourceBadge": "${isAccessible ? 'Verified Source' : 'Canonical Encyclopedic Dossier'}",
  "corePrinciple": "2-3 sentences explaining the core foundational axiom in 60 seconds.",
  "mechanics": ["Step 1 sequence", "Step 2 sequence", "Step 3 sequence"],
  "commonTraps": ["Common Misconception A", "Edge Case Trap B", "Fallacy C"],
  "markdownBody": "A 3-paragraph structured markdown article with headers, bullet points, and key takeaways."
}`;

      const { groqKey } = await getEffectiveKeys();
      const apiKey = groqKey || process.env.GROQ_API_KEY || '';

      const aiResponse = await callGroqWithFallback([
        { role: 'system', content: 'You are an encyclopedia knowledge extraction engine. Return strictly valid JSON.' },
        { role: 'user', content: prompt }
      ], { apiKey, model: 'llama-3.3-70b-versatile', temperature: 0.2 });

      let parsed: any;
      try {
        const cleaned = (aiResponse.content || '{}').replace(/```json\n?|```/g, '').trim();
        parsed = JSON.parse(cleaned);
      } catch {
        parsed = {
          sourceBadge: 'Canonical Encyclopedic Dossier',
          corePrinciple: `Mastery of ${title} requires rigorous adherence to foundational principles and experimental verification.`,
          mechanics: ['Establish parameter boundaries', 'Execute deterministic sequence', 'Measure output variance'],
          commonTraps: ['Overfitting to nominal examples', 'Ignoring edge boundary failures'],
          markdownBody: `### ${title}\n\nComprehensive breakdown of foundational mechanics and execution protocols.`,
        };
      }

      return reply.status(200).send({
        success: true,
        isAccessible,
        url: url || '#',
        ...parsed,
      });
    } catch (err: any) {
      fastify.log.error(err, '[POST /api/content/verify-and-extract] Failed');
      return reply.status(500).send({ error: 'Content verification failed' });
    }
  });
};

export default contentRoutes;
