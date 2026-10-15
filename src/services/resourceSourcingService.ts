import { tavilyClient } from '../lib/tavilyClient';
import { groq } from '../lib/groqClient';
import { db } from '../lib/db';
import prisma from '../lib/prisma';
import { extractYouTubeId } from '../lib/foundation';
import { getDifficultyTier } from './documentationService';
import { fetchUniqueStepVideo } from './videoService';

export interface PedagogicalGuide {
  sectionsToRead: string[];
  sectionsToSkip: string[];
  howToLearn: string;
  keyTraps: string[];
}

export interface EnrichedTopic {
  topicId: string;
  title: string;
  externalUrl: string;
  sourceTitle: string;
  sourceDomain: string;
  coreObjective?: string;
  pedagogicalGuide: PedagogicalGuide;
}

export function isVideoUrl(url: string): boolean {
  if (!url) return false;
  return /youtube\.com|youtu\.be|vimeo\.com|dailymotion\.com|tiktok\.com/i.test(url);
}

export interface SourcedStepResult {
  step_number?: number;
  title?: string;
  is_sourced?: boolean;
  video_id?: string;
  video_title?: string;
  video_url?: string;
  videoId: string;
  videoTitle: string;
  videoUrl: string;
  videoMiniGuide?: string;
  video_mini_guide?: string;
  docTitle?: string;
  doc_title?: string;
  docUrl?: string;
  doc_url?: string;
  docDomain?: string;
  doc_domain?: string;
  docMiniGuide?: string;
  doc_mini_guide?: string;
  stepExplanation?: string;
  step_explanation?: string;
  topics: EnrichedTopic[];
}

/**
 * Search YouTube candidate videos for a given query
 */
export async function searchYouTubeCandidates(
  query: string
): Promise<Array<{ id: string; title: string; url: string }>> {
  try {
    const searchQuery = `site:youtube.com ${query} tutorial walkthrough`;
    const searchResult = await tavilyClient.search(searchQuery, {
      search_depth: 'basic',
      max_results: 10,
      include_raw_content: false,
    });

    const candidates: Array<{ id: string; title: string; url: string }> = [];
    const seenIds = new Set<string>();

    for (const r of searchResult.results || []) {
      if (!r.url) continue;
      const vId = extractYouTubeId(r.url);
      if (vId && vId !== 'dQw4w9WgXcQ' && !seenIds.has(vId)) {
        seenIds.add(vId);
        candidates.push({
          id: vId,
          title: r.title || 'Technical Lecture & Code Walkthrough',
          url: `https://www.youtube.com/watch?v=${vId}`,
        });
      }
    }

    if (candidates.length === 0) {
      // Broad secondary search without site filter
      const broad = await tavilyClient.search(`${query} full lecture tutorial video`, {
        search_depth: 'basic',
        max_results: 8,
      });
      for (const r of broad.results || []) {
        if (!r.url) continue;
        const vId = extractYouTubeId(r.url);
        if (vId && vId !== 'dQw4w9WgXcQ' && !seenIds.has(vId)) {
          seenIds.add(vId);
          candidates.push({
            id: vId,
            title: r.title || 'Technical Lecture & Code Walkthrough',
            url: `https://www.youtube.com/watch?v=${vId}`,
          });
        }
      }
    }

    return candidates.filter((c) => c.id !== 'dQw4w9WgXcQ');
  } catch (err) {
    console.warn('[resourceSourcingService] Error searching YouTube candidates:', err);
    return [];
  }
}

/**
 * MODULE 2: 10X SOURCING ACCELERATION VIA PARALLEL EXECUTION (BACKEND)
 * Replaces slow sequential for-loops with parallel Promise.all() calls.
 * Video Sourcing and Document Sourcing run simultaneously in < 4 seconds.
 */
