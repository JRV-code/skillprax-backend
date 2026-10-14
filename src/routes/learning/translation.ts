import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import {
  translateStepBook,
  getUiStrings,
} from '../../services/learning/translation';

export const translationLearningRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // POST /api/steps/:stepId/translate is registered centrally via curriculumLearningRoutes

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
