import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { configLearningRoutes } from './config';
import { curriculumLearningRoutes } from './curriculum';
import { quizLearningRoutes } from './quiz';
import { translationLearningRoutes } from './translation';

export const learningRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  await fastify.register(configLearningRoutes);
  await fastify.register(curriculumLearningRoutes);
  await fastify.register(quizLearningRoutes);
  await fastify.register(translationLearningRoutes);
};
