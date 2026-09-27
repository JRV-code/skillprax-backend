export interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
}

export async function searchWeb(query: string, apiKey: string): Promise<SearchResultItem[]> {
  if (!apiKey || !apiKey.trim()) return [];

  try {
    const cleanKey = apiKey.trim();
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cleanKey}`,
      },
      body: JSON.stringify({
        api_key: cleanKey,
        query,
        search_depth: 'basic',
        max_results: 4,
        include_domains: [
          'github.com',
          'devdocs.io',
          'youtube.com',
          'wikipedia.org',
          'developer.mozilla.org',
        ],
      }),
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Tavily search API status ${res.status}: ${errBody || res.statusText}`);
    }

    const data: any = await res.json();
    return (data.results || []).map((r: any) => ({
      title: r.title || 'Live Search Result',
      url: r.url,
      snippet: r.content || r.snippet || '',
    }));
  } catch (err: any) {
    console.warn('Tavily search skipped or failed:', err.message || err);
    return [];
  }
}
