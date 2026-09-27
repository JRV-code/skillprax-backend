export interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
}

export async function searchWeb(topic: string, apiKey: string): Promise<SearchResultItem[]> {
  if (!apiKey || !apiKey.trim()) return getFallbackSearchAnchors(topic);

  try {
    const cleanKey = apiKey.trim();
    const query = `${topic} authoritative tutorial documentation book guide`;

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
        max_results: 3,
        include_domains: [
          'github.com',
          'devdocs.io',
          'youtube.com',
          'wikipedia.org',
          'openlibrary.org',
        ],
      }),
    });

    if (!res.ok) {
      const errBody = await res.text();
      console.warn(`Tavily search API status ${res.status}: ${errBody || res.statusText}`);
      return getFallbackSearchAnchors(topic);
    }

    const data: any = await res.json();
    const results = (data.results || []).map((r: any) => ({
      title: r.title || 'Live Search Result',
      url: r.url,
      snippet: r.content || r.snippet || '',
    }));

    if (results.length > 0) return results;
    return getFallbackSearchAnchors(topic);
  } catch (err: any) {
    console.warn('Tavily search skipped or failed:', err.message || err);
    return getFallbackSearchAnchors(topic);
  }
}

export function getFallbackSearchAnchors(topic: string): SearchResultItem[] {
  const cleanTopic = (topic || 'programming').trim();
  return [
    {
      title: `${cleanTopic} Foundational Video Breakdown`,
      url: `https://www.youtube.com/results?search_query=${encodeURIComponent(cleanTopic + ' tutorial')}`,
      snippet: `Search anchor for ${cleanTopic} videos and walkthroughs on YouTube.`,
    },
    {
      title: `${cleanTopic} Authoritative Reference Manual`,
      url: `https://devdocs.io/#q=${encodeURIComponent(cleanTopic)}`,
      snippet: `Official documentation and API reference on DevDocs for ${cleanTopic}.`,
    },
    {
      title: `${cleanTopic} Recommended Textbooks & Literature`,
      url: `https://openlibrary.org/search?q=${encodeURIComponent(cleanTopic)}`,
      snippet: `Search canonical textbooks and publications on OpenLibrary for ${cleanTopic}.`,
    },
  ];
}
