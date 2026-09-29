// skillprax-backend/src/lib/search/tavily.ts

const TAVILY_API_URL = "https://api.tavily.com/search";

/**
 * URL patterns that indicate a "search trampoline" — a search-results page
 * rather than a direct destination. SkillPrax must never hand these to a
 * learner (Issue: "No Search Trampolines" requirement).
 */
const TRAMPOLINE_PATTERNS: RegExp[] = [
  /youtube\.com\/results/i,
  /google\.[a-z.]+\/search/i,
  /bing\.com\/search/i,
  /duckduckgo\.com\/\?q=/i,
  /[?&]search_query=/i,
  /\/search\?/i,
  /\/search\/?$/i,
  /\/results\/?$/i,
  /baidu\.com\/s\?/i,
  /yahoo\.com\/search/i,
];

export interface TavilyRawResult {
  title: string;
  url: string;
  content: string;
  score: number;
  raw_content?: string | null;
}

export interface TavilyCandidate {
  title: string;
  url: string;
  snippet: string;
  relevanceScore: number;
  domain: string;
}

export interface TavilySearchOptions {
  maxResults?: number;
  searchDepth?: "basic" | "advanced";
  includeDomains?: string[];
  excludeDomains?: string[];
  topic?: "general" | "news";
}

export class TavilyError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "TavilyError";
  }
}

function isTrampoline(url: string): boolean {
  try {
    const parsed = new URL(url);
    const full = `${parsed.hostname}${parsed.pathname}${parsed.search}`;
    return TRAMPOLINE_PATTERNS.some((pattern) => pattern.test(full));
  } catch {
    return true; // malformed url — discard rather than risk a broken link
  }
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}

function dedupeByDomain(results: TavilyCandidate[], perDomainCap = 2): TavilyCandidate[] {
  const counts = new Map<string, number>();
  const output: TavilyCandidate[] = [];
  for (const r of results) {
    const count = counts.get(r.domain) ?? 0;
    if (count >= perDomainCap) continue;
    counts.set(r.domain, count + 1);
    output.push(r);
  }
  return output;
}

/**
 * Executes a Tavily search for a given learning step topic and returns a
 * cleaned, deduplicated, trampoline-free candidate pool.
 */
export async function searchTavily(
  query: string,
  apiKey: string | null | undefined,
  options: TavilySearchOptions = {}
): Promise<TavilyCandidate[]> {
  const key = apiKey?.trim() || process.env.TAVILY_API_KEY?.trim();
  if (!key) {
    console.warn("[tavily] No API key configured — skipping web search, Groq will use its internal fallback.");
    return [];
  }

  const {
    maxResults = 8,
    searchDepth = "advanced",
    includeDomains,
    excludeDomains,
    topic = "general",
  } = options;

  const body: Record<string, unknown> = {
    api_key: key,
    query,
    search_depth: searchDepth,
    max_results: Math.min(maxResults * 2, 20),
    include_answer: false,
    include_raw_content: false,
    topic,
  };
  if (includeDomains?.length) body.include_domains = includeDomains;
  if (excludeDomains?.length) body.exclude_domains = excludeDomains;

  let response: Response;
  try {
    response = await fetch(TAVILY_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error("[tavily] Network error during search:", err);
    return [];
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    console.error(`[tavily] API error ${response.status}: ${text}`);
    return [];
  }

  let json: { results?: TavilyRawResult[] };
  try {
    json = (await response.json()) as { results?: TavilyRawResult[] };
  } catch (err) {
    console.error("[tavily] Failed to parse response JSON:", err);
    return [];
  }

  const rawResults = json.results ?? [];

  const candidates: TavilyCandidate[] = rawResults
    .filter((r) => r.url && !isTrampoline(r.url))
    .map((r) => ({
      title: r.title?.trim() || extractDomain(r.url),
      url: r.url,
      snippet: (r.content || "").trim().slice(0, 500),
      relevanceScore: typeof r.score === "number" ? r.score : 0,
      domain: extractDomain(r.url),
    }))
    .sort((a, b) => b.relevanceScore - a.relevanceScore);

  const deduped = dedupeByDomain(candidates, 2);

  return deduped.slice(0, maxResults);
}

/**
 * Convenience wrapper that builds a well-scoped query from a pillar/domain,
 * a skill name, and a specific step title, then runs the search.
 */
export async function searchForStep(params: {
  apiKey: string | null | undefined;
  pillar: string;
  skillName: string;
  stepTitle: string;
  stepDescription?: string;
}): Promise<TavilyCandidate[]> {
  const { apiKey, pillar, skillName, stepTitle, stepDescription } = params;
  const query = [
    stepTitle,
    skillName,
    pillar,
    stepDescription ? stepDescription.slice(0, 120) : "",
    "2026 latest technical tutorial documentation canonical reference",
  ]
    .filter(Boolean)
    .join(" ");

  return searchTavily(query, apiKey, {
    maxResults: 12,
    searchDepth: "advanced",
    includeDomains: [
      "youtube.com",
      "developer.mozilla.org",
      "github.com",
      "wikipedia.org",
      "geeksforgeeks.org",
      "w3schools.com",
      "arxiv.org",
      "docs.python.org",
      "khanacademy.org"
    ]
  });
}

// Backward compatibility exports for orchestrator
export async function searchTavilyCandidates(query: string, apiKey: string) {
  const candidates = await searchTavily(query, apiKey);
  return candidates.map((c) => ({
    title: c.title,
    url: c.url,
    snippet: c.snippet,
    inferredType: c.url.includes("youtube.com")
      ? "video"
      : c.url.endsWith(".pdf")
      ? "pdf"
      : c.url.includes("wikipedia.org")
      ? "wiki"
      : "guide",
  }));
}

export async function searchWeb(query: string, apiKey: string) {
  const candidates = await searchTavily(query, apiKey);
  return candidates.map((c) => ({ title: c.title, url: c.url, snippet: c.snippet }));
}

export const harvestLiveCandidates = async (query: string, apiKey?: string | null) => {
  return searchTavily(query, apiKey, { maxResults: 6, searchDepth: "basic" });
};
