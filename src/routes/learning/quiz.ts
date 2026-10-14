import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import prisma from '../../lib/prisma';
import {
  generateLevelUpQuiz,
  submitQuizAnswers,
  generateEvaluationAnalysis,
  findRemediationResources,
} from '../../services/learning/quiz';
import { translateEvaluation } from '../../services/learning/translation';

export const quizLearningRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // GET /api/steps/:stepId/level-up-quiz and GET /api/steps/:stepId/quiz
  const handleGetQuiz = async (req: any, reply: any) => {
    const { stepId } = req.params as { stepId: string };
    const queryMode = req.query?.mode as 'initial' | 'retest' | 'perfection' | undefined;
    try {
      let step = await prisma.skillStep.findUnique({ where: { id: stepId }, select: { id: true, status: true } });
      if (!step) {
        const ws = await prisma.workspace.findUnique({
          where: { id: stepId },
          include: { steps: { orderBy: { stepIndex: 'asc' } } },
        });
        if (ws && ws.steps.length > 0) {
          const activeS = ws.steps.find((s) => s.status !== 'PASSED') || ws.steps[0];
          step = activeS;
        }
      }
      if (!step) return reply.status(404).send({ error: 'Step not found' });
      if (step.status === 'LOCKED') return reply.send({ locked: true });
      const quiz = await generateLevelUpQuiz(step.id, { mode: queryMode || 'initial' });
      return reply.send(quiz);
    } catch (err: any) {
      fastify.log.error(err, '[GetQuiz] Failed');
      return reply.status(err.statusCode || 500).send({
        error: err.message || 'Failed to retrieve quiz',
      });
    }
  };

  fastify.get('/api/steps/:stepId/level-up-quiz', handleGetQuiz);
  fastify.get('/api/steps/:stepId/quiz', handleGetQuiz);

  // POST /api/steps/:stepId/level-up-quiz & POST /api/steps/:stepId/quiz — Grounded Socratic Quiz Generation
  const handlePostQuiz = async (req: any, reply: any) => {
    const { stepId } = req.params as { stepId: string };
    const queryMode = req.query?.mode;
    const body = (req.body || {}) as {
      mode?: 'initial' | 'retest' | 'perfection';
      retestMode?: boolean;
      perfectionMode?: boolean;
      failedQuestionIds?: string[];
    };
    const effectiveMode = body.mode || queryMode || (body.retestMode ? 'retest' : body.perfectionMode ? 'perfection' : 'initial');

    try {
      let step = await prisma.skillStep.findUnique({ where: { id: stepId }, select: { id: true, status: true } });
      if (!step) {
        const ws = await prisma.workspace.findUnique({
          where: { id: stepId },
          include: { steps: { orderBy: { stepIndex: 'asc' } } },
        });
        if (ws && ws.steps.length > 0) {
          const activeS = ws.steps.find((s) => s.status !== 'PASSED') || ws.steps[0];
          step = activeS;
        }
      }
      if (!step) return reply.status(404).send({ error: 'Step not found' });
      if (step.status === 'LOCKED') return reply.send({ locked: true });
      const quiz = await generateLevelUpQuiz(step.id, {
        mode: effectiveMode,
        retestMode: body.retestMode || effectiveMode === 'retest',
        perfectionMode: body.perfectionMode || effectiveMode === 'perfection',
        failedQuestionIds: body.failedQuestionIds,
      });
      return reply.send(quiz);
    } catch (err: any) {
      fastify.log.error(err, '[GenerateQuiz] Failed');
      return reply.status(err.statusCode || 500).send({
        error: err.message || 'Failed to generate quiz',
      });
    }
  };

  fastify.post('/api/steps/:stepId/level-up-quiz', handlePostQuiz);
  fastify.post('/api/steps/:stepId/quiz', handlePostQuiz);

  fastify.post('/api/steps/:stepId/prompt-quiz', async (req, reply) => {
    const { stepId } = req.params as { stepId: string };
    const quiz = await generateLevelUpQuiz(stepId, { mode: 'initial' });
    return reply.send(quiz);
  });

  fastify.post('/api/quizzes/generate/:stepId', async (req, reply) => {
    const { stepId } = req.params as { stepId: string };
    const quiz = await generateLevelUpQuiz(stepId, { mode: 'initial' });
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
