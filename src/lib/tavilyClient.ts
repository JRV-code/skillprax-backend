import { getEffectiveKeys } from './keyManager';

export interface TavilySearchOptions {
  search_depth?: 'basic' | 'advanced';
  max_results?: number;
  include_raw_content?: boolean;
  exclude_domains?: string[];
  include_domains?: string[];
}

export interface TavilySearchResultItem {
  title: string;
  url: string;
  content: string;
  raw_content?: string;
  score?: number;
}

export interface TavilySearchResponse {
  query: string;
  results: TavilySearchResultItem[];
}

export const tavilyClient = {
  async search(query: string, options: TavilySearchOptions = {}): Promise<TavilySearchResponse> {
    const { tavilyKey } = await getEffectiveKeys();
    if (!tavilyKey) {
      console.warn('[tavilyClient] Tavily API key missing from environment');
      return { query, results: [] };
    }

    try {
      const payload: Record<string, any> = {
        api_key: tavilyKey,
        query,
        search_depth: options.search_depth || 'advanced',
        max_results: options.max_results || 6,
        include_raw_content: options.include_raw_content ?? true,
      };

      if (options.exclude_domains && options.exclude_domains.length > 0) {
        payload.exclude_domains = options.exclude_domains;
      }
      if (options.include_domains && options.include_domains.length > 0) {
        payload.include_domains = options.include_domains;
      }

      const res = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) {
        return { query, results: [] };
      }

      const data: any = await res.json();
      const results: TavilySearchResultItem[] = (data.results || []).map((r: any) => ({
        title: r.title || '',
        url: r.url || '',
        content: r.content || '',
        raw_content: r.raw_content || r.content || '',
        score: r.score,
      }));

      return {
        query,
        results,
      };
    } catch (err: any) {
      console.error('[tavilyClient] Search failed:', err.message || err);
      return { query, results: [] };
    }
  },
};

export default tavilyClient;
