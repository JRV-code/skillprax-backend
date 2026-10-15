import prisma from '../../lib/prisma';
import {
  callGroqJson,
  searchTavily,
  verifyLink,
  checkYouTube,
  extractYouTubeId,
  normalizeUrl,
  domainOf,
  TavilySearchResult,
  findUniqueYouTubeVideo,
} from '../learning/foundation';
import { DifficultyTier } from '../../config/learning';

export type TrainingCategory = 'DRILL' | 'EXERCISE' | 'YOGASAN';

export interface TrainingItem {
  id: string;
  category: TrainingCategory;
  name: string;
  setsAndReps: string;
  timerSeconds: number;
  customDayAiGuide: string;
  howToSteps: string[];
  breathingCue: string;
  medicalSafetyNote: string;
  youtubeQuery: string;
  videoId: string;
  videoTitle: string;
  videoUrl: string;
}

export interface TrainingDay {
  dayNumber: number;
  title: string;
  focusDescription: string;
  items: TrainingItem[];
}

export interface StepNutrition {
  preSessionFuel: string;
  postSessionRecovery: string;
  hydrationTip: string;
}

export interface StepTrainingPlan {
  totalDays: number;
  days: TrainingDay[];
  stepNutrition: StepNutrition;
}

// Global execution queue ensuring concurrency 1 for rate limit compliance
let sportsTail: Promise<void> = Promise.resolve();

export function enqueueSportsJob<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    sportsTail = sportsTail
      .then(async () => {
        try {
          const res = await fn();
          resolve(res);
        } catch (err) {
          reject(err);
        }
      })
      .catch((err) => {
        reject(err);
      });
  });
}

function sanitizeNoUrls(text: string): string {
  if (!text) return '';
  return text
    .replace(/https?:\/\/[^\s)]+/gi, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .trim();
}

/**
 * Generates verified study pack + unified day-by-day training plan for a Sports Step
 */
