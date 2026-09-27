export interface LiveCandidate {
  title: string;
  url: string;
  snippet: string;
}

export async function harvestLiveCandidates(
  query: string,
  apiKey?: string | null
): Promise<LiveCandidate[]> {
  const key = apiKey?.trim() || process.env.TAVILY_API_KEY?.trim();
  if (!key) {
    console.warn("[Tavily] No API key found. Passing empty candidate pool to Groq.");
    return [];
  }

  try {
    console.log(`[Tavily] Querying live web: "${query}"...`);
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${key}`
      },
      body: JSON.stringify({
        api_key: key,
        query: `${query}`,
        search_depth: "basic",
        max_results: 6,
        include_answer: false
      })
    });

    if (!res.ok) {
      const err = await res.text();
      console.error(`[Tavily] HTTP Error ${res.status}:`, err);
      return [];
    }

    const data: any = await res.json();
    const results = data.results || [];
    const direct: LiveCandidate[] = [];

    for (const r of results) {
      const u = (r.url || "").toLowerCase();
      // Block search result pages
      const isSearchPage =
        u.includes("youtube.com/results") ||
        u.includes("google.com/search") ||
        u.includes("bing.com/search") ||
        u.includes("/search?");

      if (!isSearchPage && r.url && r.title) {
        direct.push({
          title: r.title.trim(),
          url: r.url.trim(),
          snippet: (r.content || "").slice(0, 280)
        });
      }
    }

    console.log(`[Tavily] Harvested ${direct.length} direct candidates.`);
    return direct;
  } catch (err: any) {
    console.error("[Tavily] Search Exception:", err.message);
    return [];
  }
}

export interface SearchCandidate {
  title: string;
  url: string;
  snippet: string;
  inferredType: "video" | "pdf" | "wiki" | "guide" | "website" | "interactive";
}

export async function searchTavilyCandidates(query: string, apiKey: string): Promise<SearchCandidate[]> {
  const candidates = await harvestLiveCandidates(query, apiKey);
  return candidates.map(c => ({
    title: c.title,
    url: c.url,
    snippet: c.snippet,
    inferredType: c.url.includes("youtube.com") ? "video" : c.url.endsWith(".pdf") ? "pdf" : c.url.includes("wikipedia.org") ? "wiki" : "guide"
  }));
}

export function getFallbackCandidates(topic: string): SearchCandidate[] {
  const cleanTopic = (topic || 'learning').trim();
  return [
    {
      title: `Visual Foundation: Core Concepts of ${cleanTopic}`,
      url: `https://www.youtube.com/results?search_query=${encodeURIComponent(cleanTopic + ' full tutorial')}`,
      snippet: `YouTube search walkthrough and video lectures for ${cleanTopic}.`,
      inferredType: "video"
    },
    {
      title: `Encyclopedia Reference & Principles of ${cleanTopic}`,
      url: `https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(cleanTopic)}`,
      snippet: `Wikipedia overview, taxonomy, and fundamental theory for ${cleanTopic}.`,
      inferredType: "wiki"
    },
    {
      title: `Deep Study PDF & Academic Papers on ${cleanTopic}`,
      url: `https://www.google.com/search?q=${encodeURIComponent(cleanTopic + ' filetype:pdf OR open textbook')}`,
      snippet: `Authoritative textbooks, whitepapers, and field guide PDFs for ${cleanTopic}.`,
      inferredType: "pdf"
    },
    {
      title: `Comprehensive Guide & Portal for ${cleanTopic}`,
      url: `https://www.google.com/search?q=${encodeURIComponent(cleanTopic + ' comprehensive guide')}`,
      snippet: `Step-by-step guides, documentation, and web tutorials for ${cleanTopic}.`,
      inferredType: "guide"
    }
  ];
}

export async function searchWeb(topic: string, apiKey: string) {
  const candidates = await harvestLiveCandidates(topic, apiKey);
  return candidates.map(c => ({ title: c.title, url: c.url, snippet: c.snippet }));
}

export function getFallbackSearchAnchors(topic: string) {
  return getFallbackCandidates(topic).map(c => ({ title: c.title, url: c.url, snippet: c.snippet }));
}
