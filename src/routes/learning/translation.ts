import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import {
  translateStepBook,
  getUiStrings,
} from '../../services/learning/translation';

export const translationLearningRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // POST /api/steps/:stepId/translate — Translate step curriculum book
  fastify.post('/api/steps/:stepId/translate', async (req, reply) => {
    const { stepId } = req.params as { stepId: string };
    const { languageCode } = (req.body || {}) as { languageCode?: string };

    try {
      const translated = await translateStepBook(stepId, languageCode || 'en');
      return reply.send(translated);
    } catch (err: any) {
      fastify.log.error(err, '[TranslateStepBook] Failed');
      return reply.status(500).send({
        error: err.message || 'Failed to translate step book',
      });
    }
  });

  // GET /api/ui-strings/:lang — Get translated UI string dictionary
  fastify.get('/api/ui-strings/:lang', async (req, reply) => {
    const { lang } = req.params as { lang: string };

    try {
      const dict = await getUiStrings(lang);
      return reply.send(dict);
    } catch (err: any) {
      fastify.log.error(err, '[GetUiStrings] Failed');
      return reply.status(500).send({
        error: err.message || 'Failed to fetch UI strings',
      });
    }
  });
};
