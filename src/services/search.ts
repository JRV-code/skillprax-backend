import { getEffectiveKeys } from '../lib/keyManager';

export async function searchTavilyCurriculum(
  workspaceTitle: string,
  stepTitle: string,
  acuTitles: string[]
): Promise<Array<{ content: string; title: string; url: string }>> {
  const { tavilyKey } = await getEffectiveKeys();
  if (!tavilyKey) {
    throw new Error('Tavily API Key is not configured. Add it in /admin or .env');
  }

  // Modernized search query with 2026 freshness filters
  const focusKeywords = acuTitles.slice(0, 3).join(' ');
  const query = `${workspaceTitle} ${stepTitle} ${focusKeywords} 2026 latest technical tutorial documentation`;

  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: tavilyKey,
      query,
      search_depth: 'advanced',
      include_domains: [
        'youtube.com',
        'developer.mozilla.org',
        'github.com',
        'wikipedia.org',
        'geeksforgeeks.org',
        'w3schools.com',
        'arxiv.org',
        'docs.python.org',
        'khanacademy.org'
      ],
      max_results: 12
    })
  });

  if (!response.ok) {
    const errorData: any = await response.json().catch(() => ({}));
    throw new Error(`Tavily search failed (${response.status}): ${errorData.error || response.statusText}`);
  }

  const data: any = await response.json();
  const results = data.results || [];

  // Filter out invalid or blank URLs
  return results.filter((r: any) => r.url && r.url.startsWith('http') && r.title);
}
