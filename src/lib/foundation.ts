import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { getEffectiveKeys } from './keyManager';
import { LEARNING_CONFIG } from '../config/learning';

export class GroqApiError extends Error {
  constructor(message: string, public statusCode?: number) {
    super(message);
    this.name = 'GroqApiError';
  }
}

export class TavilyAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TavilyAuthError';
  }
}

let cachedWorkingModel: string | null = null;

// Sequential execution queue for free-tier Groq API calls
let groqQueue = Promise.resolve();
function enqueueGroq<T>(fn: () => Promise<T>): Promise<T> {
  const next = groqQueue.then(fn, fn);
  groqQueue = next.then(() => {}, () => {});
  return next;
}

export async function callGroqJson<T = any>(
  systemPrompt: string,
  userPrompt: string,
  options: {
    validate?: (val: any) => boolean;
    maxTokens?: number;
    temperature?: number;
  } = {}
): Promise<T> {
  return enqueueGroq(async () => {
    const { groqKey } = await getEffectiveKeys();
    if (!groqKey) {
      throw new GroqApiError('Groq API Key is not configured in .env or /admin');
    }

    let model = cachedWorkingModel || process.env.GROQ_MODEL || 'llama-3.1-70b-versatile';

    async function sendRequest(sys: string, usr: string, targetModel: string, retryCount = 0): Promise<any> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 45000);

      try {
        const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${groqKey}`,
          },
          body: JSON.stringify({
            model: targetModel,
            messages: [
              { role: 'system', content: sys },
              { role: 'user', content: usr },
            ],
            response_format: { type: 'json_object' },
            max_tokens: options.maxTokens ?? 4500,
            temperature: options.temperature ?? 0.3,
          }),
          signal: controller.signal,
        });
        clearTimeout(timer);

        if (res.status === 429 && retryCount < 2) {
          const retryAfterSec = Number(res.headers.get('retry-after') || '3');
          await new Promise((r) => setTimeout(r, Math.max(1, retryAfterSec) * 1000));
          return sendRequest(sys, usr, targetModel, retryCount + 1);
        }

        if (res.status === 404 || res.status === 400) {
          const errBody = await res.text();
          if (res.status === 400 && (errBody.includes('max completion tokens') || errBody.includes('json_validate_failed'))) {
            if (retryCount < 2) {
              options.maxTokens = 8000;
              const briefUsr = `${usr}\n\nCRITICAL: Be concise and avoid filler so the entire JSON payload fits completely within token limits.`;
              return sendRequest(sys, briefUsr, targetModel, retryCount + 1);
            }
          }
          if (errBody.includes('model_not_found') || errBody.includes('does not exist') || res.status === 404) {
            // Pick best available chat model from Groq
            try {
              const modelsRes = await fetch('https://api.groq.com/openai/v1/models', {
                headers: { Authorization: `Bearer ${groqKey}` },
              });
              if (modelsRes.ok) {
                const data: any = await modelsRes.json();
                const available: string[] = (data?.data || []).map((m: any) => m.id);
                // Filter out non-chat, audio, or restricted models
                const candidateChatModels = available.filter(
                  (m) =>
                    !m.includes('whisper') &&
                    !m.includes('prompt-guard') &&
                    !m.includes('safeguard') &&
                    !m.includes('orpheus')
                );

                const best =
                  candidateChatModels.find((m) => m.includes('llama-3.3') || m.includes('llama-3.1')) ||
                  candidateChatModels.find((m) => m.includes('gpt-oss-120b') || m.includes('qwen3.8') || m.includes('gpt-oss-20b')) ||
                  candidateChatModels[0];

                if (best && best !== targetModel) {
                  cachedWorkingModel = best;
                  return sendRequest(sys, usr, best, retryCount);
                }
              }
            } catch (_) {}
          }
          throw new GroqApiError(`Groq API returned ${res.status}: ${errBody}`, res.status);
        }

        if (!res.ok) {
          const txt = await res.text();
          throw new GroqApiError(`Groq API error HTTP ${res.status}: ${txt}`, res.status);
        }

        const data: any = await res.json();
        const content = data.choices?.[0]?.message?.content || '';
        const stripped = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
        return JSON.parse(stripped);
      } catch (err: any) {
        clearTimeout(timer);
        if (err instanceof GroqApiError) throw err;
        throw new GroqApiError(`Groq request failed: ${err.message || String(err)}`);
      }
    }

    let parsedResult: any;
    try {
      parsedResult = await sendRequest(systemPrompt, userPrompt, model);
    } catch (err) {
      throw err;
    }

    if (options.validate) {
      if (options.validate(parsedResult)) {
        return parsedResult as T;
      }
      // Retry ONCE with validation error appended
      const retryUserPrompt = `${userPrompt}\n\nCRITICAL: Your previous output failed schema validation. Please strictly adhere to the requested JSON format without omission.`;
      const retryResult = await sendRequest(systemPrompt, retryUserPrompt, model);
      if (options.validate(retryResult)) {
        return retryResult as T;
      }
      throw new GroqApiError('Model output failed strict validation after retry.');
    }

    return parsedResult as T;
  });
}

export interface TavilySearchItem {
  title: string;
  url: string;
  content: string;
  rawContent?: string;
}

export async function searchTavily(
  query: string,
  opts: {
    searchDepth?: 'basic' | 'advanced';
    maxResults?: number;
    includeDomains?: string[];
    includeRawContent?: boolean;
  } = {}
): Promise<TavilySearchItem[]> {
  const { tavilyKey } = await getEffectiveKeys();
  if (!tavilyKey) {
    throw new TavilyAuthError('Tavily API key is not configured in .env or /admin');
  }

  const payload: Record<string, any> = {
    api_key: tavilyKey,
    query,
    search_depth: opts.searchDepth || 'advanced',
    max_results: opts.maxResults || 6,
    include_raw_content: opts.includeRawContent ?? false,
  };

  if (opts.includeDomains && opts.includeDomains.length > 0) {
    payload.include_domains = opts.includeDomains;
  }

  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });

    if (res.status === 401 || res.status === 403) {
      throw new TavilyAuthError(`Tavily authentication failed: HTTP ${res.status}`);
    }

    if (!res.ok) {
      return [];
    }

    const data: any = await res.json();
    const results = Array.isArray(data.results) ? data.results : [];
    return results.map((r: any) => ({
      title: (r.title || '').trim(),
      url: (r.url || '').trim(),
      content: (r.content || '').trim(),
      rawContent: (r.raw_content || r.rawContent || '').trim(),
    }));
  } catch (err: any) {
    if (err instanceof TavilyAuthError) throw err;
    return [];
  }
}

export function extractYouTubeId(raw: string): string | null {
  try {
    const u = new URL(raw);
    const host = u.hostname.replace(/^(www|m)\./, '');
    let id: string | null = null;
    if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
    else if (host === 'youtube.com' || host === 'music.youtube.com') {
      if (u.pathname === '/watch') id = u.searchParams.get('v');
      else if (/^\/(shorts|embed|live)\//.test(u.pathname)) id = u.pathname.split('/')[2];
    }
    return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = '';
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid', 'si']
      .forEach((p) => u.searchParams.delete(p));
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    const path = u.pathname.replace(/\/+$/, '');
    const qs = u.searchParams.toString();
    return `${host}${path}${qs ? '?' + qs : ''}`;
  } catch {
    return raw;
  }
}

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  return ip === '::1' || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80');
}

export async function isSafePublicUrl(raw: string): Promise<boolean> {
  try {
    const u = new URL(raw);
    if (!/^https?:$/.test(u.protocol) || u.hostname === 'localhost') return false;
    const addrs = net.isIP(u.hostname) ? [{ address: u.hostname }] : await lookup(u.hostname, { all: true });
    return addrs.every((a) => !isPrivateIp(a.address));
  } catch {
    return false;
  }
}

export async function mapWithLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

export function assertNoUrls(value: unknown, label: string): void {
  if (/https?:\/\/|www\./i.test(JSON.stringify(value))) {
    throw new Error(`${label}: model output contained a URL (URLs may only come from Tavily)`);
  }
}

export type YouTubeCheck = {
  status: 'EMBEDDABLE' | 'NO_EMBED' | 'GONE' | 'UNKNOWN';
  title?: string;
  channel?: string;
};

export async function checkYouTube(videoId: string): Promise<YouTubeCheck> {
  try {
    const res = await fetch(
      'https://www.youtube.com/oembed?format=json&url=' +
        encodeURIComponent('https://www.youtube.com/watch?v=' + videoId),
      { signal: AbortSignal.timeout(4000) }
    );
    if (res.ok) {
      const j: any = await res.json();
      return { status: 'EMBEDDABLE', title: j.title, channel: j.author_name };
    }
    if (res.status === 401 || res.status === 403) return { status: 'NO_EMBED' };
    if (res.status === 404 || res.status === 400) return { status: 'GONE' };
    return { status: 'UNKNOWN' };
  } catch {
    return { status: 'UNKNOWN' };
  }
}

export type LinkStatus = 'VERIFIED' | 'UNCHECKED' | 'DEAD';
const SOFT_404 = /(page not found|404 not found|no longer available|this video is unavailable|content (has been )?removed|does not exist)/i;

export async function verifyLink(url: string, sampleText?: string): Promise<LinkStatus> {
  if (!(await isSafePublicUrl(url))) return 'DEAD';
  if (sampleText && SOFT_404.test(sampleText.slice(0, 600))) return 'DEAD';

  const id = extractYouTubeId(url);
  if (id) {
    const yt = await checkYouTube(id);
    return yt.status === 'GONE' ? 'DEAD' : yt.status === 'UNKNOWN' ? 'UNCHECKED' : 'VERIFIED';
  }

  const headers = {
    'User-Agent': 'Mozilla/5.0 (compatible; SkillTrackLinkCheck/1.0)',
    Accept: 'text/html,*/*',
  };

  for (const method of ['HEAD', 'GET'] as const) {
    try {
      const res = await fetch(url, {
        method,
        headers,
        redirect: 'follow',
        signal: AbortSignal.timeout(LEARNING_CONFIG.LINK_CHECK_TIMEOUT_MS),
      });
      await res.body?.cancel();
      if (res.status === 404 || res.status === 410) return 'DEAD';
      if (res.ok) return 'VERIFIED';
      if (res.status === 405 || res.status === 501) continue;
      return 'UNCHECKED';
    } catch {
      // Timeout or network error, fall through to next method or return UNCHECKED
    }
  }
  return 'UNCHECKED';
}

export async function fetchWikipediaExtract(query: string) {
  const headers = {
    'User-Agent': `SkillTrack/1.0 (${process.env.WIKI_CONTACT ?? 'educational-app'})`,
    Accept: 'application/json',
  };
  try {
    const search = await fetch(
      'https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&formatversion=2&srlimit=3&srsearch=' +
        encodeURIComponent(query),
      { headers, signal: AbortSignal.timeout(6000) }
    );
    if (!search.ok) return null;
    const searchData: any = await search.json();
    const title = searchData?.query?.search?.[0]?.title;
    if (!title) return null;

    const ex = await fetch(
      'https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&exsectionformat=wiki&redirects=1&format=json&formatversion=2&titles=' +
        encodeURIComponent(title),
      { headers, signal: AbortSignal.timeout(8000) }
    );
    if (!ex.ok) return null;
    const exData: any = await ex.json();
    const page = exData?.query?.pages?.[0];
    const text: string = (page?.extract ?? '').trim();
    if (text.length < 400) return null;

    return {
      title: page.title as string,
      url: 'https://en.wikipedia.org/wiki/' + encodeURIComponent(String(page.title).replace(/ /g, '_')),
      text,
    };
  } catch {
    return null;
  }
}

export function wikipediaSectionLink(articleUrl: string, extract: string, topicTitle: string) {
  const headings = [...extract.matchAll(/^={2,4}\s*(.+?)\s*={2,4}\s*$/gm)].map((m) => m[1]);
  const words = topicTitle.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
  const best = headings
    .map((h) => ({ h, score: words.filter((w) => h.toLowerCase().includes(w)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)[0];
  return best ? { url: `${articleUrl}#${encodeURIComponent(best.h.replace(/ /g, '_'))}`, label: best.h } : null;
}
