import { prisma } from '../../lib/prisma';
import {
  LEARNING_CONFIG,
  tierForStep,
  TIER_QUERY_MODIFIERS,
  DifficultyTier,
} from '../../config/learning';
import {
  callGroqJson,
  searchTavily,
  extractYouTubeId,
  canonicalKey,
  registrableDomain,
  titleSimilarity,
  isSafePublicUrl,
  mapWithLimit,
  assertNoUrls,
  verifyLink,
  sharesLongRun,
  fetchWikipediaExtract,
  checkYouTube,
  LinkStatus,
  TavilySearchResult,
} from './foundation';
import { planCurriculumSpine } from './spine';

export interface ChapterApproachGuide {
  before: string;
  lookFor: string[];
  doWhile: string;
  afterCheck: string;
  ignore: string;
  timebox: string;
}

export interface StepApproachBrief {
  goal: string;
  whyNow: string;
  totalMinutes: number;
  order: Array<{ chapterKey: string; why: string }>;
  howToStudy: string[];
  commonMistakes: string[];
  selfCheck: Array<{ prompt: string; hint: string }>;
  masteryTarget?: { passPercent: number };
}

export interface ChapterAnchor {
  id: string;
  text: string;
  origin: 'SOURCE_TEXT' | 'CHAPTER_OBJECTIVE';
}

interface CandidateItem {
  index: number;
  kind: 'VIDEO' | 'DOCUMENT';
  title: string;
  url: string;
  domain: string;
  snippet: string;
  rawContent?: string;
  content: string;
  score: number;
  videoId?: string | null;
  channelName?: string;
}