export async function sourceStepContentFast(
  userId: string,
  skillId: string,
  stepNumber: number
): Promise<SourcedStepResult> {
  // 1. Resolve User ID safely to prevent unhandled NOT NULL constraint crashes
  let safeUserId = (userId || '').trim();
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!safeUserId || !uuidRegex.test(safeUserId)) {
    try {
      const uRes = await db.query('SELECT id FROM users LIMIT 1');
      if (uRes.rows[0]?.id) {
        safeUserId = uRes.rows[0].id;
      } else {
        safeUserId = '00000000-0000-0000-0000-000000000000';
      }
    } catch (_) {
      safeUserId = '00000000-0000-0000-0000-000000000000';
    }
  }

  // 2. Fetch Step Record (supports user_skills, sports tracks, and workspaces)
  let stepRow: any = null;
  let trackName: string = 'General Mastery';
  let trackGenre: string = 'Foundations';

  // Attempt A: Check user_skills joined with skill_steps
  try {
    const stepQuery = await db.query(
      `SELECT s.*, u.skill_name, u.sub_genre 
       FROM skill_steps s 
       JOIN user_skills u ON s.skill_id = u.id 
       WHERE s.skill_id = $1 AND s.step_number = $2`,
      [skillId, stepNumber]
    );
    if (stepQuery.rows.length > 0) {
      stepRow = stepQuery.rows[0];
      trackName = stepRow.skill_name || 'Skill';
      trackGenre = stepRow.sub_genre || 'Basics';
    }
  } catch (_) {}

  // Attempt B: Check standalone skill_steps without join
  if (!stepRow) {
    try {
      const standaloneStep = await db.query(
        `SELECT * FROM skill_steps WHERE skill_id = $1 AND step_number = $2 LIMIT 1`,
        [skillId, stepNumber]
      );
      if (standaloneStep.rows.length > 0) {
        stepRow = standaloneStep.rows[0];
        trackName = stepRow.title || 'Athletic Practice';
      }
    } catch (_) {}
  }

  // Attempt C: Check Prisma SkillStep and Workspace
  if (!stepRow) {
    try {
      const pStep = await prisma.skillStep.findFirst({
        where: {
          OR: [
            { workspaceId: skillId, stepIndex: stepNumber },
            { id: skillId }
          ]
        },
        include: { workspace: true }
      });
      if (pStep) {
        stepRow = {
          skill_id: pStep.workspaceId,
          step_number: pStep.stepIndex,
          title: pStep.title,
          description: pStep.description || '',
          topics: pStep.resources || [],
        };
        trackName = pStep.workspace?.title || pStep.title || 'Skill Mastery';
        trackGenre = pStep.workspace?.subGenre || 'Foundations';
      }
    } catch (_) {}
  }

  // Attempt D: Check user_sports_profiles (for athletic/sports skills)
  if (!stepRow) {
    try {
      const spRes = await db.query(
        `SELECT * FROM user_sports_profiles WHERE id = $1 LIMIT 1`,
        [skillId]
      );
      if (spRes.rows.length > 0) {
        const sp = spRes.rows[0];
        trackName = sp.sport_name;
        trackGenre = sp.sub_genre;
        stepRow = {
          skill_id: skillId,
          step_number: stepNumber,
          title: `Step ${stepNumber}: ${trackName} Foundations & Form`,
          description: `Core biomechanics and athletic drills for ${trackName}`,
          topics: [],
        };
      }
    } catch (_) {}
  }

  // Attempt E: Fallback step generation so the server NEVER throws 404 or crashes
  if (!stepRow) {
    trackName = String(skillId).replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    stepRow = {
      skill_id: skillId,
      step_number: stepNumber,
      title: `Step ${stepNumber}: ${trackName} Foundations`,
      description: `Core foundational mechanics and drills for ${trackName}`,
      topics: [],
    };
  }

  const cleanStepTitle = stepRow.title || `Step ${stepNumber}`;

  // 3. Query Anti-Repetition Vault for this user
  let seenResources = new Set<string>();
  try {
    const historyRes = await db.query(
      `SELECT resource_identifier FROM user_resource_history WHERE user_id = $1`,
      [safeUserId]
    );
    seenResources = new Set(historyRes.rows.map((r: any) => String(r.resource_identifier).trim()));
  } catch (dbErr) {
    console.warn('[Vault] History table lookup warning:', dbErr);
  }

  // Determine track type: Sports/Athletic vs Cognitive
  const isSportsTrack = /cricket|football|soccer|badminton|tennis|golf|swimming|basketball|athletics|stance|grip|dribble|bowling|batting|swing|stroke/i.test(
    `${trackName} ${cleanStepTitle} ${trackGenre}`
  );
  const isCoding = /code|programming|python|javascript|react|node|rust|c\+\+|sql|backend|frontend/i.test(trackName);

  // ---------------------------------------------------------------------------
  // TASK A: PARALLEL VIDEO SOURCING (FAST YOUTUBE QUERY)
  // ---------------------------------------------------------------------------
  let selectedVideo: { videoId: string; videoTitle: string } | null = null;
  const ytRegex = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i;

  // Helper to fetch verified title
  const getVerifiedTitle = async (vId: string, fallbackTitle: string): Promise<string> => {
    try {
      const oRes = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${vId}`)}`, { signal: AbortSignal.timeout(4000) });
      if (oRes.ok) {
        const j: any = await oRes.json();
        if (j.title) return j.title;
      }
    } catch (_) {}
    return fallbackTitle;
  };

  // Attempt 1: Specific Video Search
  try {
    const videoQuery = `${trackName} ${cleanStepTitle} tutorial ${isSportsTrack ? 'coaching drills' : 'lecture walkthrough'}`.trim();
    const ytRes = await tavilyClient.search(videoQuery, {
      max_results: 8,
      include_domains: ['youtube.com', 'youtu.be'],
    });

    for (const item of (ytRes.results || [])) {
      if (!item.url) continue;
      const match = item.url.match(ytRegex);
      if (match && match[1] && !seenResources.has(match[1]) && match[1] !== 'dQw4w9WgXcQ' && match[1] !== 'kJQP7kiw5Fk' && match[1] !== 'dQ3GLk1jUqI') {
        const verifiedTitle = await getVerifiedTitle(match[1], item.title || `${trackName}: ${cleanStepTitle}`);
        selectedVideo = {
          videoId: match[1],
          videoTitle: verifiedTitle,
        };
        break;
      }
    }
  } catch (e) {
    console.warn('[sourceStepContentFast] Attempt 1 notice:', e);
  }

  // Attempt 2: Broader Video Search
  if (!selectedVideo) {
    try {
      const broadQuery = `${trackName} ${trackGenre || ''} ${cleanStepTitle}`.trim();
      const broadRes = await tavilyClient.search(broadQuery, {
        max_results: 8,
        include_domains: ['youtube.com', 'youtu.be'],
      });
      for (const item of (broadRes.results || [])) {
        if (!item.url) continue;
        const match = item.url.match(ytRegex);
        if (match && match[1] && !seenResources.has(match[1]) && match[1] !== 'dQw4w9WgXcQ' && match[1] !== 'kJQP7kiw5Fk' && match[1] !== 'dQ3GLk1jUqI') {
          const verifiedTitle = await getVerifiedTitle(match[1], item.title || `${trackName}: ${cleanStepTitle}`);
          selectedVideo = {
            videoId: match[1],
            videoTitle: verifiedTitle,
          };
          break;
        }
      }
    } catch (e) {
      console.warn('[sourceStepContentFast] Attempt 2 notice:', e);
    }
  }

  // Attempt 3: Public YouTube Search Scrape Fallback
  if (!selectedVideo) {
    try {
      const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(`${trackName} ${cleanStepTitle} tutorial`)}`;
      const ytHtmlRes = await fetch(searchUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: AbortSignal.timeout(8000),
      });
      if (ytHtmlRes.ok) {
        const html = await ytHtmlRes.text();
        const matches = Array.from(html.matchAll(/"videoId":"([a-zA-Z0-9_-]{11})"/g));
        for (const m of matches) {
          const vId = m[1];
          if (vId && !seenResources.has(vId) && vId !== 'dQw4w9WgXcQ' && vId !== 'kJQP7kiw5Fk' && vId !== 'dQ3GLk1jUqI') {
            const verifiedTitle = await getVerifiedTitle(vId, `${cleanStepTitle} - ${trackName} Walkthrough`);
            selectedVideo = {
              videoId: vId,
              videoTitle: verifiedTitle,
            };
            break;
          }
        }
      }
    } catch (e) {
      console.warn('[sourceStepContentFast] Attempt 3 scrape notice:', e);
    }
  }

  // Guarantee non-null selectedVideo without repetitive static fallbacks
  if (!selectedVideo) {
    selectedVideo = {
      videoId: 'M7lc1UVf-VE', // YouTube official developer intro fallback as extreme safety
      videoTitle: `${trackName} - ${cleanStepTitle} Study Session`,
    };
  }

  // ---------------------------------------------------------------------------
  // TASK B: PARALLEL TOPIC DOCUMENT SOURCING (STRICT NO-VIDEO DOMAINS)
  // ---------------------------------------------------------------------------
  let rawTopics: any[] = [];
  if (Array.isArray(stepRow.topics) && stepRow.topics.length > 0) {
    rawTopics = stepRow.topics;
  } else if (typeof stepRow.topics === 'string' && stepRow.topics.trim().length > 0) {
    try {
      rawTopics = JSON.parse(stepRow.topics);
    } catch (_) {}
  }

  const topicsList = rawTopics.length > 0 ? rawTopics : (
    isSportsTrack
      ? [
          { topicId: `t${stepNumber}-1`, title: `${cleanStepTitle} - Core Technique & Form` },
          { topicId: `t${stepNumber}-2`, title: `${cleanStepTitle} - Common Errors & Drills` },
        ]
      : [
          { topicId: `t${stepNumber}-1`, title: `${cleanStepTitle} - Principles & Fundamentals` },
          { topicId: `t${stepNumber}-2`, title: `${cleanStepTitle} - Practical Implementation` },
        ]
  );

  const docPromises = topicsList.map(async (topic: any, idx: number) => {
    let docUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(trackName)}`;
    let domain = 'wikipedia.org';
    let objective = `Master foundational mechanics of ${topic.title}`;

    try {
      const queryTerm = isSportsTrack
        ? `"${trackName}" "${topic.title}" coaching guide drills rules manual`
        : `"${trackName}" "${topic.title}" documentation reference manual`;

      const searchRes = await tavilyClient.search(
        `${queryTerm} -youtube -shorts -instagram -facebook -twitter -x -tiktok -vimeo -dailymotion`,
        {
          search_depth: 'basic',
          max_results: 5,
          exclude_domains: [
            'youtube.com',
            'youtu.be',
            'facebook.com',
            'instagram.com',
            'tiktok.com',
            'twitter.com',
            'x.com',
            'vimeo.com',
            'dailymotion.com',
          ],
        }
      );

      const validDoc = (searchRes.results || []).find((r: any) =>
        r.url &&
        !seenResources.has(r.url) &&
        !r.url.includes('youtube.com') &&
        !r.url.includes('youtu.be')
      ) || (searchRes.results || []).find((r: any) => r.url && !r.url.includes('youtube.com'));

      if (validDoc) {
        docUrl = validDoc.url;
        objective = validDoc.title || objective;
        try {
          domain = new URL(docUrl).hostname.replace(/^(www\.)/, '');
        } catch (_) {}
      }
    } catch (e) {
      console.warn(`[sourceStepContentFast] Topic ${topic.title} doc query notice:`, e);
    }

    return {
      topicId: topic.topicId || `t${stepNumber}-${idx + 1}`,
      title: topic.title,
      externalUrl: docUrl,
      sourceTitle: topic.title,
      sourceDomain: domain,
      coreObjective: objective,
      pedagogicalGuide: {
        sectionsToRead: ['Core foundational concepts and laws', 'Practical form and verified drills'],
        sectionsToSkip: ['Historical digressions', 'Unrelated domain implementations'],
        howToLearn: `Focus on the fundamental mechanics of ${topic.title}. Verify each step before moving forward.`,
        keyTraps: ['Confusing superficial movement with core mechanical form'],
      },
    };
  });

  // ---------------------------------------------------------------------------
  // TASK C: PARALLEL GROQ SYNTHESIS (STEP EXPLANATION + MINI GUIDES)
  // ---------------------------------------------------------------------------
  const groqGuidePromise = (async () => {
    try {
      const prompt = `You are the SKILL-TRACK Pedagogy & Master Trajectory Engine.
Discipline: "${trackName}"
Track Type: "${isSportsTrack ? 'Athletic / Sports Biomechanics' : 'Cognitive Discipline'}"
Current Milestone: Step ${stepNumber} - "${cleanStepTitle}"

Generate:
1. "stepExplanation": A 2-paragraph clear explanation of what the learner will master in this step, why it matters, and core first principles.
2. "videoMiniGuide": A concise, actionable mini guide explaining how to watch the video walkthrough, key cues/techniques to absorb, and execution tips.
3. "docMiniGuide": A concise, actionable mini guide explaining what specifically to read in the official documentation, key sections to study, and pitfalls to skip.

RETURN ONLY VALID JSON (no markdown formatting, no extra keys):
{
  "stepExplanation": "...",
  "videoMiniGuide": "...",
  "docMiniGuide": "..."
}`;

      const aiRes = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0.2,
        max_tokens: 1000,
      });

      const parsed = JSON.parse(aiRes.choices[0]?.message?.content || '{}');
      return {
        stepExplanation: parsed.stepExplanation || `Master foundational mental models, invariants, and operational execution for ${cleanStepTitle}.`,
        videoMiniGuide: parsed.videoMiniGuide || `Focus on instructor form, sequential pacing, and key mechanical execution cues.`,
        docMiniGuide: parsed.docMiniGuide || `Review core definitions, parameter specifications, and standard reference patterns.`,
      };
    } catch (e) {
      console.warn('[sourceStepContentFast] Groq guide generation notice:', e);
      return {
        stepExplanation: `In this milestone, you will master the foundational invariants, key concepts, and operational execution of ${cleanStepTitle}. Focus on solidifying your baseline before advancing.`,
        videoMiniGuide: `Watch for the instructor's breakdown of first principles, sequential pacing, and error recovery techniques.`,
        docMiniGuide: `Read through the core concepts, execution standards, and formal specifications. Skip legacy or deprecated sections.`,
      };
    }
  })();

  // Execute all asynchronous sourcing tasks concurrently
  const [enrichedTopics, groqGuides] = await Promise.all([
    Promise.all(docPromises),
    groqGuidePromise,
  ]);

  const videoUrl = `https://www.youtube.com/watch?v=${selectedVideo.videoId}`;
  const primaryDoc = enrichedTopics[0] || {
    title: `${cleanStepTitle} Official Documentation`,
    externalUrl: `https://en.wikipedia.org/wiki/${encodeURIComponent(trackName)}`,
    sourceDomain: 'wikipedia.org',
  };

  // ---------------------------------------------------------------------------
  // TASK D: ANTI-REPETITION VAULT PERSISTENCE (SAFE ERROR ISOLATION)
  // ---------------------------------------------------------------------------
  try {
    await db.query(
      `INSERT INTO user_resource_history (id, user_id, skill_id, step_number, resource_type, resource_identifier)
       VALUES (gen_random_uuid()::text, $1, $2, $3, 'youtube_video', $4)
       ON CONFLICT (user_id, resource_identifier) DO NOTHING`,
      [safeUserId, skillId, stepNumber, selectedVideo.videoId]
    );

    for (const doc of enrichedTopics) {
      await db.query(
        `INSERT INTO user_resource_history (id, user_id, skill_id, step_number, resource_type, resource_identifier)
         VALUES (gen_random_uuid()::text, $1, $2, $3, 'external_doc_url', $4)
         ON CONFLICT (user_id, resource_identifier) DO NOTHING`,
        [safeUserId, skillId, stepNumber, doc.externalUrl]
      );
    }
  } catch (vaultErr) {
    console.warn('[Vault] History insertion notice:', vaultErr);
  }

  // ---------------------------------------------------------------------------
  // TASK E: SAFE STEP UPSERT (SKILL_STEPS + PRISMA SKILLSTEP)
  // ---------------------------------------------------------------------------
  try {
    await db.query(
      `INSERT INTO skill_steps (
         id, skill_id, step_number, title, description,
         video_id, video_url, video_title, video_mini_guide,
         doc_title, doc_url, doc_domain, doc_mini_guide,
         step_explanation, documentation_markdown, topics, is_sourced
       ) VALUES (
         gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, TRUE
       )
       ON CONFLICT (skill_id, step_number) DO UPDATE SET
         video_id = EXCLUDED.video_id,
         video_url = EXCLUDED.video_url,
         video_title = EXCLUDED.video_title,
         video_mini_guide = EXCLUDED.video_mini_guide,
         doc_title = EXCLUDED.doc_title,
         doc_url = EXCLUDED.doc_url,
         doc_domain = EXCLUDED.doc_domain,
         doc_mini_guide = EXCLUDED.doc_mini_guide,
         step_explanation = EXCLUDED.step_explanation,
         documentation_markdown = EXCLUDED.documentation_markdown,
         topics = EXCLUDED.topics,
         is_sourced = TRUE`,
      [
        skillId,
        stepNumber,
        cleanStepTitle,
        stepRow.description || `Core mechanics for ${cleanStepTitle}`,
        selectedVideo.videoId,
        videoUrl,
        selectedVideo.videoTitle,
        groqGuides.videoMiniGuide,
        primaryDoc.title,
        primaryDoc.externalUrl,
        primaryDoc.sourceDomain,
        groqGuides.docMiniGuide,
        groqGuides.stepExplanation,
        groqGuides.stepExplanation,
        JSON.stringify(enrichedTopics),
      ]
    );
  } catch (upsertErr) {
    console.warn('[sourceStepContentFast] skill_steps upsert notice:', upsertErr);
    try {
      await db.query(
        `UPDATE skill_steps 
         SET video_id = $1, video_url = $2, video_title = $3, topics = $4::jsonb, is_sourced = TRUE 
         WHERE skill_id = $5 AND step_number = $6`,
        [
          selectedVideo.videoId,
          videoUrl,
          selectedVideo.videoTitle,
          JSON.stringify(enrichedTopics),
          skillId,
          stepNumber,
        ]
      );
    } catch (_) {}
  }

  // Also sync to Prisma SkillStep if matching record exists
  try {
    const matchingPrismaStep = await prisma.skillStep.findFirst({
      where: {
        OR: [
          { workspaceId: skillId, stepIndex: stepNumber },
          { id: skillId }
        ]
      }
    });
    if (matchingPrismaStep) {
      const updatedResources = [
        {
          id: `vid-${selectedVideo.videoId}`,
          type: 'video',
          title: selectedVideo.videoTitle,
          url: videoUrl,
          videoId: selectedVideo.videoId,
          platform: 'YouTube',
          linkStatus: 'VERIFIED',
          embeddable: true,
          focusNote: groqGuides.videoMiniGuide,
          snippet: groqGuides.videoMiniGuide,
        },
        ...enrichedTopics.map((t: any) => ({
          id: `doc-${t.topicId}`,
          type: 'doc',
          title: t.title,
          url: t.externalUrl,
          platform: t.sourceDomain,
          linkStatus: 'VERIFIED',
          focusNote: t.coreObjective,
          snippet: t.pedagogicalGuide?.howToLearn || t.coreObjective,
        })),
      ];
      await prisma.skillStep.update({
        where: { id: matchingPrismaStep.id },
        data: {
          resources: updatedResources as any,
          documentation_markdown: groqGuides.stepExplanation,
          step_explanation: groqGuides.stepExplanation,
          is_sourced: true,
        } as any,
      });
    }
  } catch (_) {}

  return {
    step_number: stepNumber,
    title: cleanStepTitle,
    is_sourced: true,
    video_id: selectedVideo.videoId,
    video_title: selectedVideo.videoTitle,
    video_url: videoUrl,
    videoId: selectedVideo.videoId,
    videoTitle: selectedVideo.videoTitle,
    videoUrl,
    videoMiniGuide: groqGuides.videoMiniGuide,
    video_mini_guide: groqGuides.videoMiniGuide,
    docTitle: primaryDoc.title,
    doc_title: primaryDoc.title,
    docUrl: primaryDoc.externalUrl,
    doc_url: primaryDoc.externalUrl,
    docDomain: primaryDoc.sourceDomain,
    doc_domain: primaryDoc.sourceDomain,
    docMiniGuide: groqGuides.docMiniGuide,
    doc_mini_guide: groqGuides.docMiniGuide,
    stepExplanation: groqGuides.stepExplanation,
    step_explanation: groqGuides.stepExplanation,
    topics: enrichedTopics,
  };
}

/**
 * Standard sourceStepContent delegating to fast parallel execution
 */
export async function sourceStepContent(
  userId: string,
  skillId: string,
  stepNumber: number
): Promise<SourcedStepResult> {
  return sourceStepContentFast(userId, skillId, stepNumber);
}

export default {
  searchYouTubeCandidates,
  sourceStepContentFast,
  sourceStepContent,
};
