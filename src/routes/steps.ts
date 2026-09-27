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
import { storeQuizSession, getQuizSession } from '../lib/quizStore';

export async function stepRoutes(fastify: FastifyInstance) {


  // POST /api/steps/:stepId/evaluate
  fastify.post('/api/steps/:stepId/evaluate', async (request: FastifyRequest, reply: FastifyReply) => {
    const { stepId } = request.params as { stepId: string };
    const body = request.body as {
      userAnswers: Array<{ questionId: string; selectedOptionIndex: number }>;
    };

    const step = await prisma.skillStep.findUnique({
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
        diagnosticReport: diagnostic.diagnosticReport,
        weakConcepts: safeJsonStringify(diagnostic.weakConcepts || []),
        remedialResources: safeJsonStringify(diagnostic.remedialResources || []),
      },
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

    const step = await prisma.skillStep.findUnique({
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

  // POST /api/workspaces/:workspaceId/generate-next-step
  fastify.post('/api/workspaces/:workspaceId/generate-next-step', async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId } = request.params as { workspaceId: string };

    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      include: {
        steps: {
          orderBy: { stepIndex: 'asc' },
        },
      },
    });

    if (!workspace) {
      return reply.status(404).send({ error: 'Workspace not found' });
    }

    const config = await prisma.adminConfig.findFirst();
    const groqKey = config?.groqKey || process.env.GROQ_API_KEY || '';
    const tavilyKey = config?.tavilyKey || process.env.TAVILY_API_KEY || '';
    const nextStepIndex = workspace.currentStepIndex + 1;
    const nextStepTitle = `Step ${nextStepIndex}: Advanced Application & Mastery`;
    const isMastered = nextStepIndex >= workspace.estimatedTotalSteps;

    let pedagogicalContent: any;
    try {
      const { runPedagogicalCuratorPipeline } = await import('../lib/ai/pipeline');
      pedagogicalContent = await runPedagogicalCuratorPipeline({
        domain: (workspace as any).domainCategory || (workspace as any).pillar || workspace.category || 'General Knowledge',
        topic: workspace.title,
        stepIndex: nextStepIndex,
        stepTitle: nextStepTitle,
        goal: workspace.targetGoal,
        groqKey,
        tavilyKey,
      });
    } catch (_) {
      pedagogicalContent = {
        whatYouWillLearn: `Deepen practical implementation and architectural mastery for ${workspace.title}.`,
        coreKeyTakeaways: ['Advanced implementation techniques', 'Performance optimization', 'Edge case resilience'],
        practicalApplication: workspace.targetGoal,
        assessableUnits: ['Advanced Implementation', 'System Resilience', 'Optimization Patterns'],
        questionCount: 5,
        resources: [],
      };
    }

    const coreKeyTakeaways = pedagogicalContent.coreKeyTakeaways || ['Advanced implementation'];
    const assessableUnits = pedagogicalContent.assessableUnits || ['Advanced Concepts'];
    const resources = pedagogicalContent.resources || [];

    const newStep = await prisma.skillStep.create({
      data: {
        workspaceId,
        stepIndex: nextStepIndex,
        title: nextStepTitle,
        difficulty: nextStepIndex <= 2 ? 'Intermediate' : nextStepIndex <= 4 ? 'Advanced' : 'Mastery',
        whatYouWillLearn: pedagogicalContent.whatYouWillLearn || 'Deepen implementation skills.',
        coreKeyTakeaways: safeJsonStringify(coreKeyTakeaways),
        practicalApplication: pedagogicalContent.practicalApplication || workspace.targetGoal,
        assessableUnits: safeJsonStringify(assessableUnits),
        questionCount: Number(pedagogicalContent.questionCount) || 5,
        resources: safeJsonStringify(resources),
        status: 'IN_PROGRESS',
      },
    });

    await prisma.workspace.update({
      where: { id: workspaceId },
      data: {
        currentStepIndex: nextStepIndex,
        status: isMastered ? 'MASTERED' : workspace.status,
      },
    });

    return reply.send({
      step: {
        ...newStep,
        coreKeyTakeaways,
        assessableUnits,
        resources,
        attempts: [],
      },
      workspaceMastered: isMastered,
      currentStepIndex: nextStepIndex,
    });
  });
}

export default stepRoutes;
