import { getEffectiveKeys } from '../lib/keyManager';

export interface SearchResultItem {
  title: string;
  url: string;
  content: string;
  videoId?: string | null;
  type?: 'video' | 'doc' | 'interactive';
}

/**
 * Extracts and validates a valid 11-character YouTube video ID.
 */
export function extractYouTubeVideoId(url: string): string | null {
  if (!url) return null;
  // Match standard watch, embed, shorts, or youtu.be URLs
  const match = url.match(/(?:youtube\.com\/(?:watch\?.*v=|embed\/|v\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
}

// 1. UNIVERSAL CURRICULUM SEARCH (Supports Athletics, Coding, Arts, Science, etc.)
export async function searchTavilyCurriculum(
  workspaceTitle: string,
  stepTitle: string,
  domain: string = 'General',
  acuTitles: string[] = []
): Promise<SearchResultItem[]> {
  const { tavilyKey } = await getEffectiveKeys();
  if (!tavilyKey) throw new Error('Tavily API Key missing in /admin or .env');

  // Domain-specific query qualifiers with "2026 latest"
  let domainKeywords = 'canonical tutorial breakdown guide 2026 latest';
  const lowerDomain = domain.toLowerCase();

  if (lowerDomain.includes('athletic') || lowerDomain.includes('sport') || lowerDomain.includes('football')) {
    domainKeywords = 'drills technique biomechanics video breakdown coaching analysis 2026 latest';
  } else if (lowerDomain.includes('code') || lowerDomain.includes('logic') || lowerDomain.includes('software') || lowerDomain.includes('program')) {
    domainKeywords = 'implementation documentation architecture tutorial repository 2026 latest';
  } else if (lowerDomain.includes('art') || lowerDomain.includes('design')) {
    domainKeywords = 'walkthrough workflow visual design process demonstration 2026 latest';
  } else if (lowerDomain.includes('science') || lowerDomain.includes('chem') || lowerDomain.includes('phys')) {
    domainKeywords = 'first principles derivation experimental analysis lecture 2026 latest';
  }

  const focusKeywords = acuTitles.slice(0, 3).join(' ');
  const generalQuery = `${workspaceTitle} ${stepTitle} ${focusKeywords} ${domainKeywords}`;
  const videoQuery = `site:youtube.com ${workspaceTitle} ${stepTitle} tutorial drills guide 2026`;

  // Parallel search: General Canonical Resources + Targeted YouTube Search
  const [generalRes, videoRes] = await Promise.allSettled([
    fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: tavilyKey,
        query: generalQuery,
        search_depth: 'advanced',
        max_results: 10,
      }),
    }),
    fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: tavilyKey,
        query: videoQuery,
        search_depth: 'basic',
        max_results: 6,
      }),
    })
  ]);

  const output: SearchResultItem[] = [];

  // Parse general results
  if (generalRes.status === 'fulfilled' && generalRes.value.ok) {
    try {
      const data: any = await generalRes.value.json();
      const results: any[] = data.results || [];
      for (const r of results) {
        if (!r.url || !r.url.startsWith('http') || !r.title) continue;
        const videoId = extractYouTubeVideoId(r.url);
        output.push({
          title: (r.title || '').trim(),
          url: (r.url || '').trim(),
          content: r.content || '',
          videoId,
          type: videoId ? 'video' : 'doc',
        });
      }
    } catch (_) {}
  }

  // Parse video results
  if (videoRes.status === 'fulfilled' && videoRes.value.ok) {
    try {
      const data: any = await videoRes.value.json();
      const results: any[] = data.results || [];
      for (const r of results) {
        if (!r.url || !r.url.startsWith('http') || !r.title) continue;
        const videoId = extractYouTubeVideoId(r.url);
        if (videoId) {
          // Avoid duplicate video URLs
          if (!output.some((o) => o.videoId === videoId)) {
            output.push({
              title: (r.title || '').trim(),
              url: `https://www.youtube.com/watch?v=${videoId}`,
              content: r.content || '',
              videoId,
              type: 'video',
            });
          }
        }
      }
    } catch (_) {}
  }

  return output;
}

// 2. FOCUSED SEARCH FOR FAILED ACU REMEDIATION
export async function searchTavilyRemediation(
  workspaceTitle: string,
  weakTopic: string,
  misconception: string
): Promise<SearchResultItem[]> {
  const { tavilyKey } = await getEffectiveKeys();
  if (!tavilyKey) return [];

  const query = `${workspaceTitle} ${weakTopic} correct technique concept tutorial explanation 2026 latest`;
  const videoQuery = `site:youtube.com ${workspaceTitle} ${weakTopic} concept explanation breakdown 2026`;

  try {
    const [generalRes, videoRes] = await Promise.allSettled([
      fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: tavilyKey,
          query,
          search_depth: 'basic',
          max_results: 4,
        }),
      }),
      fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: tavilyKey,
          query: videoQuery,
          search_depth: 'basic',
          max_results: 3,
        }),
      })
    ]);

    const results: SearchResultItem[] = [];

    if (generalRes.status === 'fulfilled' && generalRes.value.ok) {
      const data: any = await generalRes.value.json();
      for (const r of data.results || []) {
        if (r.url && r.url.startsWith('http') && r.title) {
          const videoId = extractYouTubeVideoId(r.url);
          results.push({
            title: (r.title || '').trim(),
            url: (r.url || '').trim(),
            content: r.content || '',
            videoId,
            type: videoId ? 'video' : 'doc',
          });
        }
      }
    }

    if (videoRes.status === 'fulfilled' && videoRes.value.ok) {
      const data: any = await videoRes.value.json();
      for (const r of data.results || []) {
        const videoId = extractYouTubeVideoId(r.url);
        if (videoId && !results.some((existing) => existing.videoId === videoId)) {
          results.push({
            title: (r.title || '').trim(),
            url: `https://www.youtube.com/watch?v=${videoId}`,
            content: r.content || '',
            videoId,
            type: 'video',
          });
        }
      }
    }

    return results;
  } catch (err) {
    console.error('Tavily remediation search error:', err);
    return [];
  }
}
