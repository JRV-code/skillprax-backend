import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import {
  buildMilestoneCurriculum,
  getStepGuide,
  retryChapterResource,
  replaceResource,
  generateStepApproach,
  markApproachViewed,
} from '../../services/learning/curriculum';

export const curriculumLearningRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // POST /api/steps/:stepId/level-up-resources — Click-triggered pipeline build
  fastify.post('/api/steps/:stepId/level-up-resources', async (req, reply) => {
    const { stepId } = req.params as { stepId: string };
    try {
      const result = await buildMilestoneCurriculum(stepId);
      return reply.send(result);
    } catch (err: any) {
      fastify.log.error(err, '[CurriculumBuild] Failed');
      return reply.status(err.statusCode || 500).send({
        error: err.message || 'Failed to build milestone curriculum',
      });
    }
  });

  // GET /api/steps/:stepId/guide — Read step guide, chapters, and approach brief
  fastify.get('/api/steps/:stepId/guide', async (req, reply) => {
    const { stepId } = req.params as { stepId: string };
    const { lang } = (req.query || {}) as { lang?: string };
    try {
      const guide = await getStepGuide(stepId, lang);
      return reply.send(guide);
    } catch (err: any) {
      fastify.log.error(err, '[GetStepGuide] Failed');
      return reply.status(err.statusCode || 500).send({
        error: err.message || 'Failed to fetch step guide',
      });
    }
  });

  // POST /api/chapters/:chapterId/retry — Retry search and verification for one chapter
  fastify.post('/api/chapters/:chapterId/retry', async (req, reply) => {
    const { chapterId } = req.params as { chapterId: string };
    try {
      const result = await retryChapterResource(chapterId);
      if (!result.success) {
        return reply.status(404).send({ error: result.message });
      }
      return reply.send(result);
    } catch (err: any) {
      fastify.log.error(err, '[RetryChapter] Failed');
      return reply.status(500).send({ error: err.message || 'Retry failed' });
    }
  });

  // POST /api/resources/:id/replace — "Link broken? Replace"
  fastify.post('/api/resources/:id/replace', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const result = await replaceResource(id);
      return reply.send(result);
    } catch (err: any) {
      fastify.log.error(err, '[ReplaceResource] Failed');
      return reply.status(404).send({
        error: err.message || 'Resource replacement failed',
      });
    }
  });

  // POST /api/steps/:stepId/approach — Regenerate only guides
  fastify.post('/api/steps/:stepId/approach', async (req, reply) => {
    const { stepId } = req.params as { stepId: string };
    try {
      const result = await generateStepApproach(stepId);
      return reply.send(result);
    } catch (err: any) {
      fastify.log.error(err, '[GenerateApproach] Failed');
      return reply.status(500).send({
        error: err.message || 'Failed to generate approach guide',
      });
    }
  });

  // POST /api/steps/:stepId/approach-viewed — Sets Step.approachViewedAt
  fastify.post('/api/steps/:stepId/approach-viewed', async (req, reply) => {
    const { stepId } = req.params as { stepId: string };
    try {
      await markApproachViewed(stepId);
      return reply.send({ success: true });
    } catch (err: any) {
      fastify.log.error(err, '[MarkApproachViewed] Failed');
      return reply.status(500).send({
        error: err.message || 'Failed to mark approach as viewed',
      });
    }
  });
};
