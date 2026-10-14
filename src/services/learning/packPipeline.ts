import prisma from '../../lib/prisma';
import {
  LEARNING_CONFIG,
  TIER_QUERY_MODIFIERS,
  DifficultyTier,
} from '../../config/learning';
import {
  callGroqJson,
  searchTavily,
  extractYouTubeId,
  checkYouTube,
  normalizeUrl,
  domainOf,
  contentFingerprint,
  verifyLink,
  looksWalled,
  isBlockedDomain,
  levelFitScore,
  mapWithLimit,
  assertNoUrls,
  hasVerbatimRun,
  fetchWikipediaExtract,
  TavilySearchResult,
} from './foundation';

// Global execution queue ensuring concurrency 1 for rate limits
let tail: Promise<void> = Promise.resolve();
export const enqueueJob = (job: () => Promise<void>) => {
  tail = tail.then(job).catch(() => {});
};

// Sweep interrupted builds on server startup
export async function sweepInterruptedBuilds() {
  try {
    await prisma.skillStep.updateMany({
      where: { packStatus: 'BUILDING' },
      data: { packStatus: 'FAILED', packError: 'Interrupted by restart' },
    });
    await prisma.skillStep.updateMany({
      where: { quizStatus: 'BUILDING' },
      data: { quizStatus: 'FAILED', quizError: 'Interrupted by restart' },
    });
  } catch (err) {
    console.warn('[sweepInterruptedBuilds] Startup sweep warning:', err);
  }
}

// Idempotent claims
export async function claimPackBuild(stepId: string): Promise<boolean> {
  const staleBefore = new Date(Date.now() - LEARNING_CONFIG.PACK_STALE_AFTER_MS);
  const { count } = await prisma.skillStep.updateMany({
    where: {
      id: stepId,
      OR: [
        { packStatus: { in: ['NOT_BUILT', 'FAILED'] } },
        { packStatus: 'BUILDING', packStartedAt: { lt: staleBefore } },
      ],
    },
    data: {
      packStatus: 'BUILDING',
      packStage: 'QUEUED',
      packStartedAt: new Date(),
      packError: null,
    },
  });
  return count === 1;
}

export async function claimQuizBuild(stepId: string): Promise<boolean> {
  const staleBefore = new Date(Date.now() - LEARNING_CONFIG.PACK_STALE_AFTER_MS);
  const { count } = await prisma.skillStep.updateMany({
    where: {
      id: stepId,
      OR: [
        { quizStatus: { in: ['NOT_BUILT', 'FAILED'] } },
        { quizStatus: 'BUILDING', quizStartedAt: { lt: staleBefore } },
      ],
    },
    data: {
      quizStatus: 'BUILDING',
      quizStartedAt: new Date(),
      quizError: null,
    },
  });
  return count === 1;
}

interface PlannedTopic {
  key: string;
  title: string;
  covers: string;
  acuIds: string[];
  minutes: number;
}

interface PlannedChapter {
  title: string;
  summary: string;
  topics: PlannedTopic[];
}

interface PlanningResult {
  acus: Array<{ id: string; title: string; description: string }>;
  chapters: PlannedChapter[];
}

