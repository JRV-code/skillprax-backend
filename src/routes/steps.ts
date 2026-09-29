import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import prisma from '../lib/prisma';
import {
  generateQuizQuestions,
  generateDiagnosticReport,
  generateRemedialQuiz,
  generateNextStep,
  buildContextPayload,
  safeJsonParse,
  safeJsonStringify,
} from '../lib/ai/orchestrator';
import { harvestResources, synthesizeStepMaterials } from '../lib/ai/pipeline';
import { storeQuizSession, getQuizSession } from '../lib/quizStore';

export async function stepRoutes(fastify: FastifyInstance) {

  // POST /api/steps/:stepId/level-up-resources
  fastify.post('/api/steps/:stepId/level-up-resources', async (request: FastifyRequest, reply: FastifyReply) => {
    const { stepId } = request.params as { stepId: string };
    const body = (request.body as any) || {};

    try {
      const step: any = await prisma.skillStep.findUnique({
        where: { id: stepId },
        include: { workspace: true },
      });

      if (!step) {
        return reply.status(404).send({ error: 'Step not found' });
      }

      let config = await prisma.adminConfig.findUnique({ where: { id: 'global' } });
      if (!config) config = await prisma.adminConfig.findFirst();
      const groqKey = config?.groqApiKey || config?.groqKey || process.env.GROQ_API_KEY;
      const tavilyKey = config?.tavilyApiKey || config?.tavilyKey || process.env.TAVILY_API_KEY;

      const candidates = await harvestResources(
        body.workspaceTitle || step.workspace?.title || step.title,
        body.title || step.title,
        tavilyKey,
        step.workspace?.domainCategory,
        step.workspace?.targetGoal
      );

      const materials = await synthesizeStepMaterials(
        body.title || step.title,
        step.workspace?.domainCategory || 'Science',
        step.workspace?.targetGoal || 'Full Mastery',
        step.workspace?.level || 'beginner',
        candidates,
        groqKey || undefined,
        body.stepIndex || step.stepIndex || 1
      );

      const updatedStep = await prisma.skillStep.update({
        where: { id: stepId },
        data: {
          resources: materials.resources as any,
          assessableUnits: (materials.acus && materials.acus.length > 0) ? (materials.acus as any) : step.assessableUnits,
          status: 'STUDY_READY',
        },
      });

      return reply.send({
        resources: materials.resources,
        acus: materials.acus,
        step: updatedStep,
      });
    } catch (err: any) {
      fastify.log.error(err, '[LevelUpResources] Failed');
      return reply.status(500).send({ error: err.message || 'Failed to synthesize resources' });
    }
  });


  // POST /api/steps/:stepId/evaluate
  fastify.post('/api/steps/:stepId/evaluate', async (request: FastifyRequest, reply: FastifyReply) => {
    const { stepId } = request.params as { stepId: string };
    const body = request.body as {
      userAnswers: Array<{ questionId: string; selectedOptionIndex: number }>;
    };

    const step: any = await prisma.skillStep.findUnique({
      where: { id: stepId },
      include: { workspace: true },
    });

    if (!step) {
      return reply.status(404).send({ error: 'SkillStep not found' });
    }

    // Retrieve full quiz questions from session store
    let cachedQuestions = getQuizSession(stepId);

    // Fallback if session expired or lost: regenerate / construct dummy grading fallback safely
    if (!cachedQuestions || cachedQuestions.length === 0) {
      const contextPayload = await buildContextPayload(step.workspaceId);
      const quizData = await generateQuizQuestions(
        step.title,
        step.whatYouWillLearn || step.title,
        step.difficulty,
        step.questionCount || 5,
        step.workspace.aiProvider || 'groq',
        contextPayload
      );
      cachedQuestions = quizData.questions || [];
      storeQuizSession(stepId, cachedQuestions);
    }

    const userAnswers = body?.userAnswers || [];
    let correctCount = 0;
    const failedQuestions: any[] = [];

    cachedQuestions.forEach((q) => {
      const userAns = userAnswers.find((u) => u.questionId === q.id);
      const isCorrect = userAns && userAns.selectedOptionIndex === q.correctIndex;
      if (isCorrect) {
        correctCount++;
      } else {
        failedQuestions.push({
          questionId: q.id,
          questionText: q.question,
          options: q.options,
          correctOptionIndex: q.correctIndex,
          selectedOptionIndex: userAns ? userAns.selectedOptionIndex : -1,
          selectedOptionText: userAns && userAns.selectedOptionIndex >= 0 ? q.options[userAns.selectedOptionIndex] : 'None',
          conceptTested: q.conceptTested,
        });
      }
    });

    const totalQuestions = cachedQuestions.length || 1;
    const score = Math.round((correctCount / totalQuestions) * 100);
    const passed = score >= step.passingScore;

    if (passed) {
      // CASE A: PASS
      await prisma.skillStep.update({
        where: { id: stepId },
        data: { status: 'PASSED' },
      });

      await prisma.quizAttempt.create({
        data: {
          stepId,
          score,
          passed: true,
          userAnswers: safeJsonStringify(userAnswers),
        },
      });

      return reply.send({
        passed: true,
        score,
        passingScore: step.passingScore,
        canAdvance: true,
      });
    }

    // CASE B: FAIL
    const contextPayload = await buildContextPayload(step.workspaceId);
    const diagnostic = await generateDiagnosticReport(
      step.title,
      step.whatYouWillLearn || step.title,
      failedQuestions,
      step.workspace.aiProvider || 'groq',
      contextPayload
    );

    const attempt = await prisma.quizAttempt.create({
      data: {
        stepId,
        score,
        passed: false,
        userAnswers: safeJsonStringify(userAnswers),
      } as any,
    });

    return reply.send({
      passed: false,
      score,
      passingScore: step.passingScore,
      diagnosticReport: diagnostic.diagnosticReport,
      weakConcepts: diagnostic.weakConcepts || [],
      remedialResources: diagnostic.remedialResources || [],
      attemptId: attempt.id,
    });
  });

  // POST /api/steps/:stepId/remedial-quiz
  fastify.post('/api/steps/:stepId/remedial-quiz', async (request: FastifyRequest, reply: FastifyReply) => {
    const { stepId } = request.params as { stepId: string };

    const step: any = await prisma.skillStep.findUnique({
      where: { id: stepId },
      include: {
        workspace: true,
        attempts: {
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });

    if (!step) {
      return reply.status(404).send({ error: 'SkillStep not found' });
    }

    const latestAttempt = step.attempts[0];
    const weakConcepts = safeJsonParse<string[]>(latestAttempt?.weakConcepts, ['Core step principles']);

    const contextPayload = await buildContextPayload(step.workspaceId);
    const remedialData = await generateRemedialQuiz(
      step.title,
      step.whatYouWillLearn || step.title,
      weakConcepts,
      step.workspace.aiProvider || 'groq',
      contextPayload
    );

    const questions = remedialData.questions || [];
    storeQuizSession(stepId, questions);

    const sanitizedQuestions = questions.map(({ correctIndex, ...q }: any) => q);

    return reply.send({
      stepId,
      weakConcepts,
      questions: sanitizedQuestions,
    });
  });
}

export default stepRoutes;