export async function buildMilestoneCurriculum(stepId: string) {
  const step = await prisma.skillStep.findUnique({
    where: { id: stepId },
    include: {
      workspace: {
        include: {
          steps: { orderBy: { stepIndex: 'asc' } },
        },
      },
      chapters: { orderBy: { orderIndex: 'asc' } },
    },
  });

  if (!step) {
    throw new Error(`Step not found: ${stepId}`);
  }

  const workspace = step.workspace;
  const domain = ((workspace.domainCategory || (workspace as any).domain || '').toUpperCase().includes('SPORT')
    ? 'SPORT'
    : 'SKILL') as 'SKILL' | 'SPORT';
  const skill = workspace.title;
  const subGenre = (workspace as any).subGenre || '';

  // Ensure spine exists across all steps
  if (step.chapters.length === 0) {
    await planCurriculumSpine({
      workspaceId: workspace.id,
      domain,
      skill,
      subGenre,
    });
  }

  // Reload step chapters
  const chapters = await prisma.chapter.findMany({
    where: { stepId: step.id },
    orderBy: { orderIndex: 'asc' },
  });

  if (chapters.length === 0) {
    throw new Error('Curriculum spine generated no chapters for step');
  }

  // S1: Save Step.difficultyTier and load ResourceHistory
  const totalSteps = workspace.steps.length;
  const tier = tierForStep(step.stepIndex, totalSteps);

  // If regenerating step, delete this step's history rows first
  await prisma.resourceHistory.deleteMany({
    where: {
      workspaceId: workspace.id,
      stepIndex: step.stepIndex,
    },
  });

  const history = await prisma.resourceHistory.findMany({
    where: { workspaceId: workspace.id },
  });

  const historyIdentifiers = new Set(history.map((h) => h.identifier));
  const historyTitles = history.map((h) => h.title || '').filter(Boolean);

  // S2: RESEARCH, one search per chapter in parallel with SEARCH_CONCURRENCY
  const chapterCandidates = new Map<string, CandidateItem[]>();

  await mapWithLimit(chapters, LEARNING_CONFIG.SEARCH_CONCURRENCY, async (ch) => {
    const newConcepts = (ch.newConcepts as string[]) || [];
    const conceptsPart = newConcepts.slice(0, 2).join(' ');
    const queryModifier = TIER_QUERY_MODIFIERS[tier] || '';
    const isVideoPref = ch.preferredType === 'VIDEO';

    const baseQuery = `${skill} ${subGenre} ${ch.title} ${conceptsPart} ${queryModifier}`.trim();
    const query = `${baseQuery} ${isVideoPref ? 'tutorial' : 'guide'}`;

    let tavilyRes = await searchTavily(query, {
      searchDepth: isVideoPref ? 'basic' : 'advanced',
      maxResults: 6,
      includeDomains: isVideoPref ? ['youtube.com'] : undefined,
      includeRawContent: true,
    });

    // If Tavily returned nothing for DOCUMENT, try Wikipedia
    if (!isVideoPref && tavilyRes.length === 0) {
      const wiki = await fetchWikipediaExtract(ch.title);
      if (wiki) {
        tavilyRes = [
          {
            title: wiki.title,
            url: wiki.url,
            content: wiki.text.slice(0, 1000),
            rawContent: wiki.text,
            score: 0.9,
          },
        ];
      }
    }

    // If still nothing for preferred type, search for alternate type
    if (tavilyRes.length === 0) {
      const altQuery = `${baseQuery} ${isVideoPref ? 'guide' : 'tutorial'}`;
      tavilyRes = await searchTavily(altQuery, {
        searchDepth: isVideoPref ? 'advanced' : 'basic',
        maxResults: 6,
        includeDomains: isVideoPref ? undefined : ['youtube.com'],
        includeRawContent: true,
      });
    }

    // S3: CANDIDATE FILTER per chapter (Section 9 rules)
    const validCandidates: CandidateItem[] = [];
    for (const r of tavilyRes) {
      if (!r.url) continue;
      const key = canonicalKey(r.url);
      if (historyIdentifiers.has(key)) continue;
      if (!(await isSafePublicUrl(r.url))) continue;

      const ytId = extractYouTubeId(r.url);
      if (r.url.includes('youtube.com') && !ytId) continue;

      const sample = (r.rawContent || r.content || '').slice(0, 600);
      const isDeadSample =
        /(page not found|404 not found|no longer available|this video is unavailable|content (has been )?removed|does not exist)/i.test(
          sample
        );
      if (isDeadSample) continue;

      // Title similarity against history
      const hasDupTitle = historyTitles.some(
        (ht) => titleSimilarity(ht, r.title) >= LEARNING_CONFIG.TITLE_SIMILARITY_DUP
      );
      if (hasDupTitle) continue;

      validCandidates.push({
        index: validCandidates.length,
        kind: ytId ? 'VIDEO' : 'DOCUMENT',
        title: r.title,
        url: r.url,
        domain: registrableDomain(r.url),
        snippet: (r.content || '').slice(0, 220),
        rawContent: r.rawContent,
        content: r.content,
        score: r.score,
        videoId: ytId,
      });
    }

    chapterCandidates.set(ch.key, validCandidates);
  });

  // S4: RANKING BY INDEX (one Groq call for all chapters)
  const rankingPayload = chapters.map((ch) => ({
    chapterKey: ch.key,
    title: ch.title,
    covers: ch.covers,
    preferredType: ch.preferredType,
    candidates: (chapterCandidates.get(ch.key) || []).map((c, idx) => ({
      index: idx,
      kind: c.kind,
      title: c.title,
      domain: c.domain,
      snippet: c.snippet.slice(0, 160),
    })),
  }));

  const rankPromptSystem = `You are the Expert Educational Curator for SKILL-TRACK.
Rank the candidate resources for each chapter by index.
Criteria:
- Select sources that most directly and practically teach THIS chapter's specific topic at this difficulty tier (${tier}).
- Prefer high-reputation, authoritative, clear sources.
- Rank by candidate index number. Provide up to 3 preferred candidate indices in order.
- NO URLs anywhere in your output.

Return ONLY JSON:
{
  "picks": [
    { "chapterKey": "c1", "ranked": [0, 2, 1] }
  ]
}`;

  let rankingPicks: Array<{ chapterKey: string; ranked: number[] }> = [];
  try {
    const rankResult = await callGroqJson<{ picks: Array<{ chapterKey: string; ranked: number[] }> }>(
      rankPromptSystem,
      JSON.stringify({ tier, chapters: rankingPayload }),
      {
        validate: (data: any) => {
          assertNoUrls(data, 'Ranking');
          if (!data || !Array.isArray(data.picks)) throw new Error('Missing picks array');
          return data;
        },
        maxTokens: 1200,
        temperature: 0.1,
      }
    );
    rankingPicks = rankResult.picks;
  } catch (err: any) {
    console.warn('[curriculum] Groq ranking by index failed, falling back to Tavily scores:', err.message);
    rankingPicks = chapters.map((ch) => ({
      chapterKey: ch.key,
      ranked: (chapterCandidates.get(ch.key) || []).map((_, i) => i),
    }));
  }

  // S5 & S6: ASSIGNMENT IN CODE + LINK VERIFICATION
  const assignedResources = new Map<
    string,
    {
      candidate: CandidateItem;
      linkStatus: LinkStatus;
      embeddable: boolean;
      channelName?: string;
    }
  >();

  const stepUsedCanonicalKeys = new Set<string>();
  const domainCounts = new Map<string, number>();
  const channelCounts = new Map<string, number>();

  for (const ch of chapters) {
    const candidates = chapterCandidates.get(ch.key) || [];
    const pickInfo = rankingPicks.find((p) => p.chapterKey === ch.key);
    const rankedIndices = pickInfo ? pickInfo.ranked : candidates.map((_, i) => i);

    let assigned: {
      candidate: CandidateItem;
      linkStatus: LinkStatus;
      embeddable: boolean;
      channelName?: string;
    } | null = null;

    for (const idx of rankedIndices) {
      const c = candidates[idx];
      if (!c) continue;

      const key = canonicalKey(c.url);
      if (stepUsedCanonicalKeys.has(key)) continue;

      // Check domain cap
      const dom = c.domain;
      const curDomCount = domainCounts.get(dom) || 0;
      if (dom !== 'youtube.com' && curDomCount >= LEARNING_CONFIG.MAX_PER_DOMAIN_PER_STEP) {
        continue;
      }

      // Check channel cap for YouTube
      let channelName: string | undefined;
      let embeddable = true;

      if (c.videoId) {
        const ytInfo = await checkYouTube(c.videoId);
        if (ytInfo.status === 'GONE') continue;
        if (ytInfo.status === 'NO_EMBED') embeddable = false;
        channelName = ytInfo.channel;
        if (channelName) {
          const curChCount = channelCounts.get(channelName) || 0;
          if (curChCount >= LEARNING_CONFIG.MAX_PER_CHANNEL_PER_STEP) continue;
        }
      }

      // Link verification
      const verified = await verifyLink(c.url, (c.rawContent || c.content).slice(0, 600));
      if (verified.status === 'DEAD') {
        continue;
      }

      assigned = {
        candidate: { ...c, url: verified.finalUrl },
        linkStatus: verified.status,
        embeddable,
        channelName,
      };

      stepUsedCanonicalKeys.add(key);
      domainCounts.set(dom, curDomCount + 1);
      if (channelName) {
        channelCounts.set(channelName, (channelCounts.get(channelName) || 0) + 1);
      }
      break;
    }

    if (assigned) {
      assignedResources.set(ch.key, assigned);
    }
  }

  // S7: KEY IDEAS ("anchors" for the quiz foundation, R6)
  const anchorChaptersInput = chapters.map((ch) => {
    const assigned = assignedResources.get(ch.key);
    let transientSource = '';
    if (assigned) {
      const text = assigned.candidate.rawContent || assigned.candidate.content || '';
      if (text.length >= LEARNING_CONFIG.MIN_ANCHOR_SOURCE_CHARS) {
        transientSource = text.slice(0, LEARNING_CONFIG.SOURCE_CHARS_PER_CHAPTER);
      }
    }
    const stepAcusRaw = (Array.isArray(step.assessableUnits) ? step.assessableUnits : []) as Array<{ id: string; label?: string; description?: string }>;
    const acus = stepAcusRaw.filter((a) => (ch.acuIds as string[]).includes(a.id));
    return {
      chapterKey: ch.key,
      title: ch.title,
      covers: ch.covers,
      acuDescriptions: acus.map((a) => a.description || a.label || '').join('. '),
      hasSourceText: transientSource.length >= LEARNING_CONFIG.MIN_ANCHOR_SOURCE_CHARS,
      transientSource,
    };
  });

  const anchorPromptSystem = `You are the Principal Psychometric Anchor Writer for SKILL-TRACK.
Write testable key ideas (anchors) for each chapter.
For each chapter:
- Generate between ${LEARNING_CONFIG.ANCHORS_MIN_PER_CHAPTER} and ${LEARNING_CONFIG.ANCHORS_MAX_PER_CHAPTER} anchors.
- Each anchor MUST be ONE self-contained, testable statement (a principle, biomechanic, trap, common mistake, or rule).
- Maximum 30 words per anchor.
- Written in your own original words. Facts and ideas only.
- NO URLs. NO quotes. NEVER say "the author says", "the video shows", "the document explains".
- If source text is provided: ground anchors strictly in the concepts from that source text.
- If no source text is provided: restate the chapter's title/covers/ACUs as objective factual statements.

Return ONLY JSON:
{
  "chapters": [
    {
      "chapterKey": "c1",
      "anchors": [
        { "text": "..." }
      ]
    }
  ]
}`;

  let anchorOutput: Array<{ chapterKey: string; anchors: Array<{ text: string }> }> = [];
  try {
    const res = await callGroqJson<{
      chapters: Array<{ chapterKey: string; anchors: Array<{ text: string }> }>;
    }>(
      anchorPromptSystem,
      JSON.stringify({
        tier,
        chapters: anchorChaptersInput.map((c) => ({
          chapterKey: c.chapterKey,
          title: c.title,
          covers: c.covers,
          acuDescriptions: c.acuDescriptions,
          sourceExcerpt: c.transientSource,
        })),
      }),
      {
        validate: (data: any) => {
          assertNoUrls(data, 'Anchors');
          if (!data || !Array.isArray(data.chapters)) throw new Error('Missing chapters in anchor result');
          return data;
        },
        maxTokens: 2500,
        temperature: 0.15,
      }
    );
    anchorOutput = res.chapters;
  } catch (err: any) {
    console.warn('[curriculum] Groq anchor generation failed, creating objective anchors in code:', err.message);
    anchorOutput = anchorChaptersInput.map((c) => ({
      chapterKey: c.chapterKey,
      anchors: [
        { text: `${c.title} requires mastering ${c.covers}` },
        { text: `Effective execution avoids common early mistakes in ${c.title}` },
        { text: `Consistent technique in ${c.title} establishes reliable performance under pressure` },
      ],
    }));
  }

  // Paraphrase guard validation and anchor formatting
  const chapterAnchorsMap = new Map<string, ChapterAnchor[]>();
  for (const chInput of anchorChaptersInput) {
    const rawChapterAnchors = anchorOutput.find((o) => o.chapterKey === chInput.chapterKey)?.anchors || [];
    const processedAnchors: ChapterAnchor[] = [];

    let aIdx = 1;
    for (const rawA of rawChapterAnchors) {
      let text = (rawA.text || '').trim();
      if (!text) continue;

      if (chInput.hasSourceText && sharesLongRun(chInput.transientSource, text)) {
        // Rewrite once in model's own words or drop
        continue;
      }

      processedAnchors.push({
        id: `${chInput.chapterKey}-a${aIdx++}`,
        text,
        origin: chInput.hasSourceText ? 'SOURCE_TEXT' : 'CHAPTER_OBJECTIVE',
      });
    }

    if (processedAnchors.length === 0) {
      processedAnchors.push({
        id: `${chInput.chapterKey}-a1`,
        text: `Fundamental principles of ${chInput.title} govern proper execution`,
        origin: 'CHAPTER_OBJECTIVE',
      });
    }

    chapterAnchorsMap.set(chInput.chapterKey, processedAnchors);
  }

  // S8: GUIDES (Game plan + Chapter approach guides)
  const guideChaptersPayload = chapters.map((ch) => {
    const assigned = assignedResources.get(ch.key);
    return {
      chapterKey: ch.key,
      title: ch.title,
      covers: ch.covers,
      resourceType: assigned?.candidate.kind || ch.preferredType,
      resourceTitle: assigned?.candidate.title || ch.title,
      resourceSnippet: (assigned?.candidate.snippet || '').slice(0, 160),
    };
  });

  const guidesPromptSystem = `You are the Lead Master Coach and Pedagogy Expert for SKILL-TRACK.
Create the step game plan and individual chapter approach guides.
Domain: ${domain}
Tier: ${tier}

REQUIREMENTS:
1. Step Approach Brief:
   - "goal": concise statement of what this milestone accomplishes
   - "whyNow": why this tier follows the previous level
   - "order": array of { chapterKey, why } for each chapter
   - "howToStudy": exactly 3 active techniques fitted to ${domain}
   - "commonMistakes": 2-4 concrete mistakes to avoid
   - "selfCheck": 3 ungraded checks { prompt, hint }
2. For each chapter, "approachGuide":
   - "before": one sentence: what to hold in mind before opening
   - "lookFor": array of 2-3 specific things to watch/listen for
   - "doWhile": active task while consuming (Science = predict then derive; Sport = mimic drill/check form; Code = write sample)
   - "afterCheck": one reflection question to answer in learner's own words
   - "ignore": what to skim or ignore
   - "timebox": duration e.g. "10 min"
   - Every field max 25 words. Plain direct tone.
   - NO URLs. NO timestamps (never output mm:ss format).
   - NEVER invent claims about video or document content not in title/snippet.

Return ONLY JSON:
{
  "approachBrief": {
    "goal": "...",
    "whyNow": "...",
    "order": [ { "chapterKey": "c1", "why": "..." } ],
    "howToStudy": ["...", "...", "..."],
    "commonMistakes": ["...", "..."],
    "selfCheck": [ { "prompt": "...", "hint": "..." } ]
  },
  "chapterGuides": [
    {
      "chapterKey": "c1",
      "guide": {
        "before": "...",
        "lookFor": ["...", "..."],
        "doWhile": "...",
        "afterCheck": "...",
        "ignore": "...",
        "timebox": "10 min"
      }
    }
  ]
}`;

  let approachBriefData: StepApproachBrief | null = null;
  const chapterGuidesMap = new Map<string, ChapterApproachGuide>();

  try {
    const guidesRes = await callGroqJson<{
      approachBrief: any;
      chapterGuides: Array<{ chapterKey: string; guide: ChapterApproachGuide }>;
    }>(
      guidesPromptSystem,
      JSON.stringify({ skill, subGenre, tier, chapters: guideChaptersPayload }),
      {
        validate: (data: any) => {
          assertNoUrls(data, 'Guides');
          const jsonStr = JSON.stringify(data);
          if (/\b\d{1,2}:\d{2}\b/.test(jsonStr)) {
            throw new Error('Guide output contained timestamp format');
          }
          if (!data || !data.approachBrief || !Array.isArray(data.chapterGuides)) {
            throw new Error('Missing approachBrief or chapterGuides');
          }
          return data;
        },
        maxTokens: 3000,
        temperature: 0.2,
      }
    );

    const totalMinutes = chapters.reduce((acc, c) => acc + c.minutes, 0);
    approachBriefData = {
      ...guidesRes.approachBrief,
      totalMinutes,
      masteryTarget: { passPercent: LEARNING_CONFIG.PASS_THRESHOLD_PERCENT },
    };

    for (const cg of guidesRes.chapterGuides) {
      chapterGuidesMap.set(cg.chapterKey, cg.guide);
    }
  } catch (err: any) {
    console.warn('[curriculum] Groq guide generation failed (non-fatal, storing null):', err.message);
  }

  // S9: PERSIST in one database transaction
  let hasAtLeastOneUsableLink = false;

  await prisma.$transaction(async (tx) => {
    // 1. Update Step difficultyTier and approachBrief
    await tx.skillStep.update({
      where: { id: step.id },
      data: {
        difficultyTier: tier,
        approachBrief: (approachBriefData as any) || undefined,
      },
    });

    // 2. Delete existing resources attached to these chapters
    const chapterIds = chapters.map((c) => c.id);
    await tx.resource.deleteMany({
      where: {
        chapterId: { in: chapterIds },
      },
    });

    // 3. Update chapters and create primary resources
    for (const ch of chapters) {
      const assigned = assignedResources.get(ch.key);
      const anchors = chapterAnchorsMap.get(ch.key) || [];
      const guide = chapterGuidesMap.get(ch.key) || null;

      let status = 'NO_VERIFIED_LINK';
      if (assigned) {
        status = 'READY';
        hasAtLeastOneUsableLink = true;

        const candidate = assigned.candidate;
        const key = canonicalKey(candidate.url);

        // Create Resource row
        await tx.resource.create({
          data: {
            stepId: step.id,
            chapterId: ch.id,
            type: candidate.kind === 'VIDEO' ? 'video' : 'doc',
            title: candidate.title,
            url: candidate.url,
            domain: candidate.domain,
            videoId: candidate.videoId || null,
            channelName: assigned.channelName || null,
            canonicalKey: key,
            snippet: candidate.snippet.slice(0, LEARNING_CONFIG.SNIPPET_MAX_CHARS),
            embeddable: assigned.embeddable,
            linkStatus: assigned.linkStatus,
            isPrimary: true,
            checkedAt: new Date(),
          },
        });

        // Add to ResourceHistory
        await tx.resourceHistory.upsert({
          where: {
            workspaceId_identifier: {
              workspaceId: workspace.id,
              identifier: key,
            },
          },
          create: {
            profileId: workspace.profileId || (workspace as any).userProfileId || 'default-profile',
            workspaceId: workspace.id,
            stepIndex: step.stepIndex,
            resourceType: candidate.kind === 'VIDEO' ? 'YOUTUBE_VIDEO' : 'DOC_URL',
            identifier: key,
            title: candidate.title,
            domain: candidate.domain,
          },
          update: {
            stepIndex: step.stepIndex,
            title: candidate.title,
            domain: candidate.domain,
          },
        });
      }

      await tx.chapter.update({
        where: { id: ch.id },
        data: {
          status,
          anchors: anchors as any,
          approachGuide: guide as any,
        },
      });
    }

    // Set step STUDY_READY if at least one usable link
    if (hasAtLeastOneUsableLink) {
      await tx.skillStep.update({
        where: { id: step.id },
        data: { status: 'STUDY_READY' },
      });
    }
  });

  if (!hasAtLeastOneUsableLink) {
    return {
      status: 'NO_SOURCE_FOUND',
      message: 'No verified source found — Retry',
    };
  }

  return getStepGuide(step.id);
}

