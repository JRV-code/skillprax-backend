import prisma from '../lib/prisma';
import { LEARNING_CONFIG, tierForStep, TIER_QUERY_MODIFIERS, DifficultyTier } from '../config/learning';
import {
  callGroqJson,
  searchTavily,
  extractYouTubeId,
  normalizeUrl,
  isSafePublicUrl,
  mapWithLimit,
  assertNoUrls,
  checkYouTube,
  verifyLink,
  fetchWikipediaExtract,
  wikipediaSectionLink,
  TavilySearchItem,
  LinkStatus,
} from '../lib/foundation';

export interface TopicDefinition {
  key: string;
  order: number;
  title: string;
  covers: string;
  minutes: number;
  acuIds: string[];
  chapterMarkdown: string | null;
  sectionLink: { url: string; label: string } | null;
  resourceIds: string[];
  status: 'READY' | 'NO_VERIFIED_LINK';
}

export interface StoredResource {
  id: string;
  type: 'video' | 'doc';
  title: string;
  url: string;
  videoId?: string | null;
  channelName?: string | null;
  embeddable: boolean;
  topicKey?: string | null;
  focusNote?: string | null;
  snippet?: string | null;
  linkStatus: LinkStatus;
  checkedAt: string;
  sourceType?: 'TAVILY' | 'WIKIPEDIA' | 'LINKS_ONLY';
}

export interface ApproachBrief {
  goal: string;
  whyNow: string;
  totalMinutes: number;
  order: Array<{ topicKey: string; why: string }>;
  beforeYouStart: string[];
  perResource: Array<{
    resourceId: string;
    focus: string;
    ignore: string;
    timebox: string;
  }>;
  howToStudy: string[];
  commonMistakes: string[];
  selfCheck: Array<{ prompt: string; hint: string }>;
  masteryTarget: { passPercent: number };
}

export interface PipelineResult {
  status: 'STUDY_READY' | 'NO_SOURCE_FOUND';
  tier: DifficultyTier;
  topicMap: TopicDefinition[];
  resources: StoredResource[];
  document?: any;
  approachBrief?: ApproachBrief | null;
  timings: Record<string, number>;
  totalTimeMs: number;
}

