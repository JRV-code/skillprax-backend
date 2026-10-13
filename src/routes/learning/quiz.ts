import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import {
  generateLevelUpQuiz,
  submitQuizAnswers,
  generateEvaluationAnalysis,
  findRemediationResources,
} from '../../services/learning/quiz';
import { translateEvaluation } from '../../services/learning/translation';

export const quizLearningRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // POST /api/steps/:stepId/level-up-quiz — Grounded Socratic Quiz Generation
  fastify.post('/api/steps/:stepId/level-up-quiz', async (req, reply) => {
    const { stepId } = req.params as { stepId: string };
    try {
      const quiz = await generateLevelUpQuiz(stepId);
      return reply.send(quiz);
    } catch (err: any) {
      fastify.log.error(err, '[GenerateQuiz] Failed');
      return reply.status(err.statusCode || 500).send({
        error: err.message || 'Failed to generate quiz',
      });
    }
  });

  fastify.post('/api/steps/:stepId/prompt-quiz', async (req, reply) => {
    const { stepId } = req.params as { stepId: string };
    const quiz = await generateLevelUpQuiz(stepId);
    return reply.send(quiz);
  });

  fastify.post('/api/quizzes/generate/:stepId', async (req, reply) => {
    const { stepId } = req.params as { stepId: string };
    const quiz = await generateLevelUpQuiz(stepId);
    return reply.send(quiz);
  });

  // POST /api/steps/:stepId/submit-quiz — Server-Side Deterministic Grading
  fastify.post('/api/steps/:stepId/submit-quiz', async (req, reply) => {
    const { stepId } = req.params as { stepId: string };
    const { attemptId, answers } = (req.body || {}) as {
      attemptId?: string;
      answers: Record<string, string> | Array<{ questionId: string; selectedOptionId: string }>;
    };

    try {
      let normalizedAnswers: Record<string, string> = {};
      if (Array.isArray(answers)) {
        answers.forEach((a) => {
          if (a?.questionId) normalizedAnswers[a.questionId] = String(a.selectedOptionId);
        });
      } else if (typeof answers === 'object' && answers !== null) {
        normalizedAnswers = answers;
      }

      const graded = await submitQuizAnswers(stepId, {
        attemptId,
        answers: normalizedAnswers,
      });

      return reply.send(graded);
    } catch (err: any) {
      fastify.log.error(err, '[SubmitQuiz] Failed');
      return reply.status(500).send({
        error: err.message || 'Failed to evaluate quiz submission',
      });
    }
  });

  fastify.post('/api/quizzes/evaluate', async (req, reply) => {
    const { stepId, attemptId, answers } = (req.body || {}) as any;
    if (!stepId) return reply.status(400).send({ error: 'stepId is required' });
    const graded = await submitQuizAnswers(stepId, { attemptId, answers });
    return reply.send(graded);
  });

  fastify.post('/api/quiz/evaluate', async (req, reply) => {
    const { stepId, attemptId, answers } = (req.body || {}) as any;
    if (!stepId) return reply.status(400).send({ error: 'stepId is required' });
    const graded = await submitQuizAnswers(stepId, { attemptId, answers });
    return reply.send(graded);
  });

  // POST /api/evaluations/:id/analysis — AI-written, code-constrained analysis
  fastify.post('/api/evaluations/:id/analysis', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { languageCode } = (req.body || {}) as { languageCode?: string };

    try {
      const analysis = await generateEvaluationAnalysis(id, languageCode || 'en');
      return reply.send(analysis);
    } catch (err: any) {
      fastify.log.error(err, '[EvaluationAnalysis] Failed');
      return reply.status(500).send({
        error: err.message || 'Failed to generate evaluation analysis',
      });
    }
  });

  // POST /api/evaluations/:id/translate — Translate quiz content
  fastify.post('/api/evaluations/:id/translate', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { languageCode } = (req.body || {}) as { languageCode?: string };

    try {
      const translated = await translateEvaluation(id, languageCode || 'en');
      return reply.send(translated);
    } catch (err: any) {
      fastify.log.error(err, '[TranslateEvaluation] Failed');
      return reply.status(500).send({
        error: err.message || 'Failed to translate evaluation',
      });
    }
  });

  // GET /api/steps/:stepId/remediation — Remediation search
  fastify.get('/api/steps/:stepId/remediation', async (req, reply) => {
    const { stepId } = req.params as { stepId: string };
    const { chapterKey } = (req.query || {}) as { chapterKey?: string };

    try {
      const links = await findRemediationResources(stepId, chapterKey);
      return reply.send({ remediationLinks: links });
    } catch (err: any) {
      fastify.log.error(err, '[RemediationSearch] Failed');
      return reply.status(500).send({
        error: err.message || 'Failed to find remediation links',
      });
    }
  });
};