// 8.3 GET STEP GUIDE
export async function getStepGuide(stepId: string, lang = 'en') {
  const step = await prisma.skillStep.findUnique({
    where: { id: stepId },
    include: {
      workspace: {
        include: {
          steps: { orderBy: { stepIndex: 'asc' } },
        },
      },
      chapters: {
        orderBy: { orderIndex: 'asc' },
        include: {
          resources: {
            where: { isPrimary: true },
          },
        },
      },
    },
  });

  if (!step) {
    throw new Error(`Step not found: ${stepId}`);
  }

  const totalSteps = step.workspace.steps.length;
  const tier = step.difficultyTier || tierForStep(step.stepIndex, totalSteps);

  // Check TranslationCache if lang !== 'en'
  let translatedPayload: any = null;
  if (lang !== 'en') {
    const cacheRow = await prisma.translationCache.findUnique({
      where: {
        scope_scopeId_languageCode: {
          scope: 'STEP_BOOK',
          scopeId: step.id,
          languageCode: lang,
        },
      },
    });
    if (cacheRow) {
      translatedPayload = cacheRow.payload;
    }
  }

  const chapters = step.chapters.map((ch) => {
    const res = ch.resources[0];
    const transCh = translatedPayload?.chapters?.find((c: any) => c.key === ch.key);

    return {
      id: ch.id,
      key: ch.key,
      orderIndex: ch.orderIndex,
      title: transCh?.title || ch.title,
      covers: transCh?.covers || ch.covers,
      minutes: ch.minutes,
      acuIds: (ch.acuIds as string[]) || [],
      preferredType: ch.preferredType,
      buildsOn: transCh?.buildsOn || ch.buildsOn,
      newConcepts: transCh?.newConcepts || (ch.newConcepts as string[]) || [],
      status: ch.status,
      approachGuide: transCh?.approachGuide || (ch.approachGuide as any) || null,
      resource: res
        ? {
            id: res.id,
            type: res.type,
            title: res.title,
            url: res.url,
            domain: res.domain,
            snippet: res.snippet,
            linkStatus: res.linkStatus,
            embeddable: res.embeddable,
            videoId: res.videoId,
            channelName: res.channelName,
          }
        : null,
    };
  });

  return {
    step: {
      id: step.id,
      title: translatedPayload?.stepTitle || step.title,
      tier,
      index: step.stepIndex,
      total: totalSteps,
    },
    chapters,
    approachBrief: translatedPayload?.approachBrief || (step.approachBrief as any) || null,
    approachViewedAt: step.approachViewedAt,
    translated: Boolean(translatedPayload),
    languageCode: lang,
  };
}

