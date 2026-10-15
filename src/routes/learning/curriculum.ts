import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import prisma from '../../lib/prisma';
import {
  claimPackBuild,
  claimQuizBuild,
  enqueueJob,
  runPackBuild,
} from '../../services/learning/packPipeline';
import { runQuizBuild } from '../../services/learning/quiz';
import { activeBuildProgress } from '../../services/learning/packBuilder';
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
  // 1. POST /api/steps/:stepId/level-up-resources, build-pack, prefetch-pack
  const handlePackBuildRequest = async (req: any, reply: any) => {
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

      if (step.packStatus === 'FAILED') {
        await prisma.skillStep.update({
          where: { id: step.id },
          data: { packStatus: 'NOT_BUILT', packError: null },
        });
      }

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
  };

  fastify.post('/api/steps/:stepId/level-up-resources', handlePackBuildRequest);
  fastify.post('/api/steps/:stepId/build-pack', handlePackBuildRequest);
  fastify.post('/api/steps/:stepId/prefetch-pack', handlePackBuildRequest);

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
      const currentProgress = activeBuildProgress.get(step.id) || null;
      return reply.send({
        locked: step.status === 'LOCKED',
        packStatus: step.packStatus,
        packStage: step.packStage,
        packError: step.packError,
        quizStatus: step.quizStatus,
        quizError: step.quizError,
        buildProgress: currentProgress,
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

      // Auto-heal stuck, failed or empty packs
      if (step.packStatus === 'FAILED' || (step.packStatus === 'READY' && (!step.stepChapters || step.stepChapters.length === 0))) {
        try {
          await runPackBuild(step.id);
          const healed = await prisma.skillStep.findUnique({
            where: { id: step.id },
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
          if (healed) step = healed;
        } catch (healErr) {
          fastify.log.warn({ err: healErr, stepId: step.id }, '[GetStepPack] Auto-heal build notice');
        }
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

      const allVideos = (step.stepResources || [])
        .filter((r) => (r.type === 'youtube' || r.type === 'video') && (r.videoId || r.url))
        .map((r) => ({
          id: r.id,
          title: r.title,
          videoId: r.videoId || extractYouTubeId(r.url) || '',
          videoType: r.videoType || 'tutorial',
          channelName: r.channelName || 'Academy',
          embeddable: r.embeddable ?? true,
          chapterId: r.chapterId,
          url: r.url || `https://www.youtube.com/watch?v=${r.videoId}`,
        }));

      const chapters = (step.stepChapters || []).map((ch, chIdx) => {
        const transCh = translatedChapters?.[chIdx];
        const chapterVideos = allVideos.filter((v) => v.chapterId === ch.id);
        const chVideo = chapterVideos[0] || (allVideos.length > 0 ? allVideos[chIdx % allVideos.length] : null);

        return {
          id: ch.id,
          order: ch.order,
          position: ch.order,
          title: transCh?.title || ch.title,
          summary: transCh?.summary || ch.summary || '',
          overview: transCh?.summary || ch.summary || '',
          video: chVideo,
          videos: chapterVideos.length > 0 ? chapterVideos : (chVideo ? [chVideo] : []),
          lectures: chapterVideos.length > 0 ? chapterVideos : (chVideo ? [chVideo] : []),
          resources: chapterVideos.length > 0 ? chapterVideos : (chVideo ? [chVideo] : []),
          topics: (ch.topics || []).map((t, tIdx) => {
            const transTopic = transCh?.topics?.[tIdx];
            const topicDocs = (t.resources || [])
              .filter((r) => r.type === 'doc' || r.type === 'DOC')
              .map((r) => ({
                id: r.id,
                url: r.url,
                title: r.title,
                domain: r.domain,
                linkStatus: r.linkStatus || 'VERIFIED',
                snippet: r.snippet || '',
              }));

            const primaryDoc = topicDocs[0] || (t.resources && t.resources[0] ? {
              id: t.resources[0].id,
              url: t.resources[0].url,
              title: t.resources[0].title,
              domain: t.resources[0].domain,
              linkStatus: t.resources[0].linkStatus || 'VERIFIED',
              snippet: t.resources[0].snippet || '',
            } : null);

            return {
              id: t.id,
              key: t.key,
              order: t.order,
              position: t.order,
              title: transTopic?.title || t.title,
              covers: transTopic?.covers || t.covers || '',
              minutes: t.minutes || 15,
              acuIds: t.acuIds || [],
              guide: transTopic?.guide || t.guide || {},
              howToApproach: (t.guide as any)?.howToApproach || (t as any).summary || t.covers || '',
              status: primaryDoc ? ('READY' as const) : ('NO_VERIFIED_LINK' as const),
              resource: primaryDoc,
              doc: primaryDoc,
              resources: topicDocs,
              documents: topicDocs,
              links: topicDocs,
            };
          }),
        };
      });

      const currentProgress = activeBuildProgress.get(step.id) || null;
      return reply.send({
        id: step.id,
        stepIndex: step.stepIndex,
        title: step.title,
        difficultyTier: step.difficultyTier,
        packStatus: step.packStatus,
        packStage: step.packStage,
        buildProgress: currentProgress,
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

      const [history, existingResources] = await Promise.all([
        prisma.resourceHistory.findMany({
          where: { workspaceId: res.step.workspaceId },
        }),
        prisma.resource.findMany({
          where: { step: { workspaceId: res.step.workspaceId } },
          select: { videoId: true, url: true },
        }),
      ]);

      const usedVideoIds = new Set<string>();
      const usedDocUrls = new Set<string>();

      for (const r of existingResources) {
        if (r.videoId) usedVideoIds.add(r.videoId);
        if (r.url) {
          usedDocUrls.add(normalizeUrl(r.url));
          const yt = extractYouTubeId(r.url);
          if (yt) usedVideoIds.add(yt);
        }
      }

      for (const h of history) {
        if (h.identifier) {
          usedDocUrls.add(normalizeUrl(h.identifier));
          if (h.identifier.startsWith('yt:')) {
            usedVideoIds.add(h.identifier.slice(3));
          } else {
            const yt = extractYouTubeId(h.identifier);
            if (yt) usedVideoIds.add(yt);
          }
        }
      }

      const topicTitle = res.topic?.title || res.title;
      const isVideo = res.type === 'youtube';

      let replacement: { url: string; title: string; domain: string; videoId?: string } | null = null;

      if (isVideo) {
        const query = `${res.step.workspace.title} "${topicTitle}" tutorial`;
        const vids = await searchTavily(query, {
          maxResults: 6,
          includeDomains: ['youtube.com', 'youtu.be'],
        });
        for (const v of vids) {
          const ytId = extractYouTubeId(v.url);
          if (!ytId || usedVideoIds.has(ytId)) continue;
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
          if (usedDocUrls.has(norm)) continue;
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
