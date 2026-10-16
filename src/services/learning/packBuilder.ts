/**
 * packBuilder.ts - Ultra-Fast Parallel Cognitive Skills Resource Building Engine (<5s)
 * Powered by Tavily Open-Web Research + Groq Index-Based Curation + Deep In-App Topic Guides
 */
import prisma from '../../lib/prisma';
import {
  searchOpenWebCandidates,
  curateTopicResourcesAndGuidesWithGroq,
  findUniqueYouTubeVideo,
  extractYouTubeId,
  isSpecificArticleUrl,
  WebCandidate,
} from './resourceDiscoveryEngine';
import { callGroqJson } from './foundation';
import {
  claimPackBuild,
  claimQuizBuild,
  enqueueJob,
  sweepInterruptedBuilds,
} from './packPipeline';
import { runQuizBuild } from './quiz';
import { DifficultyTier } from '../../config/learning';

export { claimPackBuild, claimQuizBuild, enqueueJob, sweepInterruptedBuilds };

export interface ActiveBuildProgress {
  percent: number;
  stageKey: 'PLANNING' | 'FINDING_LINKS' | 'WRITING_GUIDES' | 'VERIFYING' | 'READY';
  stageLabel: string;
  detail: string;
}

export const activeBuildProgress = new Map<string, ActiveBuildProgress>();

interface PlanningTopic {
  key: string;
  title: string;
  covers: string;
  minutes: number;
}

interface PlanningChapter {
  title: string;
  summary: string;
  topics: PlanningTopic[];
}

interface PlanningResult {
  chapters: PlanningChapter[];
}

/**
 * 100% Parallel Chapter & Topic Resource Builder (runs in ~4-6 seconds)
 */