// 8.3 RETRY CHAPTER RESOURCE
export async function retryChapterResource(chapterId: string) {
  const chapter = await prisma.chapter.findUnique({
    where: { id: chapterId },
    include: {
      step: {
        include: {
          workspace: {
            include: { steps: { orderBy: { stepIndex: 'asc' } } },
          },
        },
      },
      resources: true,
    },
  });

  if (!chapter) {
    throw new Error(`Chapter not found: ${chapterId}`);
  }

  const step = chapter.step;
  const workspace = step.workspace;
  const tier = step.difficultyTier || tierForStep(step.stepIndex, workspace.steps.length);
  const isVideo = chapter.preferredType === 'VIDEO';

  const history = await prisma.resourceHistory.findMany({
    where: { workspaceId: workspace.id },
  });
  const historyIdentifiers = new Set(history.map((h) => h.identifier));

  const query = `${workspace.title} ${chapter.title} ${TIER_QUERY_MODIFIERS[tier as DifficultyTier] || ''} ${isVideo ? 'tutorial' : 'guide'}`;
  const results = await searchTavily(query, {
    searchDepth: isVideo ? 'basic' : 'advanced',
    maxResults: 6,
    includeDomains: isVideo ? ['youtube.com'] : undefined,
    includeRawContent: true,
  });

  for (const r of results) {
    const key = canonicalKey(r.url);
    if (historyIdentifiers.has(key)) continue;
    if (!(await isSafePublicUrl(r.url))) continue;

    const ytId = extractYouTubeId(r.url);
    if (isVideo && !ytId) continue;

    let embeddable = true;
    let channelName: string | undefined;
    if (ytId) {
      const yt = await checkYouTube(ytId);
      if (yt.status === 'GONE') continue;
      if (yt.status === 'NO_EMBED') embeddable = false;
      channelName = yt.channel;
    }

    const verified = await verifyLink(r.url, (r.rawContent || r.content).slice(0, 600));
    if (verified.status === 'DEAD') continue;

    // Delete existing resources on this chapter
    await prisma.resource.deleteMany({
      where: { chapterId: chapter.id },
    });

    // Create new primary resource
    const newRes = await prisma.resource.create({
      data: {
        stepId: step.id,
        chapterId: chapter.id,
        type: ytId ? 'video' : 'doc',
        title: r.title,
        url: verified.finalUrl,
        domain: registrableDomain(r.url),
        videoId: ytId || null,
        channelName: channelName || null,
        canonicalKey: key,
        snippet: (r.content || '').slice(0, LEARNING_CONFIG.SNIPPET_MAX_CHARS),
        embeddable,
        linkStatus: verified.status,
        isPrimary: true,
        checkedAt: new Date(),
      },
    });

    await prisma.resourceHistory.upsert({
      where: {
        workspaceId_identifier: {
          workspaceId: workspace.id,
          identifier: key,
        },
      },
      create: {
        profileId: workspace.profileId || (workspace as any).userProfileId || 'default-profile',
        workspaceId: workspace.id,
        stepIndex: step.stepIndex,
        resourceType: ytId ? 'YOUTUBE_VIDEO' : 'DOC_URL',
        identifier: key,
        title: r.title,
        domain: registrableDomain(r.url),
      },
      update: {
        stepIndex: step.stepIndex,
        title: r.title,
        domain: registrableDomain(r.url),
      },
    });

    await prisma.chapter.update({
      where: { id: chapter.id },
      data: { status: 'READY' },
    });

    return { success: true, resource: newRes };
  }

  return { success: false, message: 'No verified replacement link found' };
}