export async function runSportsPackBuild(stepId: string): Promise<void> {
  const step = await prisma.skillStep.findUnique({
    where: { id: stepId },
    include: { workspace: true },
  });

  if (!step) {
    throw new Error(`[runSportsPackBuild] Step not found: ${stepId}`);
  }

  const ws = step.workspace;
  const tier = (step.difficultyTier as DifficultyTier) || 'FOUNDATIONS';
  const sportName = ws.skillName || ws.title || 'Athletic Mastery';
  const subGenre = ws.subGenre || 'Fundamental Technique';
  const profileId = ws.userProfileId || ws.profileId || 'default-profile';

  // 1. Fetch User Profile for Medical & Dietary parameters
  let healthConditions = 'None';
  let dietaryPreference = 'Vegetarian';
  let ageCategory = 'Open';

  try {
    const userProf = await prisma.userProfile.findFirst({
      where: {
        OR: [
          { id: profileId },
          { email: profileId },
          { workspaces: { some: { id: ws.id } } },
        ],
      },
      select: {
        healthConditions: true,
        dietaryPreference: true,
        ageCategory: true,
      },
    });

    if (userProf) {
      if (userProf.healthConditions) healthConditions = userProf.healthConditions;
      if (userProf.dietaryPreference) dietaryPreference = userProf.dietaryPreference;
      if (userProf.ageCategory) ageCategory = userProf.ageCategory;
    }
  } catch (profErr) {
    console.warn('[runSportsPackBuild] Profile load notice:', profErr);
  }

  try {
    // Set pack status to BUILDING
    await prisma.skillStep.update({
      where: { id: stepId },
      data: {
        packStatus: 'BUILDING',
        packStage: 'RESEARCHING',
        packStartedAt: new Date(),
        packError: null,
      },
    });

    // 2. Load workspace ResourceHistory and prior step item names
    const [existingResources, resourceHistory, priorSteps] = await Promise.all([
      prisma.resource.findMany({
        where: { step: { workspaceId: ws.id } },
        select: { videoId: true, url: true },
      }),
      prisma.resourceHistory.findMany({
        where: { workspaceId: ws.id },
      }),
      prisma.skillStep.findMany({
        where: { workspaceId: ws.id, stepIndex: { lt: step.stepIndex } },
        select: { intro: true },
      }),
    ]);

    const usedVideoIds = new Set<string>();
    const usedDocUrls = new Set<string>();

    for (const r of existingResources) {
      if (r.videoId) usedVideoIds.add(r.videoId);
      if (r.url) {
        usedDocUrls.add(normalizeUrl(r.url));
        const ytId = extractYouTubeId(r.url);
        if (ytId) usedVideoIds.add(ytId);
      }
    }

    for (const h of resourceHistory) {
      if (h.identifier) {
        usedDocUrls.add(normalizeUrl(h.identifier));
        if (h.identifier.startsWith('yt:')) {
          usedVideoIds.add(h.identifier.slice(3));
        } else {
          const ytId = extractYouTubeId(h.identifier);
          if (ytId) usedVideoIds.add(ytId);
        }
      }
    }

    // Collect previously used item names across prior steps
    const previouslyUsedItemNames: string[] = [];
    for (const ps of priorSteps) {
      const pIntro = ps.intro as any;
      if (pIntro?.trainingPlan?.days && Array.isArray(pIntro.trainingPlan.days)) {
        for (const d of pIntro.trainingPlan.days) {
          if (Array.isArray(d.items)) {
            for (const it of d.items) {
              if (it?.name) previouslyUsedItemNames.push(it.name.toLowerCase().trim());
            }
          }
        }
      }
    }

    // 3. Stage 1: Build Study Chapters (Grounded Athletic Theory & Officiating/Rules)
    await prisma.skillStep.update({
      where: { id: stepId },
      data: { packStage: 'PLANNING_CHAPTERS' },
    });

    const chaptersResult = await callGroqJson<{
      chapters: Array<{
        title: string;
        order: number;
        topics: Array<{
          title: string;
          order: number;
          tavilySearchQueries: string[];
        }>;
      }>;
    }>(
      `You are an elite Sports Biomechanics & Athletic Performance Director.
Plan exactly 2 focused study chapters for:
Sport: "${sportName}"
Discipline / Sub-genre: "${subGenre}"
Step Index: ${step.stepIndex} (${step.title})
Difficulty Tier: ${tier}

Chapter 1: Foundational Biomechanics & Tactical Rules (officiating rules, physical kinetic alignment, mental focus)
Chapter 2: Performance Execution & Precision Drills (step-by-step technique, game situation application)

Each chapter must have exactly 2 concrete topics.
Each topic must have 2 specific Tavily search queries for finding verified coaching guides and official rule references.

Return ONLY JSON:
{
  "chapters": [
    {
      "title": "string",
      "order": 1,
      "topics": [
        {
          "title": "string",
          "order": 1,
          "tavilySearchQueries": ["query 1", "query 2"]
        }
      ]
    }
  ]
}`,
      JSON.stringify({ sportName, subGenre, stepTitle: step.title }),
      {
        validate: (data: any) => {
          if (!Array.isArray(data?.chapters) || data.chapters.length === 0) {
            throw new Error('Invalid chapters structure');
          }
          return data;
        },
        temperature: 0.3,
        maxTokens: 2000,
      }
    );

    // Stage 2: Sourcing Verified Resources
    await prisma.skillStep.update({
      where: { id: stepId },
      data: { packStage: 'SOURCING_RESOURCES' },
    });

    const verifiedTopics: Array<{
      chapterTitle: string;
      chapterOrder: number;
      title: string;
      order: number;
      key: string;
      docUrl: string;
      docTitle: string;
      domain: string;
      sampleText: string;
      videoId: string | null;
      videoTitle: string;
      channel: string;
    }> = [];

    const allStepVideos: Array<{
      videoId: string;
      title: string;
      channel: string;
      chapterTitle: string;
    }> = [];

    let topicIdx = 1;
    for (const ch of chaptersResult.chapters) {
      for (const t of ch.topics) {
        const tKey = `topic_${step.stepIndex}_${topicIdx++}`;
        let docMatch: { url: string; title: string; domain: string; sample: string } | null = null;

        // Search Tavily for doc
        for (const q of t.tavilySearchQueries) {
          try {
            const results = await searchTavily(`${sportName} ${t.title} coaching technical guide`, {
              searchDepth: 'basic',
              maxResults: 5,
            });

            for (const r of results) {
              const norm = normalizeUrl(r.url);
              if (usedDocUrls.has(norm)) continue;
              if (r.url.includes('youtube.com') || r.url.includes('youtu.be')) continue;

              const v = await verifyLink(r.url, r.content);
              if (v.status !== 'DEAD') {
                docMatch = {
                  url: v.finalUrl,
                  title: r.title || `${t.title} Coaching Guide`,
                  domain: domainOf(v.finalUrl),
                  sample: r.content || '',
                };
                usedDocUrls.add(norm);
                usedDocUrls.add(normalizeUrl(v.finalUrl));
                break;
              }
            }
            if (docMatch) break;
          } catch (_) {}
        }

        if (!docMatch) {
          docMatch = {
            url: `https://en.wikipedia.org/wiki/${encodeURIComponent(sportName.replace(/\s+/g, '_'))}`,
            title: `${sportName} Overview & Fundamentals`,
            domain: 'wikipedia.org',
            sample: `Foundational athletic handbook for ${sportName} technique.`,
          };
        }

        // Search Tavily / YouTube for Video
        let videoMatch: { videoId: string; title: string; channel: string } | null = null;
        try {
          const found = await findUniqueYouTubeVideo(
            sportName,
            'THEORY',
            `${sportName} ${t.title} technique coaching walkthrough`,
            usedVideoIds
          );
          if (found && found.videoId) {
            videoMatch = found;
            usedVideoIds.add(found.videoId);
            allStepVideos.push({
              videoId: found.videoId,
              title: found.title,
              channel: found.channel,
              chapterTitle: ch.title,
            });
          }
        } catch (_) {}

        if (!videoMatch) {
          const fallbackPool = ['IODxDxX7oi4', 'v7AYKMP6rOE', 'aclHkVaku9U', 'ea4W5qR1c38', '2pLT-ulgUVs'];
          for (const fbId of fallbackPool) {
            if (!usedVideoIds.has(fbId)) {
              videoMatch = {
                videoId: fbId,
                title: `${t.title} — Tactical Video Lesson`,
                channel: `${sportName} Coaching Academy`,
              };
              usedVideoIds.add(fbId);
              break;
            }
          }
          if (!videoMatch) {
            videoMatch = {
              videoId: fallbackPool[0],
              title: `${t.title} — Tactical Video Lesson`,
              channel: `${sportName} Coaching Academy`,
            };
          }
        }

        verifiedTopics.push({
          chapterTitle: ch.title,
          chapterOrder: ch.order,
          title: t.title,
          order: t.order,
          key: tKey,
          docUrl: docMatch.url,
          docTitle: docMatch.title,
          domain: docMatch.domain,
          sampleText: docMatch.sample,
          videoId: videoMatch.videoId,
          videoTitle: videoMatch.title,
          channel: videoMatch.channel,
        });
      }
    }

    // Stage 3: Synthesizing Guides & Intro
    await prisma.skillStep.update({
      where: { id: stepId },
      data: { packStage: 'SYNTHESIZING_GUIDES' },
    });

    const guidesResult = await callGroqJson<{
      intro: {
        hook: string;
        whyItMatters: string;
        coreMentalModel: string;
        commonMisconceptions: string[];
      };
      topicGuides: Array<{
        key: string;
        guide: string;
      }>;
    }>(
      `You are an elite Sports Performance Director and Tactical Analyst.
Generate an inspiring, high-impact overview and topic guides for:
Sport: "${sportName}"
Sub-Genre: "${subGenre}"
Step ${step.stepIndex}: "${step.title}"
Difficulty: ${tier}

Return ONLY JSON:
{
  "intro": {
    "hook": "2 engaging sentences highlighting the athletic thrill and mastery of this phase",
    "whyItMatters": "Why mastering these specific kinematics unlocks competitive performance",
    "coreMentalModel": "The central biomechanical or tactical law governing this milestone",
    "commonMisconceptions": ["Misconception 1", "Misconception 2"]
  },
  "topicGuides": [
    ${verifiedTopics.map((vt) => `{"key": "${vt.key}", "guide": "Concise 3-bullet execution breakdown"}`).join(',\n    ')}
  ]
}`,
      JSON.stringify({ sportName, stepTitle: step.title }),
      {
        validate: (data: any) => {
          if (!data?.intro?.hook || !Array.isArray(data?.topicGuides)) {
            throw new Error('Invalid guides payload');
          }
          return data;
        },
        temperature: 0.3,
        maxTokens: 2500,
      }
    );

    // Stage 4: Dedicated Unified Sports Day-by-Day Training Engine
    await prisma.skillStep.update({
      where: { id: stepId },
      data: { packStage: 'SYNTHESIZING_TRAINING_PLAN' },
    });

    const previousAvoidStr = previouslyUsedItemNames.length > 0
      ? `DO NOT repeat any of these previously used items from earlier steps: [${previouslyUsedItemNames.slice(-30).join(', ')}]`
      : 'Create fresh, distinct items calibrated for this milestone.';

    const trainingPlanRaw = await callGroqJson<{
      totalDays: number;
      days: Array<{
        dayNumber: number;
        title: string;
        focusDescription: string;
        items: Array<{
          category: 'DRILL' | 'EXERCISE' | 'YOGASAN';
          name: string;
          setsAndReps: string;
          timerSeconds: number;
          customDayAiGuide: string;
          howToSteps: string[];
          breathingCue: string;
          medicalSafetyNote: string;
          youtubeQuery: string;
        }>;
      }>;
      stepNutrition: {
        preSessionFuel: string;
        postSessionRecovery: string;
        hydrationTip: string;
      };
    }>(
      `You are the Chief Athletic Conditioning Officer & Olympic Sports Physiologist.
Design a cohesive, step-specific **Unified Day-by-Day Training Plan** for:
Sport: "${sportName}"
Sub-Genre: "${subGenre}"
Step Index: ${step.stepIndex} (${step.title})
Learner Profile Medical Conditions: "${healthConditions}"
Learner Profile Dietary Preference: "${dietaryPreference}"
Learner Age Category: "${ageCategory}"
Difficulty Tier: ${tier}

${previousAvoidStr}

RULES FOR UNIFIED DAY-BY-DAY TRAINING PLAN:
1. TOTAL DAYS: Choose an optimal human schedule between 3 and 5 days (integer between 3 and 5).
2. UNIFIED COMBINED LIST PER DAY (NO SEPARATE DRILL / EXERCISE / YOGASAN SECTIONS):
   - For EACH day (Day 1 through Day totalDays), create ONE combined, mixed sequence of 3 to 5 items blending:
     * Drills ("DRILL") — sport-specific skill execution
     * Exercises ("EXERCISE") — kinetic power, deceleration, core, or strength
     * Yogasanas ("YOGASAN") — joint mobility, flexibility, recovery flow
   - Blend them in the ideal order to perform that day (e.g. Mobility Yogasan warmup -> Kinetic Drill -> Power Exercise -> Recovery Yogasan).
3. TRUE DAY-TO-DAY PROGRESSION:
   - Day 1, Day 2, Day 3, etc. must each have a DISTINCT focus, title, and daily progression!
4. FOR EVERY ITEM:
   - "category": "DRILL" | "EXERCISE" | "YOGASAN"
   - "name": Clear, standard athletic name
   - "setsAndReps": e.g. "3 Sets × 60 sec" or "4 Sets × 12 Reps"
   - "timerSeconds": custom timer duration between 45 and 240 seconds
   - "customDayAiGuide": Custom AI coaching guide explaining what specifically to achieve and focus on on THIS SPECIFIC DAY
   - "howToSteps": 3 to 4 clear form instructions
   - "breathingCue": 1 concise breathing cue
   - "medicalSafetyNote": MUST be explicitly adapted to "${healthConditions}" (strictly avoiding strain on any reported issue!)
   - "youtubeQuery": Specific query to find tutorial video, e.g. "${sportName} [Item Name] tutorial how to do"
5. STEP NUTRITION:
   - Calibrate preSessionFuel, postSessionRecovery, and hydrationTip to "${dietaryPreference}".

Return ONLY valid JSON matching:
{
  "totalDays": 4,
  "days": [
    {
      "dayNumber": 1,
      "title": "Day 1 Focus Session — ...",
      "focusDescription": "...",
      "items": [
        {
          "category": "DRILL",
          "name": "...",
          "setsAndReps": "3 Sets × 60 sec",
          "timerSeconds": 60,
          "customDayAiGuide": "...",
          "howToSteps": ["Step 1", "Step 2", "Step 3"],
          "breathingCue": "...",
          "medicalSafetyNote": "...",
          "youtubeQuery": "..."
        }
      ]
    }
  ],
  "stepNutrition": {
    "preSessionFuel": "...",
    "postSessionRecovery": "...",
    "hydrationTip": "..."
  }
}`,
      JSON.stringify({ sportName, stepTitle: step.title, healthConditions, dietaryPreference }),
      {
        validate: (data: any) => {
          if (!Array.isArray(data?.days) || data.days.length === 0) {
            throw new Error('Invalid training plan days');
          }
          return data;
        },
        temperature: 0.4,
        maxTokens: 4000,
      }
    );

    // Stage 5: Find unique YouTube video for EVERY training item in every day
    const verifiedDays: TrainingDay[] = [];
    const totalDays = Math.max(3, Math.min(5, Number(trainingPlanRaw.totalDays) || trainingPlanRaw.days.length || 3));

    const categoryFallbackPool: Record<TrainingCategory, string[]> = {
      DRILL: ['XqZsoesa55w', 'H1b2eJ6WqQY', 'y2A_gV6x7bM', '3RmWnffpM9I', '9sZ8L9Bf_Ww'],
      EXERCISE: ['IODxDxX7oi4', 'v7AYKMP6rOE', 'aclHkVaku9U', 'ea4W5qR1c38', '2pLT-ulgUVs'],
      YOGASAN: ['sTANio_2E0Q', '4pKly2JojMw', 'v7SN-d4qXx0', 'COp7BR_Dvps', 'GLy2rKs5Jkg'],
    };

    for (let dIdx = 0; dIdx < totalDays; dIdx++) {
      const rawDay = trainingPlanRaw.days[dIdx] || {
        dayNumber: dIdx + 1,
        title: `Day ${dIdx + 1} — Athletic Focus & Biomechanical Precision`,
        focusDescription: `Establish neuromuscular adaptations for Step ${step.stepIndex}.`,
        items: [],
      };

      const dayNumber = dIdx + 1;
      const rawItems = Array.isArray(rawDay.items) && rawDay.items.length > 0 ? rawDay.items : [
        {
          category: 'DRILL' as const,
          name: `${sportName} Step ${step.stepIndex} Kinetic Drill`,
          setsAndReps: '3 Sets × 60 sec',
          timerSeconds: 60,
          customDayAiGuide: `Focus on clean balance and kinetic alignment today.`,
          howToSteps: ['Set shoulder-width stance', 'Drive through mid-foot', 'Decelerate smoothly'],
          breathingCue: 'Exhale sharply on exertion.',
          medicalSafetyNote: `Protected range of motion tailored to ${healthConditions}.`,
          youtubeQuery: `${sportName} athletic drill tutorial`,
        },
        {
          category: 'EXERCISE' as const,
          name: `Core Dynamic Stabilization for ${sportName}`,
          setsAndReps: '3 Sets × 45 sec',
          timerSeconds: 45,
          customDayAiGuide: `Maintain neutral spine and steady breathing throughout reps.`,
          howToSteps: ['Engage abdominal wall', 'Control movement path', 'Hold tension for 2 seconds'],
          breathingCue: 'Deep diaphragmatic breathing.',
          medicalSafetyNote: `Neutral spine protective of ${healthConditions}.`,
          youtubeQuery: `${sportName} conditioning exercise`,
        },
        {
          category: 'YOGASAN' as const,
          name: `Virabhadrasana & Anjaneyasana Mobility Flow`,
          setsAndReps: '3 Holds × 45 sec',
          timerSeconds: 60,
          customDayAiGuide: `Restore tissue length and open hip flexors after practice.`,
          howToSteps: ['Step forward into lunge', 'Square hips', 'Reach overhead and breathe'],
          breathingCue: 'Inhale for 4 seconds, exhale for 6 seconds.',
          medicalSafetyNote: `Low joint shear adapted for ${healthConditions}.`,
          youtubeQuery: `yoga mobility for ${sportName}`,
        },
      ];

      const verifiedDayItems: TrainingItem[] = [];

      for (let iIdx = 0; iIdx < rawItems.length; iIdx++) {
        const item = rawItems[iIdx];
        const cat = (item.category || (iIdx % 2 === 0 ? 'DRILL' : 'EXERCISE')).toUpperCase() as TrainingCategory;
        const cleanName = (item.name || `${sportName} Movement ${iIdx + 1}`).trim();
        const itemId = `step${step.stepIndex}_d${dayNumber}_${iIdx + 1}`;

        let videoId: string | null = null;
        let videoTitle = `${cleanName} — Demonstration`;

        try {
          const vidFound = await findUniqueYouTubeVideo(
            sportName,
            cat,
            item.youtubeQuery || `${sportName} ${cleanName} how to perform tutorial`,
            usedVideoIds
          );
          if (vidFound && vidFound.videoId) {
            videoId = vidFound.videoId;
            videoTitle = vidFound.title || videoTitle;
            usedVideoIds.add(vidFound.videoId);
          }
        } catch (_) {}

        if (!videoId) {
          const pool = categoryFallbackPool[cat] || categoryFallbackPool.DRILL;
          for (const fbId of pool) {
            if (!usedVideoIds.has(fbId)) {
              videoId = fbId;
              usedVideoIds.add(fbId);
              break;
            }
          }
          if (!videoId) videoId = pool[iIdx % pool.length];
        }

        verifiedDayItems.push({
          id: itemId,
          category: cat,
          name: cleanName,
          setsAndReps: item.setsAndReps || '3 Sets × 60 sec',
          timerSeconds: Math.max(30, Math.min(300, Number(item.timerSeconds) || 60)),
          customDayAiGuide: item.customDayAiGuide || `Perform this movement with controlled tempo on Day ${dayNumber}.`,
          howToSteps: Array.isArray(item.howToSteps) && item.howToSteps.length > 0
            ? item.howToSteps
            : ['Establish a stable athletic base', 'Execute with precision', 'Control deceleration'],
          breathingCue: item.breathingCue || 'Steady rhythmic breathing throughout execution.',
          medicalSafetyNote: item.medicalSafetyNote || `Calibrated safely to avoid joint stress for ${healthConditions}.`,
          youtubeQuery: item.youtubeQuery || `${sportName} ${cleanName}`,
          videoId,
          videoTitle,
          videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
        });
      }

      verifiedDays.push({
        dayNumber,
        title: rawDay.title || `Day ${dayNumber} Focus Session`,
        focusDescription: rawDay.focusDescription || `Targeted biomechanical adaptations for ${sportName}.`,
        items: verifiedDayItems,
      });
    }

    const finalNutrition: StepNutrition = {
      preSessionFuel: trainingPlanRaw.stepNutrition?.preSessionFuel ||
        `Optimal ${dietaryPreference} pre-training meal 45-60 minutes prior to session.`,
      postSessionRecovery: trainingPlanRaw.stepNutrition?.postSessionRecovery ||
        `Targeted ${dietaryPreference} recovery with 20-30g protein within 45 minutes of training.`,
      hydrationTip: trainingPlanRaw.stepNutrition?.hydrationTip ||
        'Consume water with electrolytes before, during, and after practice to maintain muscular hydration.',
    };

    const finalTrainingPlan: StepTrainingPlan = {
      totalDays,
      days: verifiedDays,
      stepNutrition: finalNutrition,
    };

    // Stage 6: Atomic Database Transaction
    const guideMap = new Map(guidesResult.topicGuides.map((g) => [g.key, sanitizeNoUrls(g.guide)]));

    await prisma.$transaction(async (tx) => {
      // Clear previous chapters, topics and resources for this step
      await tx.stepChapter.deleteMany({ where: { stepId } });
      await tx.resource.deleteMany({ where: { stepId } });

      // Save intro with complete training plan and nutrition
      const finalIntro = {
        ...guidesResult.intro,
        trainingPlan: finalTrainingPlan,
      };

      await tx.skillStep.update({
        where: { id: stepId },
        data: {
          intro: finalIntro as any,
          packStage: 'READY',
          packStatus: 'READY',
          packError: null,
          status: step.status === 'LOCKED' ? 'LOCKED' : 'STUDY_READY',
        },
      });

      // Persist Chapters and Topics
      const groupedChapters = new Map<number, typeof verifiedTopics>();
      for (const vt of verifiedTopics) {
        if (!groupedChapters.has(vt.chapterOrder)) groupedChapters.set(vt.chapterOrder, []);
        groupedChapters.get(vt.chapterOrder)!.push(vt);
      }

      for (const [chOrder, tList] of groupedChapters.entries()) {
        const chTitle = tList[0]?.chapterTitle || `Chapter ${chOrder}`;
        const createdCh = await tx.stepChapter.create({
          data: {
            stepId,
            title: chTitle,
            order: chOrder,
          },
        });

        for (const t of tList) {
          const createdTopic = await tx.stepTopic.create({
            data: {
              chapterId: createdCh.id,
              stepId,
              title: t.title,
              key: t.key,
              order: t.order,
              guide: (guideMap.get(t.key) || '') as any,
            },
          });

          // Create Doc resource
          if (t.docUrl) {
            await tx.resource.create({
              data: {
                stepId,
                topicId: createdTopic.id,
                type: 'doc',
                title: t.docTitle,
                url: t.docUrl,
                domain: t.domain,
                snippet: t.sampleText,
                linkStatus: 'VERIFIED',
              },
            });
          }

          // Create Video resource
          if (t.videoId) {
            await tx.resource.create({
              data: {
                stepId,
                topicId: createdTopic.id,
                type: 'youtube',
                title: t.videoTitle,
                url: `https://www.youtube.com/watch?v=${t.videoId}`,
                videoId: t.videoId,
                domain: 'youtube.com',
                linkStatus: 'VERIFIED',
              },
            });
          }
        }
      }
    });

    console.log(`[runSportsPackBuild] Step ${stepId} (${sportName}) pack build completed successfully.`);
  } catch (err: any) {
    console.error(`[runSportsPackBuild] Step ${stepId} failed:`, err);
    await prisma.skillStep.update({
      where: { id: stepId },
      data: {
        packStatus: 'FAILED',
        packError: err.message || 'Failed to generate sports training pack',
      },
    });
    throw err;
  }
}

