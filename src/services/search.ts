import { getEffectiveKeys } from '../lib/keyManager';

export interface SearchResultItem {
  title: string;
  url: string;
  content: string;
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

  // Domain-specific query qualifiers
  let domainKeywords = 'canonical tutorial breakdown guide';
  const lowerDomain = domain.toLowerCase();

  if (lowerDomain.includes('athletic') || lowerDomain.includes('sport') || lowerDomain.includes('football')) {
    domainKeywords = 'drills technique biomechanics video breakdown coaching analysis';
  } else if (lowerDomain.includes('code') || lowerDomain.includes('logic') || lowerDomain.includes('software') || lowerDomain.includes('program')) {
    domainKeywords = 'implementation documentation architecture tutorial repository';
  } else if (lowerDomain.includes('art') || lowerDomain.includes('design')) {
    domainKeywords = 'walkthrough workflow visual design process demonstration';
  } else if (lowerDomain.includes('science') || lowerDomain.includes('chem') || lowerDomain.includes('phys')) {
    domainKeywords = 'first principles derivation experimental analysis lecture';
  }

  const focusKeywords = acuTitles.slice(0, 3).join(' ');
  const query = `${workspaceTitle} ${stepTitle} ${focusKeywords} ${domainKeywords} 2026 latest`;

  // Query Tavily with open search (No restrictive domain bottlenecks)
  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: tavilyKey,
      query,
      search_depth: 'advanced',
      max_results: 12,
    }),
  });

  if (!response.ok) {
    const errorData: any = await response.json().catch(() => ({}));
    throw new Error(`Tavily search failed (${response.status}): ${errorData.error || response.statusText}`);
  }

  const data: any = await response.json();
  const results: any[] = data.results || [];

  return results
    .filter((r) => r.url && r.url.startsWith('http') && r.title)
    .map((r) => ({
      title: (r.title || '').trim(),
      url: (r.url || '').trim(),
      content: r.content || '',
    }));
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

  try {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: tavilyKey,
        query,
        search_depth: 'basic',
        max_results: 6,
      }),
    });

    if (!response.ok) return [];
    const data: any = await response.json();
    const results: any[] = data.results || [];

    return results
      .filter((r) => r.url && r.url.startsWith('http') && r.title)
      .map((r) => ({
        title: (r.title || '').trim(),
        url: (r.url || '').trim(),
        content: r.content || '',
      }));
  } catch (err) {
    console.error('Tavily remediation search error:', err);
    return [];
  }
}