// 8.3 REPLACE RESOURCE ("Link broken? Replace")
export async function replaceResource(resourceId: string) {
  const resource = await prisma.resource.findUnique({
    where: { id: resourceId },
    include: {
      chapter: {
        include: {
          step: {
            include: {
              workspace: {
                include: { steps: { orderBy: { stepIndex: 'asc' } } },
              },
            },
          },
        },
      },
    },
  });

  if (!resource || !resource.chapter) {
    throw new Error('Resource or parent chapter not found');
  }

  // Mark existing resource as DEAD
  await prisma.resource.update({
    where: { id: resource.id },
    data: { linkStatus: 'DEAD' },
  });

  // Re-run search and replace via retryChapterResource
  const retryResult = await retryChapterResource(resource.chapter.id);
  if (!retryResult.success) {
    throw new Error(retryResult.message || 'Could not find a valid replacement resource');
  }

  return retryResult;
}

// 8.3 GENERATE ONLY GUIDES
export async function generateStepApproach(stepId: string) {
  const step = await prisma.skillStep.findUnique({
    where: { id: stepId },
    include: {
      workspace: { include: { steps: { orderBy: { stepIndex: 'asc' } } } },
      chapters: {
        orderBy: { orderIndex: 'asc' },
        include: { resources: { where: { isPrimary: true } } },
      },
    },
  });

  if (!step) throw new Error('Step not found');

  const domain = (((step.workspace as any).domainCategory || (step.workspace as any).domain || '').toUpperCase().includes('SPORT')
    ? 'SPORT'
    : 'SKILL') as 'SKILL' | 'SPORT';
  const tier = step.difficultyTier || tierForStep(step.stepIndex, step.workspace.steps.length);

  const guideChaptersPayload = step.chapters.map((ch) => {
    const res = ch.resources[0];
    return {
      chapterKey: ch.key,
      title: ch.title,
      covers: ch.covers,
      resourceType: res?.type || ch.preferredType,
      resourceTitle: res?.title || ch.title,
      resourceSnippet: (res?.snippet || '').slice(0, 160),
    };
  });

  const guidesPromptSystem = `You are the Lead Master Coach and Pedagogy Expert for SKILL-TRACK.
Create the step game plan and individual chapter approach guides.
Domain: ${domain}
Tier: ${tier}

REQUIREMENTS:
1. Step Approach Brief:
   - "goal": concise statement of what this milestone accomplishes
   - "whyNow": why this tier follows the previous level
   - "order": array of { chapterKey, why } for each chapter
   - "howToStudy": exactly 3 active techniques fitted to ${domain}
   - "commonMistakes": 2-4 concrete mistakes to avoid
   - "selfCheck": 3 ungraded checks { prompt, hint }
2. For each chapter, "approachGuide":
   - "before": one sentence: what to hold in mind before opening
   - "lookFor": array of 2-3 specific things to watch/listen for
   - "doWhile": active task while consuming
   - "afterCheck": one reflection question to answer
   - "ignore": what to skim or ignore
   - "timebox": duration e.g. "10 min"
   - Every field max 25 words. Plain direct tone.
   - NO URLs. NO timestamps.

Return ONLY JSON:
{
  "approachBrief": {
    "goal": "...",
    "whyNow": "...",
    "order": [ { "chapterKey": "c1", "why": "..." } ],
    "howToStudy": ["...", "...", "..."],
    "commonMistakes": ["...", "..."],
    "selfCheck": [ { "prompt": "...", "hint": "..." } ]
  },
  "chapterGuides": [
    {
      "chapterKey": "c1",
      "guide": {
        "before": "...",
        "lookFor": ["...", "..."],
        "doWhile": "...",
        "afterCheck": "...",
        "ignore": "...",
        "timebox": "10 min"
      }
    }
  ]
}`;

  const guidesRes = await callGroqJson<{
    approachBrief: any;
    chapterGuides: Array<{ chapterKey: string; guide: ChapterApproachGuide }>;
  }>(
    guidesPromptSystem,
    JSON.stringify({ skill: step.workspace.title, tier, chapters: guideChaptersPayload }),
    {
      validate: (data: any) => {
        assertNoUrls(data, 'Guides');
        const jsonStr = JSON.stringify(data);
        if (/\b\d{1,2}:\d{2}\b/.test(jsonStr)) {
          throw new Error('Guide output contained timestamp format');
        }
        return data;
      },
      maxTokens: 3000,
      temperature: 0.2,
    }
  );

  const totalMinutes = step.chapters.reduce((acc, c) => acc + c.minutes, 0);
  const approachBrief = {
    ...guidesRes.approachBrief,
    totalMinutes,
    masteryTarget: { passPercent: LEARNING_CONFIG.PASS_THRESHOLD_PERCENT },
  };

  await prisma.skillStep.update({
    where: { id: step.id },
    data: { approachBrief: approachBrief as any },
  });

  for (const cg of guidesRes.chapterGuides) {
    const ch = step.chapters.find((c) => c.key === cg.chapterKey);
    if (ch) {
      await prisma.chapter.update({
        where: { id: ch.id },
        data: { approachGuide: cg.guide as any },
      });
    }
  }

  return getStepGuide(step.id);
}

// 8.3 MARK APPROACH VIEWED
export async function markApproachViewed(stepId: string) {
  return prisma.skillStep.update({
    where: { id: stepId },
    data: { approachViewedAt: new Date() },
  });
}
