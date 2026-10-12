import { getEffectiveKeys } from '../lib/keyManager';
import prisma from '../lib/prisma';
import { extractYouTubeVideoId } from './search';

export async function fetchVerifiedStepVideo(params: {
  userId?: string;
  skillId?: string;
  skillName: string;
  subGenre?: string;
  stepNumber: number;
  stepTitle: string;
  skillCategory?: 'cognitive' | 'physical';
}): Promise<{ videoId: string; videoUrl: string }> {
  const { tavilyKey } = await getEffectiveKeys();
  if (!tavilyKey) {
    throw new Error('Unable to fetch verified step resources. Please verify API keys in .env.');
  }

  // 1. Check Anti-Repetition Vault
  const excludedVideoIds = new Set<string>();
  if (params.userId) {
    try {
      const history = await prisma.userResourceHistory.findMany({
        where: { userId: params.userId, resourceType: 'video_id' },
        select: { resourceIdentifier: true },
      });
      for (const h of history) {
        excludedVideoIds.add(h.resourceIdentifier);
      }
    } catch (_) {}
  }

  // 2. Query Tavily with step-calibrated context and negative keywords
  const isSwimming = params.skillName.toLowerCase().includes('swim') || (params.subGenre || '').toLowerCase().includes('swim');
  const excludeNegative = !isSwimming ? '-swim -swimming' : '';
  const query = `site:youtube.com ${params.skillName} ${params.subGenre || ''} Step ${params.stepNumber} ${params.stepTitle} tutorial drills guide ${excludeNegative} 2026`.trim();

  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: tavilyKey,
        query,
        search_depth: 'basic',
        max_results: 8,
      }),
    });

    if (!res.ok) {
      throw new Error('Unable to fetch verified step resources. Please verify API keys in .env.');
    }

    const data: any = await res.json();
    const results: any[] = data.results || [];

    for (const r of results) {
      if (!r.url) continue;
      const vid = extractYouTubeVideoId(r.url);
      if (vid && !excludedVideoIds.has(vid)) {
        // Record in Anti-Repetition Vault
        if (params.userId) {
          try {
            await prisma.userResourceHistory.upsert({
              where: {
                userId_resourceType_resourceIdentifier: {
                  userId: params.userId,
                  resourceType: 'video_id',
                  resourceIdentifier: vid,
                },
              },
              update: {},
              create: {
                userId: params.userId,
                resourceType: 'video_id',
                resourceIdentifier: vid,
                skillId: params.skillId || null,
                stepNumber: params.stepNumber,
              },
            });
          } catch (_) {}
        }

        return {
          videoId: vid,
          videoUrl: `https://www.youtube.com/watch?v=${vid}`,
        };
      }
    }

    // If all Tavily results were previously used, throw clear error
    throw new Error('Unable to fetch verified step resources. Please verify API keys in .env.');
  } catch (err: any) {
    if (err.message && err.message.includes('Unable to fetch')) {
      throw err;
    }
    throw new Error(`Unable to fetch verified step resources. Please verify API keys in .env. (${err.message})`);
  }
}
