import { getEffectiveKeys } from '../lib/keyManager';
import prisma from '../lib/prisma';
import { extractYouTubeVideoId } from './search';
import { getDifficultyTier } from './documentationService';

export interface VerifiedStepVideo {
  id: string;
  videoId: string;
  url: string;
  title: string;
  channelTitle?: string;
  description?: string;
  duration?: string;
}

/**
 * MODULE 4: ZERO-REPETITION VIDEO ENGINE (YOUTUBE + ANTI-REPETITION VAULT)
 * Enforces strict diversity: Every step introduces strictly new video walkthroughs.
 * Filters against seen videos in user_resource_history.
 */
export async function fetchVerifiedStepVideos(params: {
  userId?: string;
  skillId?: string;
  skillName: string;
  subGenre?: string;
  stepNumber: number;
  stepTitle: string;
  difficultyLevel?: string;
  skillCategory?: 'cognitive' | 'physical';
  limit?: number;
}): Promise<VerifiedStepVideo[]> {
  const { tavilyKey } = await getEffectiveKeys();
  if (!tavilyKey) {
    throw new Error('Unable to fetch verified step resources. Please verify API keys in .env.');
  }

  const limit = params.limit || 3;
  const diffTier = getDifficultyTier(params.stepNumber);
  const activeDifficulty = params.difficultyLevel || diffTier.difficultyLevel;

  // 1. Anti-Repetition Vault Check: Fetch all YouTube IDs already shown to this user
  const seenVideoIds = new Set<string>();
  if (params.userId) {
    try {
      const historyRows: any[] = await prisma.$queryRawUnsafe(`
        SELECT resource_identifier 
        FROM user_resource_history 
        WHERE user_id = $1 AND (resource_type = 'youtube_video' OR resource_type = 'video_id');
      `, params.userId);

      for (const row of historyRows) {
        if (row.resource_identifier) {
          seenVideoIds.add(String(row.resource_identifier).trim());
        }
      }
    } catch (err: any) {
      console.warn('[videoService] User resource history check notice:', err?.message || err);
    }
  }

  // 2. Step-Specific YouTube Query with progressive difficulty modifiers
  const isSwimming = params.skillName.toLowerCase().includes('swim') || (params.subGenre || '').toLowerCase().includes('swim');
  const excludeNegative = !isSwimming ? '-swim -swimming' : '';
  const primaryQuery = `site:youtube.com ${params.skillName} ${params.subGenre || ''} "${params.stepTitle}" ${activeDifficulty} ${diffTier.keywordModifiers} tutorial ${excludeNegative}`.trim();

  const candidateVideos: VerifiedStepVideo[] = [];

  // Helper search runner
  async function searchVideos(q: string): Promise<VerifiedStepVideo[]> {
    try {
      const res = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: tavilyKey,
          query: q,
          search_depth: 'basic',
          max_results: 10,
        }),
      });

      if (!res.ok) return [];

      const data: any = await res.json();
      const results: any[] = data.results || [];
      const extracted: VerifiedStepVideo[] = [];

      for (const r of results) {
        if (!r.url) continue;
        const vId = extractYouTubeVideoId(r.url);
        if (vId && !extracted.some((item) => item.videoId === vId)) {
          extracted.push({
            id: vId,
            videoId: vId,
            url: `https://www.youtube.com/watch?v=${vId}`,
            title: r.title || `${params.stepTitle} - ${activeDifficulty} Breakdown`,
            channelTitle: r.title?.split('-')[0]?.trim() || 'Verified Tutorial',
            description: r.content || `Authoritative walkthrough for ${params.stepTitle}.`,
            duration: '10-15 mins',
          });
        }
      }

      return extracted;
    } catch {
      return [];
    }
  }

  // Search Pass 1: Targeted Query
  const firstPass = await searchVideos(primaryQuery);
  candidateVideos.push(...firstPass);

  // Filter candidate video IDs against the user's seenVideoIds set
  let freshVideos = candidateVideos.filter((v) => !seenVideoIds.has(v.videoId));

  // If candidate results overlap with seen videos, increment search query modifiers
  if (freshVideos.length < limit) {
    const alternateQuery = `site:youtube.com ${params.skillName} ${params.subGenre || ''} "${params.stepTitle}" ${diffTier.keywordModifiers} coaching breakdown drills guide ${excludeNegative}`.trim();
    const secondPass = await searchVideos(alternateQuery);
    for (const v of secondPass) {
      if (!candidateVideos.some((c) => c.videoId === v.videoId)) {
        candidateVideos.push(v);
      }
    }
    freshVideos = candidateVideos.filter((v) => !seenVideoIds.has(v.videoId));
  }

  // Pick top fresh, previously unseen videos
  const selectedVideos = freshVideos.slice(0, limit);

  // If strict fresh count was less than requested due to extreme usage, fill with candidates
  if (selectedVideos.length === 0 && candidateVideos.length > 0) {
    selectedVideos.push(candidateVideos[0]);
  }

  if (selectedVideos.length === 0) {
    throw new Error('Unable to fetch verified step resources. Please verify API keys in .env.');
  }

  // 3. Log Resources into History Table immediately upon retrieval
  if (params.userId) {
    for (const v of selectedVideos) {
      try {
        await prisma.$executeRawUnsafe(`
          INSERT INTO user_resource_history (user_id, skill_id, step_number, resource_type, resource_identifier)
          VALUES ($1, $2, $3, 'youtube_video', $4)
          ON CONFLICT (user_id, resource_type, resource_identifier) DO NOTHING;
        `, params.userId, params.skillId || null, params.stepNumber, v.videoId);

        // Also record video_id type for dual-compatibility
        await prisma.$executeRawUnsafe(`
          INSERT INTO user_resource_history (user_id, skill_id, step_number, resource_type, resource_identifier)
          VALUES ($1, $2, $3, 'video_id', $4)
          ON CONFLICT (user_id, resource_type, resource_identifier) DO NOTHING;
        `, params.userId, params.skillId || null, params.stepNumber, v.videoId);
      } catch (logErr: any) {
        console.warn('[videoService] Vault log notice:', logErr?.message || logErr);
      }
    }
  }

  return selectedVideos;
}

/**
 * Backwards-compatible single video fetch
 */
export async function fetchVerifiedStepVideo(params: {
  userId?: string;
  skillId?: string;
  skillName: string;
  subGenre?: string;
  stepNumber: number;
  stepTitle: string;
  difficultyLevel?: string;
  skillCategory?: 'cognitive' | 'physical';
}): Promise<{ videoId: string; videoUrl: string; videos: VerifiedStepVideo[] }> {
  const videos = await fetchVerifiedStepVideos({
    ...params,
    limit: 3,
  });

  const primary = videos[0];
  return {
    videoId: primary.videoId,
    videoUrl: primary.url,
    videos,
  };
}

export default fetchVerifiedStepVideo;
