import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import prisma from '../../lib/prisma';
import {
  claimPackBuild,
  claimQuizBuild,
  enqueueJob,
  runPackBuild,
} from '../../services/learning/packPipeline';
import { runQuizBuild } from '../../services/learning/quiz';
import {
  searchTavily,
  extractYouTubeId,
  checkYouTube,
  verifyLink,
  isSafePublicUrl,
  domainOf,
  normalizeUrl,
  callGroqJson,
  assertNoUrls,
} from '../../services/learning/foundation';

export const curriculumLearningRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // 1. POST /api/steps/:stepId/level-up-resources — Click-triggered pack build
  fastify.post('/api/steps/:stepId/level-up-resources', async (req, reply) => {
    const { stepId } = req.params as { stepId: string };
    try {
      let step = await prisma.skillStep.findUnique({
        where: { id: stepId },
        include: { workspace: true },
      });
      if (!step) {
        // Fallback: Check if caller passed a workspaceId
        const ws = await prisma.workspace.findUnique({
          where: { id: stepId },
          include: { steps: { orderBy: { stepIndex: 'asc' } } },
        });
        if (ws && ws.steps.length > 0) {
          const activeS = ws.steps.find((s) => s.status !== 'PASSED') || ws.steps[0];
          step = { ...activeS, workspace: ws } as any;
        }
      }
      if (!step) return reply.status(404).send({ error: 'Step not found' });

      const claimed = await claimPackBuild(step.id);
      if (claimed) {
        enqueueJob(() => runPackBuild(step.id));
      }

      return reply.status(202).send({
        success: true,
        message: claimed ? 'Pack build queued' : 'Pack build already in progress',
        packStatus: 'BUILDING',
        stepId: step.id,
      });
    } catch (err: any) {
      fastify.log.error(err, '[CurriculumBuild] Failed');
      return reply.status(500).send({ error: err.message || 'Failed to start pack build' });
    }
  });

  // 2. POST /api/steps/:stepId/engaged — Silent prefetch trigger (T-B)
  fastify.post('/api/steps/:stepId/engaged', async (req, reply) => {
    const { stepId } = req.params as { stepId: string };
    try {
      let step = await prisma.skillStep.findUnique({
        where: { id: stepId },
        include: {
          workspace: {
            include: {
              steps: { orderBy: { stepIndex: 'asc' } },
            },
          },
        },
      });

      if (!step) {
        const ws = await prisma.workspace.findUnique({
          where: { id: stepId },
          include: {
            steps: { orderBy: { stepIndex: 'asc' } },
          },
        });
        if (ws && ws.steps.length > 0) {
          const activeS = ws.steps.find((s) => s.status !== 'PASSED') || ws.steps[0];
          step = { ...activeS, workspace: ws } as any;
        }
      }

      if (!step) return reply.status(404).send({ error: 'Step not found' });
      if (step.status === 'LOCKED') return reply.status(403).send({ error: 'Step is locked' });
      if (step.packStatus !== 'READY') return reply.status(400).send({ error: 'Step pack must be READY' });

      await prisma.skillStep.update({
        where: { id: step.id },
        data: { engagedAt: new Date() },
      });

      // 1) Enqueue quiz for step N if not built
      if (step.quizStatus === 'NOT_BUILT' || step.quizStatus === 'FAILED') {
        const quizClaimed = await claimQuizBuild(step.id);
        if (quizClaimed) {
          enqueueJob(() => runQuizBuild(step.id));
        }
      }

      // 2) Lookahead step N+1: build pack, then quiz for N+1
      const nextStep = step.workspace.steps.find((s) => s.stepIndex === step.stepIndex + 1);
      if (nextStep && (nextStep.packStatus === 'NOT_BUILT' || nextStep.packStatus === 'FAILED')) {
        const packClaimed = await claimPackBuild(nextStep.id);
        if (packClaimed) {
          enqueueJob(async () => {
            await runPackBuild(nextStep.id);
            const nextQuizClaimed = await claimQuizBuild(nextStep.id);
            if (nextQuizClaimed) {
              await runQuizBuild(nextStep.id);
            }
          });
        }
      }

      return reply.send({ success: true, message: 'Engagement registered; silent prefetch enqueued' });
    } catch (err: any) {
      fastify.log.error(err, '[StepEngaged] Failed');
      return reply.status(500).send({ error: err.message || 'Failed to register engagement' });
    }
  });

  // 3. GET /api/steps/:stepId/status — Polling endpoint
  fastify.get('/api/steps/:stepId/status', async (req, reply) => {
    const { stepId } = req.params as { stepId: string };
    try {
      let step = await prisma.skillStep.findUnique({
        where: { id: stepId },
        select: {
          id: true,
          status: true,
          stepIndex: true,
          packStatus: true,
          packStage: true,
          packError: true,
          quizStatus: true,
          quizError: true,
        },
      });

      if (!step) {
        const ws = await prisma.workspace.findUnique({
          where: { id: stepId },
          include: {
            steps: {
              orderBy: { stepIndex: 'asc' },
              select: {
                id: true,
                status: true,
                stepIndex: true,
                packStatus: true,
                packStage: true,
                packError: true,
                quizStatus: true,
                quizError: true,
              },
            },
          },
        });
        if (ws && ws.steps.length > 0) {
          step = ws.steps.find((s) => s.status !== 'PASSED') || ws.steps[0];
        }
      }

      if (!step) return reply.status(404).send({ error: 'Step not found' });
      return reply.send({
        locked: step.status === 'LOCKED',
        packStatus: step.packStatus,
        packStage: step.packStage,
        packError: step.packError,
        quizStatus: step.quizStatus,
        quizError: step.quizError,
      });
    } catch (err: any) {
      fastify.log.error(err, '[GetStepStatus] Failed');
      return reply.status(500).send({ error: err.message || 'Failed to fetch step status' });
    }
  });

  // 4. GET /api/steps/:stepId/pack — Honest book payload (NEVER facts or page text)
  fastify.get('/api/steps/:stepId/pack', async (req, reply) => {
    const { stepId } = req.params as { stepId: string };
    const { lang } = (req.query || {}) as { lang?: string };

    try {
      let step = await prisma.skillStep.findUnique({
        where: { id: stepId },
        include: {
          stepChapters: {
            orderBy: { order: 'asc' },
            include: {
              topics: {
                orderBy: { order: 'asc' },
                include: { resources: true },
              },
            },
          },
          stepResources: true,
        },
      });

      if (!step) {
        const ws = await prisma.workspace.findUnique({
          where: { id: stepId },
          include: { steps: { orderBy: { stepIndex: 'asc' } } },
        });
        if (ws && ws.steps.length > 0) {
          const activeS = ws.steps.find((s) => s.status !== 'PASSED') || ws.steps[0];
          step = await prisma.skillStep.findUnique({
            where: { id: activeS.id },
            include: {
              stepChapters: {
                orderBy: { order: 'asc' },
                include: {
                  topics: {
                    orderBy: { order: 'asc' },
                    include: { resources: true },
                  },
                },
              },
              stepResources: true,
            },
          });
        }
      }

      if (!step) return reply.status(404).send({ error: 'Step not found' });
      if (step.status === 'LOCKED') {
        return reply.send({ locked: true });
      }

      let intro = step.intro;
      let translatedChapters = null;

      if (lang && lang !== 'en') {
        const cachedTrans = await prisma.stepTranslation.findUnique({
          where: { stepId_languageCode: { stepId, languageCode: lang } },
        });
        if (cachedTrans && cachedTrans.payload) {
          const p = cachedTrans.payload as any;
          intro = p.intro || intro;
          translatedChapters = p.chapters || null;
        }
      }

      const allVideos = step.stepResources
        .filter((r) => r.type === 'youtube' && r.videoId)
        .map((r) => ({
          id: r.id,
          title: r.title,
          videoId: r.videoId,
          videoType: r.videoType || 'tutorial',
          channelName: r.channelName,
          embeddable: r.embeddable ?? true,
          chapterId: r.chapterId,
        }));

      const chapters = step.stepChapters.map((ch, chIdx) => {
        const transCh = translatedChapters?.[chIdx];
        const chVideo = step.stepResources.find((r) => r.chapterId === ch.id && r.type === 'youtube')
          || (allVideos.length > 0 ? allVideos[chIdx % allVideos.length] : null);

        return {
          id: ch.id,
          order: ch.order,
          title: transCh?.title || ch.title,
          summary: transCh?.summary || ch.summary,
          video: chVideo
            ? {
                id: chVideo.id,
                title: chVideo.title,
                videoId: chVideo.videoId,
                videoType: chVideo.videoType || 'tutorial',
                channelName: chVideo.channelName,
                embeddable: chVideo.embeddable,
              }
            : null,
          videos: allVideos.filter((v) => v.chapterId === ch.id),
          topics: ch.topics.map((t, tIdx) => {
            const transTopic = transCh?.topics?.[tIdx];
            const docRes = t.resources.find((r) => r.type === 'doc') || t.resources[0];

            return {
              id: t.id,
              key: t.key,
              order: t.order,
              title: transTopic?.title || t.title,
              covers: transTopic?.covers || t.covers,
              minutes: t.minutes,
              acuIds: t.acuIds,
              guide: transTopic?.guide || t.guide,
              status: t.status,
              resource: docRes
                ? {
                    id: docRes.id,
                    url: docRes.url,
                    title: docRes.title,
                    domain: docRes.domain,
                    linkStatus: docRes.linkStatus,
                    videoId: docRes.videoId,
                    videoType: docRes.videoType,
                    embeddable: docRes.embeddable,
                  }
                : null,
            };
          }),
        };
      });

      return reply.send({
        id: step.id,
        stepIndex: step.stepIndex,
        title: step.title,
        difficultyTier: step.difficultyTier,
        packStatus: step.packStatus,
        packStage: step.packStage,
        intro,
        chapters,
        videos: allVideos,
      });
    } catch (err: any) {
      fastify.log.error(err, '[GetStepPack] Failed');
      return reply.status(500).send({ error: err.message || 'Failed to fetch step pack' });
    }
  });

  // 5. POST /api/steps/:stepId/topics/:topicKey/retry — Per-topic retry
  fastify.post('/api/steps/:stepId/topics/:topicKey/retry', async (req, reply) => {
    const { stepId, topicKey } = req.params as { stepId: string; topicKey: string };
    try {
      const topic = await prisma.stepTopic.findUnique({
        where: { stepId_key: { stepId, key: topicKey } },
        include: { step: { include: { workspace: true } } },
      });

      if (!topic) return reply.status(404).send({ error: 'Topic not found' });

      const history = await prisma.resourceHistory.findMany({
        where: { workspaceId: topic.step.workspaceId },
      });
      const historyUrls = new Set(history.map((h) => h.identifier));

      const query = `${topic.step.workspace.title} "${topic.title}" comprehensive guide`;
      const candidates = await searchTavily(query, { maxResults: 5, includeRawContent: true });

      let found: any = null;
      for (const c of candidates) {
        const norm = normalizeUrl(c.url);
        if (historyUrls.has(norm)) continue;
        const verified = await verifyLink(c.url, c.rawContent || c.content);
        if (verified.status !== 'DEAD') {
          found = { url: verified.finalUrl, title: c.title, domain: domainOf(verified.finalUrl) };
          break;
        }
      }

      if (!found) {
        return reply.status(404).send({ error: 'No working link found for this topic retry' });
      }

      await prisma.resource.deleteMany({ where: { topicId: topic.id } });
      const createdRes = await prisma.resource.create({
        data: {
          stepId,
          topicId: topic.id,
          chapterId: topic.chapterId,
          type: 'doc',
          title: found.title,
          url: found.url,
          domain: found.domain,
          linkStatus: 'VERIFIED',
          checkedAt: new Date(),
        },
      });

      await prisma.stepTopic.update({
        where: { id: topic.id },
        data: { status: 'READY' },
      });

      return reply.send({ success: true, resource: createdRes });
    } catch (err: any) {
      fastify.log.error(err, '[RetryTopic] Failed');
      return reply.status(500).send({ error: err.message || 'Topic retry failed' });
    }
  });

  // 6. POST /api/resources/:id/replace — "Link broken? Replace"
  fastify.post('/api/resources/:id/replace', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const res = await prisma.resource.findUnique({
        where: { id },
        include: { step: { include: { workspace: true } }, topic: true },
      });

      if (!res || !res.step) return reply.status(404).send({ error: 'Resource not found' });

      const history = await prisma.resourceHistory.findMany({
        where: { workspaceId: res.step.workspaceId },
      });
      const historyUrls = new Set(history.map((h) => h.identifier));

      const topicTitle = res.topic?.title || res.title;
      const isVideo = res.type === 'youtube';

      let replacement: { url: string; title: string; domain: string; videoId?: string } | null = null;

      if (isVideo) {
        const query = `${res.step.workspace.title} "${topicTitle}" tutorial`;
        const vids = await searchTavily(query, {
          maxResults: 6,
          includeDomains: ['youtube.com'],
        });
        for (const v of vids) {
          const ytId = extractYouTubeId(v.url);
          if (!ytId || historyUrls.has(`yt:${ytId}`) || historyUrls.has(v.url)) continue;
          const chk = await checkYouTube(ytId);
          if (chk.status === 'EMBEDDABLE' || chk.status === 'UNKNOWN') {
            replacement = {
              url: `https://www.youtube.com/watch?v=${ytId}`,
              title: v.title,
              domain: 'youtube.com',
              videoId: ytId,
            };
            break;
          }
        }
      } else {
        const query = `${res.step.workspace.title} "${topicTitle}" guide`;
        const docs = await searchTavily(query, { maxResults: 6, includeRawContent: true });
        for (const d of docs) {
          const norm = normalizeUrl(d.url);
          if (historyUrls.has(norm)) continue;
          const v = await verifyLink(d.url, d.rawContent || d.content);
          if (v.status !== 'DEAD') {
            replacement = { url: v.finalUrl, title: d.title, domain: domainOf(v.finalUrl) };
            break;
          }
        }
      }

      if (!replacement) {
        return reply.status(404).send({
          error: 'No alternative verified resource could be located. Please retry shortly.',
        });
      }

      const updated = await prisma.resource.update({
        where: { id },
        data: {
          url: replacement.url,
          title: replacement.title,
          domain: replacement.domain,
          videoId: replacement.videoId || null,
          linkStatus: 'VERIFIED',
          checkedAt: new Date(),
        },
      });

      return reply.send({ success: true, resource: updated });
    } catch (err: any) {
      fastify.log.error(err, '[ReplaceResource] Failed');
      return reply.status(500).send({ error: err.message || 'Resource replacement failed' });
    }
  });

  // 7. GET /api/steps/:stepId/attempts — AttemptResult history
  fastify.get('/api/steps/:stepId/attempts', async (req, reply) => {
    const { stepId } = req.params as { stepId: string };
    try {
      const attempts = await prisma.attemptResult.findMany({
        where: { stepId },
        orderBy: { createdAt: 'desc' },
      });
      return reply.send(attempts);
    } catch (err: any) {
      fastify.log.error(err, '[GetAttempts] Failed');
      return reply.status(500).send({ error: err.message || 'Failed to fetch attempts' });
    }
  });

  // 8. PUT /api/resources/:id/video-progress — Video watch tracking
  fastify.put('/api/resources/:id/video-progress', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { seconds, duration, watched, profileId } = (req.body || {}) as {
      seconds: number;
      duration?: number;
      watched?: boolean;
      profileId?: string;
    };

    try {
      const targetProfileId = profileId || 'default-profile';
      const progress = await prisma.videoProgress.upsert({
        where: {
          profileId_resourceId: {
            profileId: targetProfileId,
            resourceId: id,
          },
        },
        create: {
          profileId: targetProfileId,
          resourceId: id,
          seconds: Math.floor(seconds || 0),
          duration: duration ? Math.floor(duration) : null,
          watched: Boolean(watched),
        },
        update: {
          seconds: Math.floor(seconds || 0),
          duration: duration ? Math.floor(duration) : undefined,
          watched: Boolean(watched),
        },
      });

      return reply.send({ success: true, progress });
    } catch (err: any) {
      fastify.log.error(err, '[VideoProgress] Failed');
      return reply.status(500).send({ error: err.message || 'Failed to update video progress' });
    }
  });

  // 9. POST /api/steps/:stepId/translate — In-app pack translation
  fastify.post('/api/steps/:stepId/translate', async (req, reply) => {
    const { stepId } = req.params as { stepId: string };
    const { languageCode } = (req.body || {}) as { languageCode: string };

    if (!languageCode || languageCode === 'en') {
      return reply.send({ success: true, message: 'English requires no translation' });
    }

    try {
      const step = await prisma.skillStep.findUnique({
        where: { id: stepId },
        include: {
          stepChapters: {
            orderBy: { order: 'asc' },
            include: { topics: { orderBy: { order: 'asc' } } },
          },
        },
      });

      if (!step) return reply.status(404).send({ error: 'Step not found' });

      // Check cache
      const cached = await prisma.stepTranslation.findUnique({
        where: { stepId_languageCode: { stepId, languageCode } },
      });
      if (cached) {
        return reply.send({ success: true, cached: true, translation: cached.payload });
      }

      const promptSystem = `You are a Professional Technical Translator.
Translate the following curriculum structure into language code "${languageCode}".
Preserve all topic keys, ACU IDs, numbers, and formatting untouched.
Translate intro, chapter titles, topic titles, covers, and guide texts accurately.
Return strictly JSON matching this structure:
{
  "intro": { "goal": "...", "whyNow": "...", "studyOrder": ["t1"], "mistakes": ["..."] },
  "chapters": [
    {
      "title": "...",
      "summary": "...",
      "topics": [
        {
          "key": "t1",
          "title": "...",
          "covers": "...",
          "guide": { "lookFor": ["..."], "skip": "...", "doThis": "..." }
        }
      ]
    }
  ]
}`;

      const userPayload = JSON.stringify({
        intro: step.intro,
        chapters: step.stepChapters.map((ch) => ({
          title: ch.title,
          summary: ch.summary,
          topics: ch.topics.map((t) => ({
            key: t.key,
            title: t.title,
            covers: t.covers,
            guide: t.guide,
          })),
        })),
      });

      const translated = await callGroqJson<any>(promptSystem, userPayload, {
        validate: (data: any) => {
          assertNoUrls(data, 'Translation');
          if (!data?.intro || !Array.isArray(data?.chapters)) throw new Error('Invalid translation format');
          return data;
        },
        maxTokens: 5000,
        temperature: 0.1,
      });

      await prisma.stepTranslation.upsert({
        where: { stepId_languageCode: { stepId, languageCode } },
        create: {
          stepId,
          languageCode,
          payload: translated,
        },
        update: {
          payload: translated,
        },
      });

      return reply.send({ success: true, translation: translated });
    } catch (err: any) {
      fastify.log.error(err, '[TranslateStep] Failed');
      return reply.status(500).send({ error: err.message || 'Translation failed' });
    }
  });
};