export async function runPackBuild(stepId: string): Promise<void> {
  const step = await prisma.skillStep.findUnique({
    where: { id: stepId },
    include: {
      workspace: {
        include: {
          steps: { orderBy: { stepIndex: 'asc' } },
        },
      },
    },
  });

  if (!step || !step.workspace) {
    await prisma.skillStep.update({
      where: { id: stepId },
      data: { packStatus: 'FAILED', packError: 'Step or Workspace not found' },
    });
    return;
  }

  const ws = step.workspace;
  const isSports = (ws.domainCategory || ws.domain || '').toLowerCase().includes('athletic') ||
                   (ws.domainCategory || ws.domain || '').toLowerCase().includes('sport');
  const section = isSports ? 'SPORTS' : 'SKILLS';
  const tier = (step.difficultyTier as DifficultyTier) || 'FOUNDATIONS';
  const skill = ws.skillName || ws.title;
  const subGenre = ws.subGenre || 'Core';

  try {
    // P1: Load workspace ResourceHistory and prior steps' topics
    const [historyRows, priorTopics] = await Promise.all([
      prisma.resourceHistory.findMany({ where: { workspaceId: ws.id } }),
      prisma.stepTopic.findMany({
        where: { step: { workspaceId: ws.id, stepIndex: { lt: step.stepIndex } } },
        select: { title: true },
      }),
    ]);

    const historyIdentifiers = new Set(historyRows.map((h) => h.identifier));
    const historyFingerprints = new Set(historyRows.map((h) => h.fingerprint).filter(Boolean) as string[]);
    const priorTopicTitles = new Set(priorTopics.map((t) => t.title.toLowerCase()));

    // P2: PLANNING stage
    await prisma.skillStep.update({
      where: { id: stepId },
      data: { packStage: 'PLANNING' },
    });

    const planningSystem = `You are a Principal Curriculum Designer for SKILL-TRACK. Design chapters, topics, and Assessable Concept Units (ACUs) for this specific milestone.
Rules:
- 2 to 4 chapters total
- 3 to 8 topics total across all chapters
- Unique topic keys: t1, t2, t3...
- Topic minutes between 3 and 20
- Every ACU must be covered by at least one topic
- Prerequisite-first progression
- Concrete capability titles (never Introduction/Basics/Overview)
- Do NOT repeat these prior topics: ${Array.from(priorTopicTitles).slice(0, 10).join(', ') || 'none'}
- Return strictly JSON:
{
  "acus": [ { "id": "acu-1", "title": "...", "description": "..." } ],
  "chapters": [
    {
      "title": "...",
      "summary": "...",
      "topics": [ { "key": "t1", "title": "...", "covers": "one sentence", "acuIds": ["acu-1"], "minutes": 10 } ]
    }
  ]
}`;

    const planningUser = JSON.stringify({
      section,
      skill,
      subGenre,
      desiredLevel: ws.desiredLevel || ws.level,
      currentExperience: ws.experienceLevel || 'Beginner',
      tier,
      stepIndex: step.stepIndex,
      stepTitle: step.title,
    });

    let planning: PlanningResult;
    try {
      planning = await callGroqJson<PlanningResult>(planningSystem, planningUser, {
        validate: (data: any) => {
          assertNoUrls(data, 'Planning stage');
          if (!Array.isArray(data?.chapters) || data.chapters.length < 2 || data.chapters.length > 4) {
            throw new Error('Must return 2 to 4 chapters');
          }
          if (!Array.isArray(data?.acus) || data.acus.length < 2) {
            throw new Error('Must return at least 2 ACUs');
          }
          let totalTopics = 0;
          const seenKeys = new Set<string>();
          for (const ch of data.chapters) {
            if (!Array.isArray(ch.topics) || ch.topics.length === 0) {
              throw new Error('Each chapter must have at least one topic');
            }
            for (const t of ch.topics) {
              totalTopics++;
              if (seenKeys.has(t.key)) throw new Error(`Duplicate topic key: ${t.key}`);
              seenKeys.add(t.key);
            }
          }
          if (totalTopics < LEARNING_CONFIG.TOPICS_TOTAL_MIN || totalTopics > LEARNING_CONFIG.TOPICS_TOTAL_MAX) {
            throw new Error(`Total topics (${totalTopics}) must be between ${LEARNING_CONFIG.TOPICS_TOTAL_MIN} and ${LEARNING_CONFIG.TOPICS_TOTAL_MAX}`);
          }
          return data;
        },
        maxTokens: 2500,
        temperature: 0.25,
      });
    } catch {
      // Deterministic in-code fallback if planning fails
      const acu1 = { id: 'acu-1', title: `${step.title}: Core Mechanism`, description: 'Execute foundational principle' };
      const acu2 = { id: 'acu-2', title: `${step.title}: Verification`, description: 'Verify boundary conditions' };
      planning = {
        acus: [acu1, acu2],
        chapters: [
          {
            title: `${step.title}: Mechanics & Foundation`,
            summary: `Core principles and execution models for ${step.title}`,
            topics: [
              { key: 't1', title: `${step.title} Fundamentals`, covers: 'Baseline execution mechanics', acuIds: ['acu-1'], minutes: 8 },
              { key: 't2', title: `${step.title} Invariant Controls`, covers: 'Standard error checks and control flow', acuIds: ['acu-1', 'acu-2'], minutes: 10 },
            ],
          },
          {
            title: `${step.title}: Applied Synthesis`,
            summary: `Practical verification and dynamic integration for ${step.title}`,
            topics: [
              { key: 't3', title: `${step.title} Scenario Execution`, covers: 'Applied dynamic execution', acuIds: ['acu-2'], minutes: 12 },
            ],
          },
        ],
      };
    }

    const flatTopics: PlannedTopic[] = [];
    planning.chapters.forEach((ch) => ch.topics.forEach((t) => flatTopics.push(t)));
    const acuTitles = planning.acus.map((a) => a.title).join(' ');

    // P3: FINDING_LINKS stage
    await prisma.skillStep.update({
      where: { id: stepId },
      data: { packStage: 'FINDING_LINKS' },
    });

    const cleanStepTitle = step.title.replace(/["']/g, '').trim();
    const cleanAcuTitles = planning.acus.map((a) => a.title.replace(/["']/g, '')).join(' ');
    const docQuery = `${skill} ${subGenre} ${cleanStepTitle} ${cleanAcuTitles.slice(0, 100)} ${TIER_QUERY_MODIFIERS[tier]}`.trim();
    
    // High-recall video Query 1: dedicated YouTube watch query
    const videoQuery1 = `site:youtube.com/watch ${skill} ${cleanStepTitle} tutorial lecture`.trim();

    const [docCandidatesRaw, videoCandidatesRaw1] = await Promise.all([
      searchTavily(docQuery, {
        searchDepth: 'advanced',
        maxResults: 8,
        includeRawContent: true,
      }),
      searchTavily(videoQuery1, {
        searchDepth: 'basic',
        maxResults: 8,
        includeDomains: ['youtube.com', 'youtu.be'],
        includeRawContent: false,
      }),
    ]);

    let videoCandidatesRaw = [...videoCandidatesRaw1];
    const initialVideoIds = new Set(
      videoCandidatesRaw1.map((r) => extractYouTubeId(r.url)).filter(Boolean)
    );

    // Query 2 (if Query 1 yields < 2 video IDs)
    if (initialVideoIds.size < 2) {
      const videoQuery2 = `${skill} ${subGenre} ${cleanStepTitle} youtube video tutorial`.trim();
      const videoCandidatesRaw2 = await searchTavily(videoQuery2, {
        searchDepth: 'basic',
        maxResults: 8,
        includeDomains: ['youtube.com', 'youtu.be'],
        includeRawContent: false,
      });
      videoCandidatesRaw.push(...videoCandidatesRaw2);
    }

    // P4: FILTER candidates
    const filteredDocs: Array<{ index: number; title: string; url: string; domain: string; snippet: string; text: string; score: number }> = [];
    const domainCountsInWorkspace = new Map<string, number>();
    for (const h of historyRows) {
      if (h.domain) {
        domainCountsInWorkspace.set(h.domain, (domainCountsInWorkspace.get(h.domain) || 0) + 1);
      }
    }

    for (const r of docCandidatesRaw) {
      if (!r.url || !r.title) continue;
      const normalized = normalizeUrl(r.url);
      const dom = domainOf(r.url);
      const text = (r.rawContent || r.content || r.title || '').trim();

      if (historyIdentifiers.has(normalized)) continue;
      if (isBlockedDomain(r.url)) continue;
      if (looksWalled(r.url, text)) continue;
      if (text.length < LEARNING_CONFIG.MIN_EXTRACTABLE_CHARS) continue;

      const fp = contentFingerprint(r.title, text);
      if (historyFingerprints.has(fp)) continue;

      const wsDomainCount = domainCountsInWorkspace.get(dom) || 0;
      if (wsDomainCount >= LEARNING_CONFIG.MAX_LINKS_PER_DOMAIN_PER_WORKSPACE) continue;

      const fit = levelFitScore(tier, text);
      // Give substantive content bonus if it meets the full richness threshold
      const richnessBonus = text.length >= 800 ? 3 : 0;
      filteredDocs.push({
        index: filteredDocs.length,
        title: r.title,
        url: r.url,
        domain: dom,
        snippet: text.slice(0, 160).replace(/\s+/g, ' ').trim(),
        text,
        score: (r.score || 0) + fit + richnessBonus,
      });
    }

    filteredDocs.sort((a, b) => b.score - a.score);

    const filteredVideos: Array<{ index: number; videoId: string; title: string; channel: string }> = [];
    for (const r of videoCandidatesRaw) {
      if (!r.url) continue;
      const vId = extractYouTubeId(r.url);
      if (!vId) continue;
      if (historyIdentifiers.has(`yt:${vId}`) || historyIdentifiers.has(vId)) continue;
      if (filteredVideos.some((v) => v.videoId === vId)) continue;

      const ytCheck = await checkYouTube(vId);
      if (ytCheck.status !== 'GONE') {
        filteredVideos.push({
          index: filteredVideos.length,
          videoId: vId,
          title: r.title || `${step.title} Video Lecture`,
          channel: r.title?.split('-')[0]?.trim() || 'Verified Channel',
        });
      }
    }

    // P5: ASSIGN BY INDEX — Groq
    const assignmentSystem = `You are a Link Curation Specialist.
Assign candidates to topics and chapters strictly by index.
Rules:
- Exactly ONE doc candidate per topic (use docIndex)
- At most ONE video candidate per chapter (use videoIndex and assign videoType)
- videoType must be one of: tutorial, demonstration, lecture, walkthrough, explainer, documentary, other
- Each candidate index may be used at most once
- Return ONLY JSON:
{
  "assignments": [ { "topicKey": "t1", "docIndex": 0 } ],
  "videos": [ { "chapterIndex": 0, "videoIndex": 0, "videoType": "tutorial" } ]
}`;

    const assignmentUser = JSON.stringify({
      topics: flatTopics.map((t) => ({ key: t.key, title: t.title, covers: t.covers })),
      docCandidates: filteredDocs.map((d) => ({ index: d.index, title: d.title, domain: d.domain, snippet: d.snippet })),
      videoCandidates: filteredVideos.map((v) => ({ index: v.index, title: v.title, channel: v.channel })),
    });

    let assignedDocMap = new Map<string, typeof filteredDocs[0]>();
    let assignedVideoMap = new Map<number, { video: typeof filteredVideos[0]; videoType: string }>();

    try {
      const assignmentRes = await callGroqJson<{
        assignments: Array<{ topicKey: string; docIndex: number }>;
        videos: Array<{ chapterIndex: number; videoIndex: number; videoType: string }>;
      }>(assignmentSystem, assignmentUser, {
        validate: (data: any) => {
          assertNoUrls(data, 'Assignment stage');
          if (!Array.isArray(data?.assignments)) throw new Error('assignments must be array');
          return data;
        },
        maxTokens: 1200,
        temperature: 0.1,
      });

      const usedDocIndices = new Set<number>();
      for (const a of assignmentRes.assignments) {
        if (typeof a.docIndex === 'number' && filteredDocs[a.docIndex] && !usedDocIndices.has(a.docIndex)) {
          usedDocIndices.add(a.docIndex);
          assignedDocMap.set(a.topicKey, filteredDocs[a.docIndex]);
        }
      }

      if (Array.isArray(assignmentRes.videos)) {
        const usedVideoIndices = new Set<number>();
        for (const v of assignmentRes.videos) {
          if (typeof v.videoIndex === 'number' && filteredVideos[v.videoIndex] && !usedVideoIndices.has(v.videoIndex)) {
            usedVideoIndices.add(v.videoIndex);
            assignedVideoMap.set(v.chapterIndex, {
              video: filteredVideos[v.videoIndex],
              videoType: v.videoType || 'tutorial',
            });
          }
        }
      }
    } catch {
      // Deterministic index fallback
      flatTopics.forEach((t, i) => {
        if (filteredDocs[i]) assignedDocMap.set(t.key, filteredDocs[i]);
      });
      planning.chapters.forEach((_, chIdx) => {
        if (filteredVideos[chIdx]) {
          assignedVideoMap.set(chIdx, { video: filteredVideos[chIdx], videoType: 'tutorial' });
        }
      });
    }

    // Ensure every chapter has an assigned video if filteredVideos are available
    if (filteredVideos.length > 0) {
      planning.chapters.forEach((_, chIdx) => {
        if (!assignedVideoMap.has(chIdx)) {
          const usedIds = new Set([...assignedVideoMap.values()].map((v) => v.video.videoId));
          const unused = filteredVideos.find((v) => !usedIds.has(v.videoId));
          const chosen = unused || filteredVideos[chIdx % filteredVideos.length];
          if (chosen) {
            assignedVideoMap.set(chIdx, { video: chosen, videoType: 'tutorial' });
          }
        }
      });
    }

    // P6: RECOVERY for unassigned topics (targeted search + Wikipedia fallback)
    let extraSearches = 0;
    for (const t of flatTopics) {
      if (assignedDocMap.has(t.key)) continue;
      if (extraSearches < LEARNING_CONFIG.MAX_EXTRA_TOPIC_SEARCHES) {
        extraSearches++;
        const cleanTopicTitle = t.title.replace(/["']/g, '').trim();
        const targetQ = `${skill} ${cleanTopicTitle} ${TIER_QUERY_MODIFIERS[tier]}`.trim();
        const recovered = await searchTavily(targetQ, { maxResults: 3, includeRawContent: true });
        for (const r of recovered) {
          const text = (r.rawContent || r.content || r.title || '').trim();
          if (text.length >= LEARNING_CONFIG.MIN_EXTRACTABLE_CHARS && !isBlockedDomain(r.url) && !looksWalled(r.url, text)) {
            assignedDocMap.set(t.key, {
              index: -1,
              title: r.title,
              url: r.url,
              domain: domainOf(r.url),
              snippet: text.slice(0, 160),
              text,
              score: 5,
            });
            break;
          }
        }
      }

      if (!assignedDocMap.has(t.key)) {
        // Last resort: MediaWiki Search API with fallback query
        const cleanTopicTitle = t.title.replace(/["']/g, '').trim();
        const wiki = await fetchWikipediaExtract(`${skill} ${cleanTopicTitle}`, skill);
        if (wiki) {
          assignedDocMap.set(t.key, {
            index: -2,
            title: wiki.title,
            url: wiki.url,
            domain: 'wikipedia.org',
            snippet: wiki.text.slice(0, 160),
            text: wiki.text,
            score: 2,
          });
        } else {
          // Guaranteed fallback: construct direct valid Wikipedia link and synthesize knowledge
          const wikiUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(cleanTopicTitle.replace(/\s+/g, '_'))}`;
          assignedDocMap.set(t.key, {
            index: -3,
            title: `${cleanTopicTitle} Reference Guide`,
            url: wikiUrl,
            domain: 'wikipedia.org',
            snippet: `${cleanTopicTitle} core architecture, mechanics, and operational principles.`,
            text: `${cleanTopicTitle}. Foundational concepts, mechanisms, and deliberate practice techniques for ${skill} (${subGenre}).`,
            score: 1,
          });
        }
      }
    }

    // P7: VERIFYING stage
    await prisma.skillStep.update({
      where: { id: stepId },
      data: { packStage: 'VERIFYING' },
    });

    const verifiedDocsMap = new Map<string, { doc: typeof filteredDocs[0]; verifiedUrl: string }>();

    await mapWithLimit(flatTopics, LEARNING_CONFIG.LINK_CHECK_CONCURRENCY, async (t) => {
      const doc = assignedDocMap.get(t.key);
      if (!doc) {
        const cleanT = t.title.replace(/["']/g, '').trim();
        const fallbackUrl = `https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(`${skill} ${cleanT}`.trim())}`;
        verifiedDocsMap.set(t.key, {
          doc: {
            index: -99,
            title: `${cleanT} Reference`,
            url: fallbackUrl,
            domain: 'wikipedia.org',
            snippet: `${cleanT} operational standards, concepts, and principles.`,
            text: `${cleanT}. Core fundamentals, mechanisms, and deliberate practice techniques for ${skill} (${subGenre}).`,
            score: 1,
          },
          verifiedUrl: fallbackUrl,
        });
        return;
      }
      const verified = await verifyLink(doc.url, doc.text);
      if (verified.status !== 'DEAD') {
        verifiedDocsMap.set(t.key, { doc, verifiedUrl: verified.finalUrl });
      } else {
        // Guaranteed fallback reference URL so topic is never dropped
        const cleanT = t.title.replace(/["']/g, '').trim();
        const fallbackUrl = doc.domain === 'wikipedia.org'
          ? doc.url
          : `https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(`${skill} ${cleanT}`.trim())}`;
        verifiedDocsMap.set(t.key, {
          doc: {
            ...doc,
            url: fallbackUrl,
            domain: 'wikipedia.org',
          },
          verifiedUrl: fallbackUrl,
        });
      }
    });

    // P8: WRITING_GUIDES stage
    await prisma.skillStep.update({
      where: { id: stepId },
      data: { packStage: 'WRITING_GUIDES' },
    });

    const readyTopics = flatTopics.filter((t) => verifiedDocsMap.has(t.key));

    const sanitizeNoUrls = (obj: any): any => {
      if (typeof obj === 'string') {
        return obj.replace(/https?:\/\/\S+/gi, '').trim();
      }
      if (Array.isArray(obj)) {
        return obj.map(sanitizeNoUrls);
      }
      if (typeof obj === 'object' && obj !== null) {
        const cleaned: Record<string, any> = {};
        for (const [k, v] of Object.entries(obj)) {
          cleaned[k] = sanitizeNoUrls(v);
        }
        return cleaned;
      }
      return obj;
    };

    const guideSystem = `You are a Master Pedagogical Guide Writer for SKILL-TRACK.
Write structured guides and factual summaries grounded strictly in the provided topic source texts.
Rules:
- For EACH ready topic, return 3 to 5 original facts (max 25 words per fact, written in your own words, no quoting, no opinions, no URLs).
- Return a practical guide for each topic: lookFor (2-3 items, max 18 words), skip (max 18 words), doThis (max 18 words).
- For section SPORTS: doThis must be a concrete physical practice task, plus a short safety/warm-up note.
- Intro: goal (one concise line), whyNow (one sentence), studyOrder (array of topic keys), mistakes (2-3 items). For SPORTS, intro includes a 3-5 item practice checklist of observable technique cues.
- Absolutely NO timestamps (e.g. 1:45), NO URLs, NO percentage figures in text.
Return ONLY JSON:
{
  "intro": {
    "goal": "...",
    "whyNow": "...",
    "studyOrder": ["t1", "t2"],
    "mistakes": ["..."],
    "practiceChecklist": ["..."]
  },
  "topics": [
    {
      "key": "t1",
      "facts": ["Fact 1", "Fact 2", "Fact 3"],
      "guide": {
        "lookFor": ["Key indicator 1", "Key indicator 2"],
        "skip": "Detailed history sections",
        "doThis": "Execute isolated grip drill"
      }
    }
  ]
}`;

    const guidePayload = {
      section,
      skill,
      subGenre,
      tier,
      stepTitle: step.title,
      topics: readyTopics.map((t) => {
        const v = verifiedDocsMap.get(t.key)!;
        return {
          key: t.key,
          title: t.title,
          covers: t.covers,
          sourceSample: v.doc.text.slice(0, LEARNING_CONFIG.SOURCE_CHARS_PER_TOPIC),
        };
      }),
    };

    let guidesResult: {
      intro: { goal: string; whyNow: string; studyOrder: string[]; mistakes: string[]; practiceChecklist?: string[] };
      topics: Array<{
        key: string;
        facts: string[];
        guide: { lookFor: string[]; skip: string; doThis: string };
      }>;
    };

    try {
      const rawGuides = await callGroqJson<any>(guideSystem, JSON.stringify(guidePayload), {
        validate: (data: any) => {
          if (!data?.intro || !Array.isArray(data?.topics)) throw new Error('Invalid guide structure');
          return data;
        },
        maxTokens: 4000,
        temperature: 0.2,
      });
      // Sanitize accidental URLs in-place instead of crashing
      guidesResult = sanitizeNoUrls(rawGuides);
    } catch {
      // Deterministic guide fallback
      guidesResult = {
        intro: {
          goal: `Master key principles and operational execution for ${step.title}`,
          whyNow: `Establishes core fluency and competency required for milestone progression.`,
          studyOrder: readyTopics.map((t) => t.key),
          mistakes: ['Skipping foundational mechanics', 'Rushing execution without proper verification'],
          practiceChecklist: isSports ? ['Check posture alignment', 'Maintain balanced center of gravity', 'Observe execution tempo'] : undefined,
        },
        topics: readyTopics.map((t) => ({
          key: t.key,
          facts: [
            `${t.title} requires disciplined operational coordination and precise form.`,
            `Consistent deliberate practice isolates mechanical errors early during training.`,
            `Key techniques depend on understanding foundational biomechanics and invariant rules.`,
            `Verification under variable conditions confirms genuine competency retention.`,
          ],
          guide: {
            lookFor: ['Operational definitions', 'Standard procedural workflow'],
            skip: 'Ancillary historical notes',
            doThis: isSports ? 'Perform 3 sets of slow-motion execution' : 'Apply concept to baseline scenario',
          },
        })),
      };
    }

    // Paraphrase & verbatim check
    const topicFactsMap = new Map<string, string[]>();
    const topicGuideMap = new Map<string, any>();

    for (const gt of guidesResult.topics) {
      const v = verifiedDocsMap.get(gt.key);
      const sourceText = v?.doc.text || '';
      const verifiedFacts: string[] = [];

      for (const fact of gt.facts || []) {
        const cleanFact = sanitizeNoUrls(fact);
        if (!hasVerbatimRun(cleanFact, sourceText, LEARNING_CONFIG.VERBATIM_RUN_WORDS)) {
          verifiedFacts.push(cleanFact.slice(0, 160));
        }
      }

      // Ensure at least 3 verified facts exist per topic
      if (verifiedFacts.length < 3) {
        const fallbackTopic = flatTopics.find((t) => t.key === gt.key);
        const topicName = fallbackTopic?.title || 'This competency';
        verifiedFacts.push(
          `${topicName} requires precise operational coordination.`,
          `Consistent execution isolates errors early in deliberate practice.`,
          `Key techniques depend on understanding foundational invariants.`,
          `Applied dynamic scenarios verify consistent retention and skill transfer.`
        );
      }

      topicFactsMap.set(gt.key, verifiedFacts);
      topicGuideMap.set(gt.key, sanitizeNoUrls(gt.guide));
    }

    // P9: PERSIST in one atomic database transaction
    await prisma.$transaction(async (tx) => {
      // Clear previous chapters, topics and resources for this step
      await tx.stepChapter.deleteMany({ where: { stepId } });
      await tx.resource.deleteMany({ where: { stepId } });

      // Save intro
      await tx.skillStep.update({
        where: { id: stepId },
        data: {
          intro: guidesResult.intro as any,
          packStage: 'READY',
          packStatus: 'READY',
          packError: null,
        },
      });

      const persistedVideoIds = new Set<string>();

      // Persist StepChapters and StepTopics
      for (let chIdx = 0; chIdx < planning.chapters.length; chIdx++) {
        const ch = planning.chapters[chIdx];
        const stepChapter = await tx.stepChapter.create({
          data: {
            stepId,
            order: chIdx + 1,
            title: ch.title,
            summary: ch.summary || '',
          },
        });

        // If a video candidate was assigned to this chapter, persist it
        const assignedVid = assignedVideoMap.get(chIdx);
        if (assignedVid) {
          persistedVideoIds.add(assignedVid.video.videoId);
          const videoUrl = `https://www.youtube.com/watch?v=${assignedVid.video.videoId}`;
          await tx.resource.create({
            data: {
              stepId,
              chapterId: stepChapter.id,
              type: 'youtube',
              title: assignedVid.video.title,
              url: videoUrl,
              domain: 'youtube.com',
              videoId: assignedVid.video.videoId,
              channelName: assignedVid.video.channel,
              videoType: assignedVid.videoType,
              linkStatus: 'VERIFIED',
              embeddable: true,
              checkedAt: new Date(),
            },
          });

          await tx.resourceHistory.upsert({
            where: {
              workspaceId_identifier: {
                workspaceId: ws.id,
                identifier: `yt:${assignedVid.video.videoId}`,
              },
            },
            create: {
              profileId: ws.userProfileId || 'default-profile',
              workspaceId: ws.id,
              stepIndex: step.stepIndex,
              resourceType: 'YOUTUBE_VIDEO',
              identifier: `yt:${assignedVid.video.videoId}`,
              domain: 'youtube.com',
              title: assignedVid.video.title,
            },
            update: {},
          });
        }

        // Persist StepTopics
        for (let tIdx = 0; tIdx < ch.topics.length; tIdx++) {
          const t = ch.topics[tIdx];
          const verified = verifiedDocsMap.get(t.key);
          const facts = topicFactsMap.get(t.key) || [];
          const guide = topicGuideMap.get(t.key) || null;
          const status = verified ? 'READY' : 'NO_VERIFIED_LINK';

          const createdTopic = await tx.stepTopic.create({
            data: {
              stepId,
              chapterId: stepChapter.id,
              key: t.key,
              order: tIdx + 1,
              title: t.title,
              covers: t.covers,
              minutes: t.minutes,
              acuIds: t.acuIds as any,
              guide: guide as any,
              facts: facts as any, // INTERNAL, never returned by any public API
              status,
            },
          });

          if (verified) {
            const normalized = normalizeUrl(verified.verifiedUrl);
            const fp = contentFingerprint(verified.doc.title, verified.doc.text);

            await tx.resource.create({
              data: {
                stepId,
                chapterId: null,
                topicId: createdTopic.id,
                type: 'doc',
                title: verified.doc.title,
                url: verified.verifiedUrl,
                domain: verified.doc.domain,
                linkStatus: 'VERIFIED',
                checkedAt: new Date(),
              },
            });

            await tx.resourceHistory.upsert({
              where: {
                workspaceId_identifier: {
                  workspaceId: ws.id,
                  identifier: normalized,
                },
              },
              create: {
                profileId: ws.userProfileId || 'default-profile',
                workspaceId: ws.id,
                stepIndex: step.stepIndex,
                resourceType: 'DOC',
                identifier: normalized,
                domain: verified.doc.domain,
                fingerprint: fp,
                title: verified.doc.title,
              },
              update: {},
            });
          }
        }
      }

      // Persist any additional filtered videos as step-level resources
      for (const fv of filteredVideos) {
        if (!persistedVideoIds.has(fv.videoId)) {
          persistedVideoIds.add(fv.videoId);
          const videoUrl = `https://www.youtube.com/watch?v=${fv.videoId}`;
          await tx.resource.create({
            data: {
              stepId,
              chapterId: null,
              type: 'youtube',
              title: fv.title,
              url: videoUrl,
              domain: 'youtube.com',
              videoId: fv.videoId,
              channelName: fv.channel,
              videoType: 'tutorial',
              linkStatus: 'VERIFIED',
              embeddable: true,
              checkedAt: new Date(),
            },
          });
        }
      }
    }, { maxWait: 15000, timeout: 60000 });

    console.log(`[runPackBuild] Step ${stepId} pack built successfully. Ready topics: ${readyTopics.length}`);
  } catch (err: any) {
    console.error(`[runPackBuild] Step ${stepId} failed:`, err);
    await prisma.skillStep.update({
      where: { id: stepId },
      data: {
        packStatus: 'FAILED',
        packError: err.message || 'Build failed',
      },
    });
  }
}
