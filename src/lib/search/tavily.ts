export interface SearchCandidate {
  title: string;
  url: string;
  snippet: string;
  inferredType: "video" | "pdf" | "wiki" | "guide" | "website" | "interactive";
}

export async function searchTavilyCandidates(query: string, apiKey: string): Promise<SearchCandidate[]> {
  if (!apiKey || !apiKey.trim()) return getFallbackCandidates(query);

  try {
    const cleanKey = apiKey.trim();
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${cleanKey}`
      },
      body: JSON.stringify({
        api_key: cleanKey,
        query: `${query} tutorial OR documentation OR filetype:pdf OR wikipedia`,
        search_depth: "basic",
        max_results: 8,
        include_answer: false
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      console.warn(`Tavily search API error (${res.status}): ${errText}`);
      return getFallbackCandidates(query);
    }

    const data: any = await res.json();
    const candidates = (data.results || []).map((r: any) => {
      let inferredType: SearchCandidate["inferredType"] = "guide";
      const u = (r.url || "").toLowerCase();
      if (u.includes("youtube.com") || u.includes("youtu.be")) inferredType = "video";
      else if (u.endsWith(".pdf") || u.includes("arxiv.org") || u.includes("/pdf/")) inferredType = "pdf";
      else if (u.includes("wikipedia.org") || u.includes("wikibooks.org")) inferredType = "wiki";
      else if (u.includes("github.com") || u.includes("interactive") || u.includes("lab") || u.includes("playground")) inferredType = "interactive";
      else if (u.includes("devdocs.io") || u.includes("docs.")) inferredType = "website";

      return {
        title: r.title || "Resource Reference",
        url: r.url,
        snippet: r.content || r.snippet || "",
        inferredType
      };
    });

    if (candidates.length >= 2) return candidates;
    return [...candidates, ...getFallbackCandidates(query)];
  } catch (err: any) {
    console.warn("Tavily search skipped or failed:", err.message || err);
    return getFallbackCandidates(query);
  }
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

// Backwards compatibility functions
export async function searchWeb(topic: string, apiKey: string) {
  const candidates = await searchTavilyCandidates(topic, apiKey);
  return candidates.map(c => ({ title: c.title, url: c.url, snippet: c.snippet }));
}

export function getFallbackSearchAnchors(topic: string) {
  return getFallbackCandidates(topic).map(c => ({ title: c.title, url: c.url, snippet: c.snippet }));
}