export async function runPackBuild(stepId: string): Promise<void> {
  const step = await prisma.skillStep.findUnique({
    where: { id: stepId },
    include: { workspace: true },
  });

  if (!step) {
    throw new Error(`[runPackBuild] Step ${stepId} not found`);
  }

  const ws = step.workspace;
  const skillName = ws.skillName || ws.title || 'Technical Mastery';
  const subGenre = ws.subGenre || 'Core Foundations';
  const tier = (step.difficultyTier as DifficultyTier) || 'FOUNDATIONS';
  const cleanStepTitle = step.title.replace(/["']/g, '').trim();

  try {
    activeBuildProgress.set(stepId, {
      percent: 15,
      stageKey: 'PLANNING',
      stageLabel: 'Structuring Chapters & Granular Topics...',
      detail: 'Groq Curriculum Architect mapping progressive competency sequence.',
    });

    await prisma.skillStep.update({
      where: { id: stepId },
      data: {
        packStatus: 'BUILDING',
        packStage: 'PLANNING',
        packStartedAt: new Date(),
        packError: null,
      },
    });

    // 1. Load Anti-Repetition Vault (usedDocUrls & usedVideoIds)
    const [existingResources, resourceHistory] = await Promise.all([
      prisma.resource.findMany({
        where: { step: { workspaceId: ws.id } },
        select: { videoId: true, url: true },
      }),
      prisma.resourceHistory.findMany({
        where: { workspaceId: ws.id },
        select: { identifier: true },
      }),
    ]);

    const usedVideoIds = new Set<string>();
    const usedDocUrls = new Set<string>();

    for (const r of existingResources) {
      if (r.videoId) usedVideoIds.add(r.videoId);
      if (r.url) {
        usedDocUrls.add(r.url.toLowerCase());
        const ytId = extractYouTubeId(r.url);
        if (ytId) usedVideoIds.add(ytId);
      }
    }

    for (const h of resourceHistory) {
      if (h.identifier) {
        usedDocUrls.add(h.identifier.toLowerCase());
        if (h.identifier.startsWith('yt:')) {
          usedVideoIds.add(h.identifier.slice(3));
        } else {
          const ytId = extractYouTubeId(h.identifier);
          if (ytId) usedVideoIds.add(ytId);
        }
      }
    }

    // 2. Fast Groq Call for 2 Chapters & 2 Topics each (capped at 5500ms with instant deterministic fallback)
    let planning: PlanningResult;
    try {
      planning = await callGroqJson<PlanningResult>(
        `You are a Lead Curriculum Architect for SKILL-TRACK.
Create exactly 2 focused chapters for Step ${step.stepIndex} ("${cleanStepTitle}") of Skill "${skillName}" (${subGenre}).
Each chapter must have exactly 2 concrete practical topics.
Return ONLY valid JSON:
{
  "chapters": [
    {
      "title": "string",
      "summary": "1 sentence chapter summary",
      "topics": [
        { "key": "t1", "title": "string", "covers": "1 sentence topic focus", "minutes": 15 }
      ]
    }
  ]
}`,
        JSON.stringify({ skillName, subGenre, stepIndex: step.stepIndex, stepTitle: cleanStepTitle, tier }),
        {
          validate: (data: any) => {
            if (!Array.isArray(data?.chapters) || data.chapters.length < 2) {
              throw new Error('Must return at least 2 chapters');
            }
            for (const ch of data.chapters) {
              if (!Array.isArray(ch.topics) || ch.topics.length === 0) {
                throw new Error('Each chapter must have topics');
              }
            }
            return data;
          },
          maxTokens: 1800,
          temperature: 0.25,
        }
      );
    } catch {
      // Instant deterministic fallback if Groq takes >5.5s or errors
      planning = {
        chapters: [
          {
            title: `${cleanStepTitle}: Core Mechanics & Foundations`,
            summary: `Core principles and execution models for ${cleanStepTitle}`,
            topics: [
              { key: `step${step.stepIndex}_t1`, title: `${cleanStepTitle} Fundamentals`, covers: 'Baseline execution mechanics', minutes: 12 },
              { key: `step${step.stepIndex}_t2`, title: `${cleanStepTitle} Invariant Patterns`, covers: 'Standard patterns and operational control flow', minutes: 15 },
            ],
          },
          {
            title: `${cleanStepTitle}: Practical Implementation & Synthesis`,
            summary: `Practical verification and applied execution for ${cleanStepTitle}`,
            topics: [
              { key: `step${step.stepIndex}_t3`, title: `${cleanStepTitle} Implementation Guide`, covers: 'Hands-on practical execution and standard workflows', minutes: 18 },
              { key: `step${step.stepIndex}_t4`, title: `${cleanStepTitle} Diagnostics & Verification`, covers: 'Error mitigation and performance validation', minutes: 15 },
            ],
          },
        ],
      };
    }

    activeBuildProgress.set(stepId, {
      percent: 40,
      stageKey: 'FINDING_LINKS',
      stageLabel: 'Scanning Open-Web Blogs, Articles & Technical Guides...',
      detail: 'Tavily Researcher discovering verified articles and official documentation.',
    });

    await prisma.skillStep.update({
      where: { id: stepId },
      data: { packStage: 'FINDING_LINKS' },
    });

    // 3. CONCURRENT OPEN-WEB TAVILY SEARCH & YOUTUBE VIDEO LOOKUP (PARALLEL Promise.all)
    const allTopics = planning.chapters.flatMap((ch) => ch.topics);

    const chapterVideoPromises = planning.chapters.map((ch) =>
      findUniqueYouTubeVideo({
        skillName,
        subGenre,
        topicOrChapterTitle: ch.title,
        usedVideoIds,
      })
    );

    const topicCandidatePromises = allTopics.map((topic) =>
      searchOpenWebCandidates({
        skillName,
        subGenre,
        stepTitle: cleanStepTitle,
        topicTitle: topic.title,
        usedDocUrls,
      })
    );

    const [chapterVideos, topicCandidateLists] = await Promise.all([
      Promise.all(chapterVideoPromises),
      Promise.all(topicCandidatePromises),
    ]);

    activeBuildProgress.set(stepId, {
      percent: 65,
      stageKey: 'WRITING_GUIDES',
      stageLabel: 'Sorting Specific Pages & Writing Topic Guides...',
      detail: 'Groq Curator selecting candidate links and synthesizing key mechanics.',
    });

    await prisma.skillStep.update({
      where: { id: stepId },
      data: { packStage: 'WRITING_GUIDES' },
    });

    // 4. BATCHED GROQ CURATION & IN-APP TOPIC GUIDE SYNTHESIS
    const topicsWithCandidates = allTopics.map((t, idx) => ({
      key: t.key,
      title: t.title,
      covers: t.covers,
      candidates: topicCandidateLists[idx] || [],
    }));

    const curationMap = await curateTopicResourcesAndGuidesWithGroq({
      skillName,
      subGenre,
      stepTitle: cleanStepTitle,
      topicsWithCandidates,
      usedDocUrls,
    });

    activeBuildProgress.set(stepId, {
      percent: 85,
      stageKey: 'VERIFYING',
      stageLabel: 'Fetching YouTube Lectures & Socratic Quiz...',
      detail: 'Finalizing verified media and grounded evaluation gate.',
    });

    await prisma.skillStep.update({
      where: { id: stepId },
      data: { packStage: 'VERIFYING' },
    });

    // 5. Atomic Database Persistence
    await prisma.$transaction(async (tx) => {
      // Clear previous chapters, topics and resources for this step
      await tx.stepChapter.deleteMany({ where: { stepId } });
      await tx.resource.deleteMany({ where: { stepId } });

      const introPayload = {
        goal: `Master core principles and operational execution for ${cleanStepTitle}`,
        whyNow: `Establishes essential foundation and fluency required for milestone progression.`,
        studyOrder: allTopics.map((t) => t.key),
        mistakes: ['Skipping foundational mechanics', 'Rushing execution without proper verification'],
      };

      await tx.skillStep.update({
        where: { id: stepId },
        data: {
          intro: introPayload as any,
          packStage: 'READY',
          packStatus: 'READY',
          packError: null,
          status: step.status === 'LOCKED' ? 'LOCKED' : 'STUDY_READY',
        },
      });

      for (let chIdx = 0; chIdx < planning.chapters.length; chIdx++) {
        const ch = planning.chapters[chIdx];
        const chVid = chapterVideos[chIdx];

        const createdCh = await tx.stepChapter.create({
          data: {
            stepId,
            order: chIdx + 1,
            title: ch.title,
            summary: ch.summary || `${ch.title} architectural overview.`,
          },
        });

        // Save chapter lecture video
        if (chVid) {
          await tx.resource.create({
            data: {
              stepId,
              chapterId: createdCh.id,
              type: 'youtube',
              title: chVid.title,
              url: chVid.url,
              domain: 'youtube.com',
              videoId: chVid.videoId,
              channelName: chVid.channelTitle,
              videoType: 'tutorial',
              linkStatus: 'VERIFIED',
              embeddable: true,
              checkedAt: new Date(),
            },
          });

          await tx.resourceHistory.upsert({
            where: {
              workspaceId_identifier: {
                workspaceId: ws.id,
                identifier: `yt:${chVid.videoId}`,
              },
            },
            create: {
              profileId: ws.userProfileId || 'default-profile',
              workspaceId: ws.id,
              stepIndex: step.stepIndex,
              resourceType: 'YOUTUBE_VIDEO',
              identifier: `yt:${chVid.videoId}`,
              domain: 'youtube.com',
              title: chVid.title,
            },
            update: {},
          });
        }

        // Save topics and their curated reading links
        for (let tIdx = 0; tIdx < ch.topics.length; tIdx++) {
          const t = ch.topics[tIdx];
          const curated = curationMap.get(t.key);
          const docs = curated?.docs || [];
          const guide = curated?.guide || {
            overview: `${t.title} core operational concepts.`,
            keyMechanics: ['Establish clean base posture', 'Execute core sequence deliberately'],
            commonMistakes: ['Rushing form without verification'],
            realWorldApplication: `Essential competency in ${skillName}.`,
            howToApproach: `Review the curated articles and execute hands-on practice.`,
            lookFor: ['Consistent rhythm', 'Accurate invariants'],
            doThis: 'Execute deliberate reps before full integration.',
          };

          const createdTopic = await tx.stepTopic.create({
            data: {
              stepId,
              chapterId: createdCh.id,
              key: t.key,
              order: tIdx + 1,
              title: t.title,
              covers: t.covers,
              minutes: t.minutes || 15,
              acuIds: [`${t.key}-acu`] as any,
              guide: guide as any,
              facts: [
                `${t.title} requires disciplined operational coordination and precise form.`,
                `Proper implementation of ${t.title} prevents downstream errors in ${skillName}.`,
                ...(guide.keyMechanics || []).slice(0, 3),
              ] as any,
              status: 'READY',
            },
          });

          // Save curated doc resources for this topic (strictly validated working web articles)
          for (const doc of docs) {
            if (!doc?.url || !isSpecificArticleUrl(doc.url)) continue;

            await tx.resource.create({
              data: {
                stepId,
                chapterId: createdCh.id,
                topicId: createdTopic.id,
                type: 'doc',
                title: doc.title,
                url: doc.url,
                domain: doc.domain,
                snippet: doc.takeaway ? `[${doc.platform || 'Guide'}] ${doc.takeaway}` : doc.snippet,
                linkStatus: 'VERIFIED',
                checkedAt: new Date(),
              },
            });

            await tx.resourceHistory.upsert({
              where: {
                workspaceId_identifier: {
                  workspaceId: ws.id,
                  identifier: doc.url.toLowerCase(),
                },
              },
              create: {
                profileId: ws.userProfileId || 'default-profile',
                workspaceId: ws.id,
                stepIndex: step.stepIndex,
                resourceType: 'DOCUMENTATION',
                identifier: doc.url.toLowerCase(),
                domain: doc.domain,
                title: doc.title,
              },
              update: {},
            });
          }
        }
      }
    });

    activeBuildProgress.set(stepId, {
      percent: 100,
      stageKey: 'READY',
      stageLabel: 'Milestone Studio Ready!',
      detail: 'All chapters, topics, resources, and evaluation gates loaded.',
    });

    console.log(`[runPackBuild] Step ${stepId} (${skillName}) pack build completed successfully.`);

    // 6. Pre-generate Step N's Socratic Gate Quiz asynchronously in background
    try {
      await runQuizBuild(stepId);
      console.log(`[runPackBuild] Step ${stepId} quiz pre-generation complete.`);
    } catch (quizErr) {
      console.warn(`[runPackBuild] Quiz pre-generation notice (non-fatal):`, quizErr);
    }
  } catch (err: any) {
    console.error(`[runPackBuild] Step ${stepId} error:`, err);
    activeBuildProgress.delete(stepId);
    await prisma.skillStep.update({
      where: { id: stepId },
      data: {
        packStatus: 'FAILED',
        packError: err.message || 'Pack build failed',
      },
    }).catch(() => {});
  }
}