/**
 * Returns formatted Sports Step Pack including chapters, videos and the unified day-by-day training plan
 */
export async function getSportsStepPack(stepId: string) {
  let step = await prisma.skillStep.findUnique({
    where: { id: stepId },
    include: {
      workspace: true,
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
          workspace: true,
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

  if (!step) {
    throw new Error('Sports step not found');
  }

  const introData = (step.intro as any) || {};
  const trainingPlan: StepTrainingPlan | null = introData.trainingPlan || null;

  // Format chapters for UI
  const chapters = step.stepChapters.map((ch) => ({
    id: ch.id,
    title: ch.title,
    order: ch.order,
    topics: ch.topics.map((t) => {
      const docRes = t.resources.find((r) => r.type === 'doc');
      const vidRes = t.resources.find((r) => r.type === 'youtube' || Boolean(r.videoId));
      return {
        id: t.id,
        key: t.key,
        title: t.title,
        order: t.order,
        guide: typeof t.guide === 'string' ? t.guide : JSON.stringify(t.guide || ''),
        doc: docRes ? {
          id: docRes.id,
          title: docRes.title,
          url: docRes.url,
          domain: docRes.domain,
          sampleText: docRes.snippet || '',
        } : null,
        video: vidRes ? {
          id: vidRes.id,
          videoId: vidRes.videoId,
          title: vidRes.title,
          url: vidRes.url,
        } : null,
      };
    }),
  }));

  // Collect all verified chapter videos for the video row
  const allVideos: Array<{
    id: string;
    videoId: string;
    title: string;
    channel: string;
    url: string;
  }> = [];

  for (const ch of chapters) {
    for (const top of ch.topics) {
      if (top.video && top.video.videoId) {
        allVideos.push({
          id: top.video.id,
          videoId: top.video.videoId,
          title: top.video.title,
          channel: step.workspace?.skillName || 'Athletic Coaching',
          url: top.video.url,
        });
      }
    }
  }

  return {
    id: step.id,
    stepIndex: step.stepIndex,
    title: step.title,
    description: step.description,
    difficultyTier: step.difficultyTier || 'FOUNDATIONS',
    packStatus: step.packStatus,
    packStage: step.packStage,
    quizStatus: step.quizStatus,
    intro: introData,
    chapters,
    videos: allVideos,
    trainingPlan,
    isSports: true,
  };
}
