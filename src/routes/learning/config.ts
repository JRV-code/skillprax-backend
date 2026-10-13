import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { LEARNING_CONFIG } from '../../config/learning';

export const configLearningRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.get('/api/config/learning', async (_req, reply) => {
    return reply.send({
      passThresholdPercent: LEARNING_CONFIG.PASS_THRESHOLD_PERCENT,
      quizMinQuestions: LEARNING_CONFIG.QUIZ_MIN_QUESTIONS,
      quizMaxQuestions: LEARNING_CONFIG.QUIZ_MAX_QUESTIONS,
      languages: LEARNING_CONFIG.LANGUAGES,
    });
  });
};