export async function executeCurriculumPipeline(stepId: string): Promise<PipelineResult> {
  const startTime = Date.now();
  const timings: Record<string, number> = {};

  const step: any = await prisma.skillStep.findUnique({
    where: { id: stepId },
    include: { workspace: true },
  });

  if (!step) {
    throw new Error('SkillStep not found');
  }

  const workspace = step.workspace;
  const workspaceId = workspace?.id || 'default-workspace';
  const profileId = workspace?.userProfileId || workspace?.profileId || 'default-profile';

  // Count total planned steps
  const allWorkspaceSteps = await prisma.skillStep.findMany({
    where: { workspaceId },
    select: { id: true, stepIndex: true },
  });
  const totalSteps = Math.max(workspace?.totalPlannedSteps || allWorkspaceSteps.length, allWorkspaceSteps.length, 1);
  const stepIndex = step.stepIndex || 1;

  // S1: Difficulty tier calculation and load history
  const t0 = Date.now();
  const tier = tierForStep(stepIndex, totalSteps);
  await prisma.skillStep.update({
    where: { id: stepId },
    data: { difficultyTier: tier },
  });

  const existingHistory = await prisma.resourceHistory.findMany({
    where: { workspaceId },
    select: { identifier: true },
  });
  const historyIdentifiers = new Set<string>(existingHistory.map((h) => h.identifier));
  timings.S1_init = Date.now() - t0;

  // Normalize ACUs
  const acusRaw = step.assessableUnits;
  const acusList: Array<{ id: string; title: string; description: string }> = Array.isArray(acusRaw)
    ? acusRaw.map((a: any, i: number) => ({
        id: a.id || `acu-${stepIndex}-${i + 1}`,
        title: a.title || a.label || `Competency ${i + 1}`,
        description: a.description || a.title || `Core skill competency ${i + 1}`,
      }))
    : [];

  const earlierSteps = await prisma.skillStep.findMany({
    where: { workspaceId, stepIndex: { lt: stepIndex } },
    select: { title: true },
  });
  const earlierStepTitles = earlierSteps.map((s) => s.title);

  // S2: Topic Plan (Groq)
  const t1 = Date.now();
  let topics: Array<{ key: string; title: string; covers: string; acuIds: string[]; minutes: number }> = [];

  const topicPlanSystem = `You are a Principal Curriculum Taxonomist.
Given a milestone and its Assessable Competency Units (ACUs), group the material into 3 to 6 distinct, sequential topic chapters.
Order prerequisite-first.
Do not repeat topics covered in earlier steps: ${JSON.stringify(earlierStepTitles)}.
Rules:
- 3 to 6 topics.
- Every ACU id MUST appear in at least one topic's acuIds array.
- Topic titles must be specific, mechanical, and technical. NEVER use generic titles like "Introduction", "Overview", or "Basics".
- "minutes" must be an integer between 3 and 20.
- STRICT: DO NOT output any URLs or web links. Output JSON ONLY.
Schema:
{
  "topics": [
    { "key": "t1", "title": "Specific Chapter Title", "covers": "One clear sentence defining what is covered", "acuIds": ["acu-id-1"], "minutes": 8 }
  ]
}`;

  const topicPlanUser = `Skill: "${workspace?.title || step.title}".
Sub-genre: "${workspace?.subGenre || 'Core Foundations'}".
Step ${stepIndex} (${tier}): "${step.title}".
ACUs: ${JSON.stringify(acusList)}.`;

  try {
    const planned = await callGroqJson<{ topics: any[] }>(topicPlanSystem, topicPlanUser, {
      validate: (v: any) =>
        Array.isArray(v?.topics) &&
        v.topics.length >= LEARNING_CONFIG.TOPICS_MIN &&
        v.topics.length <= LEARNING_CONFIG.TOPICS_MAX &&
        v.topics.every((t: any) => typeof t.title === 'string' && typeof t.key === 'string'),
      maxTokens: 1200,
      temperature: 0.2,
    });
    assertNoUrls(planned, 'TopicPlan');
    topics = planned.topics.map((t, idx) => ({
      key: t.key || `t${idx + 1}`,
      title: t.title.trim(),
      covers: t.covers || t.title,
      acuIds: Array.isArray(t.acuIds) ? t.acuIds : [acusList[0]?.id || `acu-${stepIndex}-1`],
      minutes: Math.min(20, Math.max(3, Number(t.minutes) || 8)),
    }));
  } catch (topicErr) {
    // S2 Fallback: Fall back in CODE to one topic per ACU
    topics = (acusList.length > 0 ? acusList : [{ id: `acu-${stepIndex}-1`, title: step.title, description: step.title }])
      .slice(0, LEARNING_CONFIG.TOPICS_MAX)
      .map((acu, idx) => ({
        key: `t${idx + 1}`,
        title: acu.title,
        covers: acu.description,
        acuIds: [acu.id],
        minutes: 10,
      }));
  }
  timings.S2_topicPlan = Date.now() - t1;

  // S3: Parallel Tavily search (Document + Video)
  const t2 = Date.now();
  const acuTitlesJoined = acusList.map((a) => a.title).join(' ');
  const tierModifier = TIER_QUERY_MODIFIERS[tier];
  const baseQuery = `${workspace?.title || ''} ${workspace?.subGenre || ''} "${step.title}" ${acuTitlesJoined} ${tierModifier} 2026`.trim();
  const docQuery = baseQuery;
  const videoQuery = `${baseQuery} tutorial`.trim();

  const [docResults, videoResults] = await Promise.all([
    searchTavily(docQuery, {
      searchDepth: 'advanced',
      maxResults: 6,
      includeRawContent: true,
    }),
    searchTavily(videoQuery, {
      searchDepth: 'basic',
      maxResults: 6,
      includeDomains: ['youtube.com'],
    }),
  ]);
  timings.S3_parallelSearch = Date.now() - t2;

  // S4: Candidate filter
  const t3 = Date.now();
  interface Candidate {
    index: number;
    kind: 'doc' | 'video';
    title: string;
    url: string;
    domain: string;
    snippet: string;
    rawContent?: string;
    videoId?: string | null;
  }

  const candidates: Candidate[] = [];
  let candidateIndex = 0;

  for (const doc of docResults) {
    if (!doc.url) continue;
    const norm = normalizeUrl(doc.url);
    if (historyIdentifiers.has(norm)) continue;
    if (!(await isSafePublicUrl(doc.url))) continue;
    try {
      const u = new URL(doc.url);
      candidates.push({
        index: candidateIndex++,
        kind: 'doc',
        title: doc.title,
        url: doc.url,
        domain: u.hostname.replace(/^www\./, ''),
        snippet: (doc.content || '').slice(0, 160),
        rawContent: doc.rawContent || doc.content,
      });
    } catch (_) {}
  }

  for (const vid of videoResults) {
    if (!vid.url) continue;
    const vId = extractYouTubeId(vid.url);
    if (!vId) continue; // Drop playlists, channels
    if (historyIdentifiers.has(vId)) continue;
    if (!(await isSafePublicUrl(vid.url))) continue;
    candidates.push({
      index: candidateIndex++,
      kind: 'video',
      title: vid.title,
      url: `https://www.youtube.com/watch?v=${vId}`,
      domain: 'youtube.com',
      snippet: (vid.content || '').slice(0, 160),
      videoId: vId,
    });
  }
  timings.S4_filter = Date.now() - t3;

  // S5: Assignment by Index (Groq)
  const t4 = Date.now();
  type Assignment = { topicKey: string; docIndexes: number[]; videoIndexes: number[] };
  let assignments: Assignment[] = [];

  if (candidates.length > 0) {
    const candidateSummary = candidates.map((c) => ({
      index: c.index,
      kind: c.kind,
      title: c.title,
      domain: c.domain,
      snippet: c.snippet,
    }));

    const assignmentSystem = `You are a Curriculum Content Allocator.
Assign search candidates to curriculum topics BY INDEX ONLY.
Each candidate can only be used ONCE.
At most 2 docIndexes and at most 1 videoIndex per topic.
Output JSON ONLY with no URLs:
{
  "assignments": [
    { "topicKey": "t1", "docIndexes": [0], "videoIndexes": [3] }
  ]
}`;

    const assignmentUser = `Topics: ${JSON.stringify(topics.map((t) => ({ key: t.key, title: t.title, covers: t.covers })))}.
Candidates: ${JSON.stringify(candidateSummary)}.`;

    try {
      const assigned = await callGroqJson<{ assignments: Assignment[] }>(assignmentSystem, assignmentUser, {
        validate: (v: any) => Array.isArray(v?.assignments),
        maxTokens: 1200,
        temperature: 0.1,
      });
      assertNoUrls(assigned, 'AssignmentByIndex');

      const usedIndices = new Set<number>();
      for (const a of assigned.assignments) {
        const validDocs = (Array.isArray(a.docIndexes) ? a.docIndexes : [])
          .filter((idx) => typeof idx === 'number' && idx >= 0 && idx < candidates.length && !usedIndices.has(idx))
          .slice(0, 2);
        validDocs.forEach((i) => usedIndices.add(i));

        const validVideos = (Array.isArray(a.videoIndexes) ? a.videoIndexes : [])
          .filter((idx) => typeof idx === 'number' && idx >= 0 && idx < candidates.length && !usedIndices.has(idx))
          .slice(0, 1);
        validVideos.forEach((i) => usedIndices.add(i));

        assignments.push({
          topicKey: a.topicKey,
          docIndexes: validDocs,
          videoIndexes: validVideos,
        });
      }
    } catch (_) {
      // Manual round-robin fallback if Groq call fails
      let docPtr = 0;
      let vidPtr = 0;
      const docCands = candidates.filter((c) => c.kind === 'doc');
      const vidCands = candidates.filter((c) => c.kind === 'video');

      assignments = topics.map((t) => {
        const docIdxs = docCands.slice(docPtr, docPtr + 1).map((c) => c.index);
        docPtr += docIdxs.length;
        const vidIdxs = vidCands.slice(vidPtr, vidPtr + 1).map((c) => c.index);
        vidPtr += vidIdxs.length;
        return { topicKey: t.key, docIndexes: docIdxs, videoIndexes: vidIdxs };
      });
    }
  }
  timings.S5_assignment = Date.now() - t4;

  // S6: Missing-Topic Recovery (Tavily targeted searches, max 3)
  const t5 = Date.now();
  let recoverySearchesCount = 0;
  for (const t of topics) {
    const existing = assignments.find((a) => a.topicKey === t.key);
    const hasCandidate = existing && (existing.docIndexes.length > 0 || existing.videoIndexes.length > 0);
    if (!hasCandidate && recoverySearchesCount < LEARNING_CONFIG.MAX_EXTRA_TOPIC_SEARCHES) {
      recoverySearchesCount++;
      const recQuery = `${workspace?.title || ''} "${t.title}" ${t.covers} ${tierModifier} 2026`.trim();
      const recResults = await searchTavily(recQuery, { searchDepth: 'basic', maxResults: 3 });
      for (const r of recResults) {
        if (!r.url || historyIdentifiers.has(normalizeUrl(r.url))) continue;
        if (!(await isSafePublicUrl(r.url))) continue;
        const vId = extractYouTubeId(r.url);
        const newCand: Candidate = {
          index: candidateIndex++,
          kind: vId ? 'video' : 'doc',
          title: r.title,
          url: r.url,
          domain: new URL(r.url).hostname.replace(/^www\./, ''),
          snippet: (r.content || '').slice(0, 160),
          rawContent: r.rawContent || r.content,
          videoId: vId,
        };
        candidates.push(newCand);

        let topicAssign = assignments.find((a) => a.topicKey === t.key);
        if (!topicAssign) {
          topicAssign = { topicKey: t.key, docIndexes: [], videoIndexes: [] };
          assignments.push(topicAssign);
        }
        if (newCand.kind === 'video' && topicAssign.videoIndexes.length === 0) {
          topicAssign.videoIndexes.push(newCand.index);
        } else if (newCand.kind === 'doc' && topicAssign.docIndexes.length < 2) {
          topicAssign.docIndexes.push(newCand.index);
        }
      }
    }
  }
  timings.S6_recovery = Date.now() - t5;

  // S7: Link Verification
  const t6 = Date.now();
  const allAssignedCandidates = new Map<number, Candidate>();
  for (const a of assignments) {
    [...a.docIndexes, ...a.videoIndexes].forEach((idx) => {
      const c = candidates.find((cand) => cand.index === idx);
      if (c) allAssignedCandidates.set(idx, c);
    });
  }

  const candidateList = Array.from(allAssignedCandidates.values());
  const verificationResults = await mapWithLimit(
    candidateList,
    LEARNING_CONFIG.LINK_CHECK_CONCURRENCY,
    async (cand) => {
      const status = await verifyLink(cand.url, cand.snippet);
      let isEmbeddable = true;
      let channelName: string | undefined;

      if (cand.kind === 'video' && cand.videoId) {
        const yt = await checkYouTube(cand.videoId);
        if (yt.status === 'GONE') return { cand, status: 'DEAD' as LinkStatus, isEmbeddable: false };
        if (yt.status === 'NO_EMBED') isEmbeddable = false;
        channelName = yt.channel;
      }
      return { cand, status, isEmbeddable, channelName };
    }
  );

  const verifiedMap = new Map<
    number,
    { status: LinkStatus; isEmbeddable: boolean; channelName?: string }
  >();
  for (const v of verificationResults) {
    verifiedMap.set(v.cand.index, {
      status: v.status,
      isEmbeddable: v.isEmbeddable,
      channelName: v.channelName,
    });
  }
  timings.S7_verification = Date.now() - t6;

  // S8: Text ladder per topic (Tavily text -> Wikipedia failover -> Links-only)
  const t7 = Date.now();
  const topicTexts: Record<string, { text: string; source: 'TAVILY' | 'WIKIPEDIA' | 'NONE'; wikiLink?: { url: string; label: string } | null }> = {};

  for (const t of topics) {
    const a = assignments.find((asgn) => asgn.topicKey === t.key);
    let topicSourceText = '';
    if (a) {
      for (const dIdx of a.docIndexes) {
        const c = candidates.find((cand) => cand.index === dIdx);
        const v = verifiedMap.get(dIdx);
        if (c && v?.status !== 'DEAD' && c.rawContent) {
          if (c.rawContent.length >= LEARNING_CONFIG.MIN_SOURCE_TEXT_CHARS) {
            topicSourceText += `\n\n--- Source: ${c.domain} ---\n${c.rawContent.slice(0, 4000)}`;
          }
        }
      }
    }

    if (topicSourceText.length >= LEARNING_CONFIG.MIN_SOURCE_TEXT_CHARS) {
      topicTexts[t.key] = { text: topicSourceText, source: 'TAVILY' };
    } else {
      // Wikipedia failover
      const wikiQuery = `${t.title} ${workspace?.title || ''}`.trim();
      const wikiExtract = await fetchWikipediaExtract(wikiQuery);
      if (wikiExtract && wikiExtract.text.length >= 400) {
        const sectionLink = wikipediaSectionLink(wikiExtract.url, wikiExtract.text, t.title);
        topicTexts[t.key] = {
          text: wikiExtract.text.slice(0, 4000),
          source: 'WIKIPEDIA',
          wikiLink: sectionLink || { url: wikiExtract.url, label: wikiExtract.title },
        };
      } else {
        topicTexts[t.key] = { text: '', source: 'NONE' };
      }
    }
  }
  timings.S8_textLadder = Date.now() - t7;

  // S9: Chapter Synthesis (Groq)
  const t8 = Date.now();
  const chaptersWithText = topics.filter((t) => topicTexts[t.key]?.source !== 'NONE');
  let synthesizedChapters: Array<{ topicKey: string; markdown: string }> = [];
  let stepQuadrants: any = null;

  if (chaptersWithText.length > 0) {
    const chapterInputs = chaptersWithText.map((t) => ({
      topicKey: t.key,
      title: t.title,
      source: topicTexts[t.key].source,
      sourceText: topicTexts[t.key].text.slice(0, 3000),
    }));

    const chapterSystem = `You are a Master Technical Author.
Synthesize individual study chapters for a step based ONLY on the provided source text.
Rules:
- NEVER invent facts or principles not grounded in the source text.
- Do NOT copy verbatim. Explain in clear, structured study text with headings, lists, and fenced code if applicable.
- STRICT: NEVER output any URLs in the text.
- Output JSON ONLY:
{
  "chapters": [
    { "topicKey": "t1", "markdown": "## Chapter Title\\n\\nDetailed pedagogical guide..." }
  ],
  "quadrants": {
    "principle": "60-second core foundational invariant",
    "mechanics": ["Execution step 1", "Execution step 2", "Execution step 3"],
    "traps": ["Common error A", "Misconception trap B"]
  }
}`;

    try {
      const synthRes = await callGroqJson<{ chapters: any[]; quadrants: any }>(
        chapterSystem,
        JSON.stringify(chapterInputs),
        {
          validate: (v: any) => Array.isArray(v?.chapters) && typeof v?.quadrants === 'object',
          maxTokens: 3500,
          temperature: 0.2,
        }
      );
      assertNoUrls(synthRes, 'ChapterSynthesis');
      synthesizedChapters = synthRes.chapters || [];
      stepQuadrants = synthRes.quadrants;
    } catch (_) {}
  }

  // Assemble full guide markdown
  const markdownParts: string[] = [`# ${step.title}\n`];
  const finalTopicMap: TopicDefinition[] = [];
  const finalResources: StoredResource[] = [];
  let globalResourceCounter = 0;

  for (let idx = 0; idx < topics.length; idx++) {
    const t = topics[idx];
    const a = assignments.find((asgn) => asgn.topicKey === t.key);
    const assignedResourceIds: string[] = [];

    if (a) {
      for (const candIdx of [...a.docIndexes, ...a.videoIndexes]) {
        const c = candidates.find((cand) => cand.index === candIdx);
        const v = verifiedMap.get(candIdx);
        if (c && v && v.status !== 'DEAD') {
          globalResourceCounter++;
          const resId = `res-${stepIndex}-${globalResourceCounter}`;
          assignedResourceIds.push(resId);
          finalResources.push({
            id: resId,
            type: c.kind,
            title: c.title,
            url: c.url,
            videoId: c.videoId || null,
            channelName: v.channelName || (c.kind === 'video' ? 'YouTube' : c.domain),
            embeddable: v.isEmbeddable,
            topicKey: t.key,
            focusNote: c.snippet || `Focus on ${t.title} fundamentals.`,
            snippet: c.snippet,
            linkStatus: v.status,
            checkedAt: new Date().toISOString(),
            sourceType: topicTexts[t.key]?.source === 'WIKIPEDIA' ? 'WIKIPEDIA' : 'TAVILY',
          });
        }
      }
    }

    const synthChapter = synthesizedChapters.find((sc) => sc.topicKey === t.key);
    let chapterMd: string | null = null;

    if (synthChapter?.markdown) {
      chapterMd = synthChapter.markdown;
      if (topicTexts[t.key]?.source === 'WIKIPEDIA') {
        chapterMd += `\n\n> *Text adapted from Wikipedia (CC BY-SA 4.0)*`;
      }
      markdownParts.push(chapterMd);
    }

    finalTopicMap.push({
      key: t.key,
      order: idx + 1,
      title: t.title,
      covers: t.covers,
      minutes: t.minutes,
      acuIds: t.acuIds,
      chapterMarkdown: chapterMd,
      sectionLink: topicTexts[t.key]?.wikiLink || null,
      resourceIds: assignedResourceIds,
      status: assignedResourceIds.length > 0 ? 'READY' : 'NO_VERIFIED_LINK',
    });
  }

  const fullMarkdown = markdownParts.length > 1 ? markdownParts.join('\n\n---\n\n') : null;
  timings.S9_chapterSynthesis = Date.now() - t8;

  // S10: Game Plan (Groq)
  const t9 = Date.now();
  let approachBrief: ApproachBrief | null = null;

  const gamePlanSystem = `You are a Lead Learning Strategist.
Write an actionable pre-study Game Plan for the milestone before the learner opens any resources.
Rules:
- NEVER include timestamps (no "1:23" or similar).
- NEVER make claims about specific internal video content beyond what its title/snippet states.
- Tailor howToStudy to the domain:
  * Science: predict then derive.
  * Athletics: perform the drill, check form.
  * Art: sketch or replicate.
  * Homemaking: test on real tasks.
  * Cognitive Logic: work examples by hand before checking.
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

  const gamePlanUser = `Domain: "${workspace?.domainCategory || 'General Knowledge'}".
Skill: "${workspace?.title || step.title}".
Sub-genre: "${workspace?.subGenre || 'Core'}".
Step ${stepIndex} (${tier}): "${step.title}".
Topics: ${JSON.stringify(topics.map((t) => ({ key: t.key, title: t.title })))}.
Assigned Resources: ${JSON.stringify(finalResources.map((r) => ({ id: r.id, type: r.type, title: r.title, snippet: r.snippet })))}.
Earlier Steps: ${JSON.stringify(earlierStepTitles)}.`;

  try {
    const rawBrief = await callGroqJson<any>(gamePlanSystem, gamePlanUser, {
      validate: (v: any) =>
        typeof v?.goal === 'string' &&
        Array.isArray(v?.beforeYouStart) &&
        Array.isArray(v?.howToStudy) &&
        !/\b\d{1,2}:\d{2}\b/.test(JSON.stringify(v)),
      maxTokens: 1800,
      temperature: 0.3,
    });
    assertNoUrls(rawBrief, 'GamePlan');

    approachBrief = {
      ...rawBrief,
      masteryTarget: { passPercent: LEARNING_CONFIG.PASS_THRESHOLD_PERCENT },
    };
  } catch (_) {
    approachBrief = null;
  }
  timings.S10_gamePlan = Date.now() - t9;

  // S11 & S12: Persistence & Return
  const t10 = Date.now();
  const hasUsableLinks = finalResources.some((r) => r.linkStatus !== 'DEAD');
  const hasUsableText = Boolean(fullMarkdown && fullMarkdown.length >= LEARNING_CONFIG.MIN_SOURCE_TEXT_CHARS);

  if (!hasUsableLinks && !hasUsableText) {
    return {
      status: 'NO_SOURCE_FOUND',
      tier,
      topicMap: finalTopicMap,
      resources: [],
      timings,
      totalTimeMs: Date.now() - startTime,
    };
  }

  // Determine primary sourceType
  const anyTavily = Object.values(topicTexts).some((t) => t.source === 'TAVILY');
  const anyWiki = Object.values(topicTexts).some((t) => t.source === 'WIKIPEDIA');
  const primarySourceType = anyTavily ? 'TAVILY' : anyWiki ? 'WIKIPEDIA' : 'LINKS_ONLY';

  // Perform transactional persistence
  await prisma.$transaction(async (tx) => {
    // 1. Update SkillStep
    await tx.skillStep.update({
      where: { id: stepId },
      data: {
        resources: finalResources as any,
        status: hasUsableLinks ? 'STUDY_READY' : 'IN_PROGRESS',
        difficultyTier: tier,
      },
    });

    // 2. Upsert ContentDocument
    await tx.contentDocument.upsert({
      where: { stepId },
      create: {
        stepId,
        sourceType: primarySourceType,
        sourceTitle: step.title,
        sourceUrl: finalResources[0]?.url || null,
        markdown: fullMarkdown,
        quadrants: stepQuadrants,
        topicMap: finalTopicMap as any,
        approachBrief: approachBrief as any,
      },
      update: {
        sourceType: primarySourceType,
        sourceTitle: step.title,
        sourceUrl: finalResources[0]?.url || null,
        markdown: fullMarkdown,
        quadrants: stepQuadrants,
        topicMap: finalTopicMap as any,
        approachBrief: approachBrief as any,
      },
    });

    // 3. Upsert ResourceHistory
    for (const r of finalResources) {
      const identifier = r.videoId || normalizeUrl(r.url);
      try {
        await tx.resourceHistory.upsert({
          where: {
            workspaceId_identifier: {
              workspaceId,
              identifier,
            },
          },
          create: {
            profileId,
            workspaceId,
            stepIndex,
            resourceType: r.type === 'video' ? 'YOUTUBE_VIDEO' : 'DOC_URL',
            identifier,
          },
          update: {},
        });
      } catch (_) {}
    }
  });

  timings.S11_persist = Date.now() - t10;
  const totalTimeMs = Date.now() - startTime;

  return {
    status: 'STUDY_READY',
    tier,
    topicMap: finalTopicMap,
    resources: finalResources,
    approachBrief,
    timings,
    totalTimeMs,
  };
}
