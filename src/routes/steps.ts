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
import { searchTavilyCurriculum } from '../services/search';
import { storeQuizSession, getQuizSession } from '../lib/quizStore';

import { executeCurriculumPipeline } from '../services/curriculumPipeline';
import {
  searchTavily,
  extractYouTubeId,
  normalizeUrl,
  isSafePublicUrl,
  verifyLink,
  checkYouTube,
  callGroqJson,
  assertNoUrls,
} from '../lib/foundation';
import { LEARNING_CONFIG } from '../config/learning';

export async function stepRoutes(fastify: FastifyInstance) {

  // POST /api/steps/:stepId/level-up-resources — Click-only pipeline execution
  fastify.post('/api/steps/:stepId/level-up-resources', async (request: FastifyRequest, reply: FastifyReply) => {
    const { stepId } = request.params as { stepId: string };

    try {
      const pipelineResult = await executeCurriculumPipeline(stepId);

      if (pipelineResult.status === 'NO_SOURCE_FOUND') {
        return reply.status(200).send({
          status: 'NO_SOURCE_FOUND',
          message: 'No verified source found — Retry',
          resources: [],
          topicMap: pipelineResult.topicMap,
          tier: pipelineResult.tier,
          timings: pipelineResult.timings,
          totalTimeMs: pipelineResult.totalTimeMs,
        });
      }

      const updatedStep = await prisma.skillStep.findUnique({
        where: { id: stepId },
        include: { contentDocument: true },
      });

      return reply.send({
        status: 'STUDY_READY',
        resources: pipelineResult.resources,
        topicMap: pipelineResult.topicMap,
        approachBrief: pipelineResult.approachBrief,
        tier: pipelineResult.tier,
        document: updatedStep?.contentDocument,
        step: updatedStep,
        timings: pipelineResult.timings,
        totalTimeMs: pipelineResult.totalTimeMs,
      });
    } catch (err: any) {
      fastify.log.error(err, '[LevelUpResources] Failed');
      return reply.status(500).send({ error: err.message || 'Failed to synthesize resources' });
    }
  });

  // GET /api/steps/:stepId/guide — Fetch Study Book and Approach Brief
  fastify.get('/api/steps/:stepId/guide', async (request: FastifyRequest, reply: FastifyReply) => {
    const { stepId } = request.params as { stepId: string };

    try {
      const step = await prisma.skillStep.findUnique({
        where: { id: stepId },
        include: { contentDocument: true },
      });

      if (!step) {
        return reply.status(404).send({ error: 'Step not found' });
      }

      const doc = step.contentDocument;
      return reply.send({
        stepId: step.id,
        difficultyTier: step.difficultyTier,
        approachViewedAt: step.approachViewedAt,
        resources: step.resources || [],
        document: doc || null,
        topicMap: doc?.topicMap || [],
        approachBrief: doc?.approachBrief || null,
      });
    } catch (err: any) {
      fastify.log.error(err, '[GET /api/steps/:stepId/guide] Failed');
      return reply.status(500).send({ error: 'Failed to fetch guide' });
    }
  });

  // POST /api/steps/:stepId/topics/:topicKey/retry — Per-topic recovery search + verification
  fastify.post('/api/steps/:stepId/topics/:topicKey/retry', async (request: FastifyRequest, reply: FastifyReply) => {
    const { stepId, topicKey } = request.params as { stepId: string; topicKey: string };

    try {
      const step: any = await prisma.skillStep.findUnique({
        where: { id: stepId },
        include: { contentDocument: true, workspace: true },
      });

      if (!step || !step.contentDocument) {
        return reply.status(404).send({ error: 'Step or document not found' });
      }

      const doc = step.contentDocument;
      const topicMap: any[] = Array.isArray(doc.topicMap) ? doc.topicMap : [];
      const topic = topicMap.find((t: any) => t.key === topicKey);

      if (!topic) {
        return reply.status(404).send({ error: 'Topic not found in topicMap' });
      }

      const history = await prisma.resourceHistory.findMany({
        where: { workspaceId: step.workspaceId },
        select: { identifier: true },
      });
      const historySet = new Set(history.map((h) => h.identifier));

      const query = `${step.workspace?.title || ''} "${topic.title}" ${topic.covers || ''} 2026`.trim();
      const results = await searchTavily(query, { searchDepth: 'basic', maxResults: 4 });

      let replacementResource: any = null;
      for (const r of results) {
        if (!r.url || historySet.has(normalizeUrl(r.url))) continue;
        if (!(await isSafePublicUrl(r.url))) continue;
        const status = await verifyLink(r.url, r.content);
        if (status === 'DEAD') continue;

        const vId = extractYouTubeId(r.url);
        let isEmbeddable = true;
        let channelName = 'Web Document';
        if (vId) {
          const yt = await checkYouTube(vId);
          if (yt.status === 'GONE') continue;
          if (yt.status === 'NO_EMBED') isEmbeddable = false;
          channelName = yt.channel || 'YouTube';
        }

        replacementResource = {
          id: `res-${step.stepIndex}-retry-${Date.now().toString(36)}`,
          type: vId ? 'video' : 'doc',
          title: r.title,
          url: r.url,
          videoId: vId,
          channelName,
          embeddable: isEmbeddable,
          topicKey,
          focusNote: r.content?.slice(0, 160) || `Focus on ${topic.title}.`,
          snippet: r.content?.slice(0, 160) || '',
          linkStatus: status,
          checkedAt: new Date().toISOString(),
        };
        break;
      }

      if (!replacementResource) {
        return reply.status(404).send({ error: 'No verified replacement link found for this topic.' });
      }

      // Add to step resources and update topicMap
      const currentResources: any[] = Array.isArray(step.resources) ? [...step.resources] : [];
      currentResources.push(replacementResource);
      topic.resourceIds = [...(topic.resourceIds || []), replacementResource.id];
      topic.status = 'READY';

      await prisma.$transaction([
        prisma.skillStep.update({
          where: { id: stepId },
          data: { resources: currentResources as any },
        }),
        prisma.contentDocument.update({
          where: { id: doc.id },
          data: { topicMap: topicMap as any },
        }),
        prisma.resourceHistory.create({
          data: {
            profileId: step.workspace?.userProfileId || 'default-profile',
            workspaceId: step.workspaceId,
            stepIndex: step.stepIndex,
            resourceType: replacementResource.type === 'video' ? 'YOUTUBE_VIDEO' : 'DOC_URL',
            identifier: replacementResource.videoId || normalizeUrl(replacementResource.url),
          },
        }),
      ]);

      return reply.send({
        success: true,
        topic,
        newResource: replacementResource,
      });
    } catch (err: any) {
      fastify.log.error(err, '[TopicRetry] Failed');
      return reply.status(500).send({ error: 'Topic retry failed' });
    }
  });

  // POST /api/resources/:id/replace — "Link broken? Replace"
  fastify.post('/api/resources/:id/replace', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    try {
      // Find step containing this resource
      const steps = await prisma.skillStep.findMany({
        where: { resources: { not: '[]' } },
        include: { contentDocument: true, workspace: true },
      });

      let targetStep: any = null;
      let targetResource: any = null;

      for (const s of steps) {
        const rawRes: any[] = Array.isArray(s.resources) ? s.resources : [];
        const found = rawRes.find((r) => r.id === id);
        if (found) {
          targetStep = s;
          targetResource = found;
          break;
        }
      }

      if (!targetStep || !targetResource) {
        return reply.status(404).send({ error: 'Resource not found' });
      }

      const topicKey = targetResource.topicKey || 't1';
      const doc = targetStep.contentDocument;
      const topicMap: any[] = doc && Array.isArray(doc.topicMap) ? doc.topicMap : [];
      const topic = topicMap.find((t: any) => t.key === topicKey);

      // Check replacement limit: limit 3 replacements per topic per step
      const stepResources: any[] = Array.isArray(targetStep.resources) ? [...targetStep.resources] : [];
      const replacedCount = stepResources.filter((r) => r.topicKey === topicKey && r.linkStatus === 'DEAD').length;
      if (replacedCount >= 3) {
        return reply.status(400).send({ error: 'Replacement limit of 3 reached for this topic.' });
      }

      // Mark target resource DEAD (its identifier stays in history)
      targetResource.linkStatus = 'DEAD';

      const history = await prisma.resourceHistory.findMany({
        where: { workspaceId: targetStep.workspaceId },
        select: { identifier: true },
      });
      const historySet = new Set(history.map((h) => h.identifier));

      const query = `${targetStep.workspace?.title || ''} "${topic?.title || targetStep.title}" ${targetResource.type === 'video' ? 'tutorial drills' : 'guide technical'} 2026`.trim();
      const searchResults = await searchTavily(query, {
        searchDepth: 'basic',
        maxResults: 5,
        includeDomains: targetResource.type === 'video' ? ['youtube.com'] : undefined,
      });

      let replacement: any = null;
      for (const res of searchResults) {
        if (!res.url) continue;
        const norm = normalizeUrl(res.url);
        if (historySet.has(norm)) continue;
        if (!(await isSafePublicUrl(res.url))) continue;

        const vId = extractYouTubeId(res.url);
        if (targetResource.type === 'video' && !vId) continue;

        const status = await verifyLink(res.url, res.content);
        if (status === 'DEAD') continue;

        let isEmbeddable = true;
        let channelName = 'Web Document';
        if (vId) {
          const yt = await checkYouTube(vId);
          if (yt.status === 'GONE') continue;
          if (yt.status === 'NO_EMBED') isEmbeddable = false;
          channelName = yt.channel || 'YouTube';
        }

        replacement = {
          id: `res-${targetStep.stepIndex}-swap-${Date.now().toString(36)}`,
          type: vId ? 'video' : 'doc',
          title: res.title,
          url: res.url,
          videoId: vId,
          channelName,
          embeddable: isEmbeddable,
          topicKey,
          focusNote: res.content?.slice(0, 160) || targetResource.focusNote,
          snippet: res.content?.slice(0, 160) || '',
          linkStatus: status,
          checkedAt: new Date().toISOString(),
        };
        break;
      }

      if (!replacement) {
        // Persist the DEAD mark so it's not shown as live
        await prisma.skillStep.update({
          where: { id: targetStep.id },
          data: { resources: stepResources as any },
        });
        return reply.status(404).send({ error: 'No verified replacement link found at this time.' });
      }

      // Swap in the replacement
      const updatedResources = stepResources.map((r) => (r.id === id ? replacement : r));
      if (topic) {
        topic.resourceIds = (topic.resourceIds || []).map((rId: string) => (rId === id ? replacement.id : rId));
      }

      await prisma.$transaction([
        prisma.skillStep.update({
          where: { id: targetStep.id },
          data: { resources: updatedResources as any },
        }),
        ...(doc
          ? [
              prisma.contentDocument.update({
                where: { id: doc.id },
                data: { topicMap: topicMap as any },
              }),
            ]
          : []),
        prisma.resourceHistory.create({
          data: {
            profileId: targetStep.workspace?.userProfileId || 'default-profile',
            workspaceId: targetStep.workspaceId,
            stepIndex: targetStep.stepIndex,
            resourceType: replacement.type === 'video' ? 'YOUTUBE_VIDEO' : 'DOC_URL',
            identifier: replacement.videoId || normalizeUrl(replacement.url),
          },
        }),
      ]);

      return reply.send({
        success: true,
        previousResourceId: id,
        replacement,
      });
    } catch (err: any) {
      fastify.log.error(err, '[ResourceReplace] Failed');
      return reply.status(500).send({ error: 'Failed to replace resource' });
    }
  });

  // POST /api/steps/:stepId/approach — Generate or regenerate pre-study game plan
  fastify.post('/api/steps/:stepId/approach', async (request: FastifyRequest, reply: FastifyReply) => {
    const { stepId } = request.params as { stepId: string };

    try {
      const step: any = await prisma.skillStep.findUnique({
        where: { id: stepId },
        include: { contentDocument: true, workspace: true },
      });

      if (!step) {
        return reply.status(404).send({ error: 'Step not found' });
      }

      const doc = step.contentDocument;
      const topicMap: any[] = doc && Array.isArray(doc.topicMap) ? doc.topicMap : [];
      const resources: any[] = Array.isArray(step.resources) ? step.resources : [];

      const gamePlanSystem = `You are a Lead Learning Strategist.
Write an actionable pre-study Game Plan for the milestone before the learner opens any resources.
Rules:
- NEVER include timestamps (no "1:23" or similar).
- NEVER make claims about specific internal video content beyond what its title/snippet states.
- Tailor howToStudy to the domain.
- Each bullet point must be direct and under 25 words.
- STRICT: NO URLs. Output JSON ONLY:
{
  "goal": "Clear one-sentence milestone goal",
  "whyNow": "Why this milestone matters at this stage",
  "totalMinutes": 45,
  "order": [{ "topicKey": "t1", "why": "Builds base foundation" }],
  "beforeYouStart": ["2-3 predict-before-you-study questions"],
  "perResource": [{ "resourceId": "res-id", "focus": "what to observe", "ignore": "what to skip", "timebox": "10 min" }],
  "howToStudy": ["3-4 active techniques"],
  "commonMistakes": ["2-4 mistakes"],
  "selfCheck": [{ "prompt": "Self check question 1", "hint": "Hint to self-check" }]
}`;

      const gamePlanUser = `Domain: "${step.workspace?.domainCategory || 'General Knowledge'}".
Skill: "${step.workspace?.title || step.title}".
Sub-genre: "${step.workspace?.subGenre || 'Core'}".
Step ${step.stepIndex} (${step.difficultyTier || 'FOUNDATIONS'}): "${step.title}".
Topics: ${JSON.stringify(topicMap.map((t) => ({ key: t.key, title: t.title })))}.
Assigned Resources: ${JSON.stringify(resources.map((r) => ({ id: r.id, type: r.type, title: r.title, snippet: r.snippet })))}.`;

      const generatedBrief = await callGroqJson<any>(gamePlanSystem, gamePlanUser, {
        validate: (v: any) =>
          typeof v?.goal === 'string' &&
          Array.isArray(v?.beforeYouStart) &&
          Array.isArray(v?.howToStudy) &&
          !/\b\d{1,2}:\d{2}\b/.test(JSON.stringify(v)),
        maxTokens: 1800,
        temperature: 0.3,
      });
      assertNoUrls(generatedBrief, 'GamePlanRegen');

      const approachBrief = {
        ...generatedBrief,
        masteryTarget: { passPercent: LEARNING_CONFIG.PASS_THRESHOLD_PERCENT },
      };

      if (doc) {
        await prisma.contentDocument.update({
          where: { id: doc.id },
          data: { approachBrief: approachBrief as any },
        });
      }

      return reply.send({ success: true, approachBrief });
    } catch (err: any) {
      fastify.log.error(err, '[StepApproach] Failed');
      return reply.status(500).send({ error: 'Failed to generate game plan' });
    }
  });

  // POST /api/steps/:stepId/approach-viewed — Sets Step.approachViewedAt
  fastify.post('/api/steps/:stepId/approach-viewed', async (request: FastifyRequest, reply: FastifyReply) => {
    const { stepId } = request.params as { stepId: string };

    try {
      const updated = await prisma.skillStep.update({
        where: { id: stepId },
        data: { approachViewedAt: new Date() },
      });

      return reply.send({
        success: true,
        approachViewedAt: updated.approachViewedAt,
      });
    } catch (err: any) {
      fastify.log.error(err, '[ApproachViewed] Failed');
      return reply.status(500).send({ error: 'Failed to record approach viewed' });
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


