import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { getEffectiveKeys } from '../../lib/keyManager';
import { LEARNING_CONFIG } from '../../config/learning';

export type LinkStatus = 'VERIFIED' | 'UNCHECKED' | 'DEAD';

export class GroqValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GroqValidationError';
  }
}

export class TavilyAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TavilyAuthError';
  }
}

// 7.1 GROQ CALL WITH JSON VALIDATION AND RETRY
let cachedGroqModel: string | null = null;
let cachedGroqModelExpires = 0;

async function getBestGroqModel(apiKey: string): Promise<string> {
  if (cachedGroqModel && Date.now() < cachedGroqModelExpires) {
    return cachedGroqModel;
  }
  try {
    const res = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(6000),
    });
    if (res.ok) {
      const data: any = await res.json();
      const ids: string[] = (data?.data || []).map((m: { id: string }) => m.id);
      if (process.env.GROQ_MODEL && ids.includes(process.env.GROQ_MODEL.trim())) {
        cachedGroqModel = process.env.GROQ_MODEL.trim();
        cachedGroqModelExpires = Date.now() + 30 * 60 * 1000;
        return cachedGroqModel;
      }
      const preferred = [
        'llama-3.3-70b-versatile',
        'openai/gpt-oss-120b',
        'openai/gpt-oss-20b',
        'qwen/qwen3.8-27b',
        'llama-3.1-70b-versatile',
        'llama-3.1-8b-instant',
      ];
      for (const p of preferred) {
        if (ids.includes(p)) {
          cachedGroqModel = p;
          cachedGroqModelExpires = Date.now() + 30 * 60 * 1000;
          return p;
        }
      }
    }
  } catch {
    // fallback
  }
  return 'openai/gpt-oss-120b';
}

function cleanJsonCodeFences(text: string): string {
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '');
    cleaned = cleaned.replace(/\s*```$/, '');
  }
  return cleaned.trim();
}

export async function callGroqJson<T>(
  systemPrompt: string,
  userPrompt: string,
  opts: {
    validate: (data: any) => T;
    maxTokens?: number;
    temperature?: number;
    retryCount?: number;
  }
): Promise<T> {
  const { groqKey } = await getEffectiveKeys();
  if (!groqKey) {
    throw new Error('Groq API Key missing in /admin or .env');
  }

  const model = await getBestGroqModel(groqKey);
  const maxTokens = opts.maxTokens ?? 2800;
  const temperature = opts.temperature ?? 0.2;

  let currentUserPrompt = userPrompt;
  let attempts = 0;
  const maxAttempts = (opts.retryCount ?? 1) + 1; // 1 attempt + 1 retry

  while (attempts < maxAttempts) {
    attempts++;
    let rateLimitRetries = 0;

    let res: Response | null = null;
    while (rateLimitRetries <= 2) {
      try {
        res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${groqKey}`,
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: currentUserPrompt },
            ],
            response_format: { type: 'json_object' },
            max_tokens: maxTokens,
            temperature,
          }),
          signal: AbortSignal.timeout(45000),
        });
      } catch (err: any) {
        if (attempts >= maxAttempts && rateLimitRetries >= 2) {
          throw new Error(`Groq request failed: ${err.message}`);
        }
      }

      if (res && res.status === 429) {
        rateLimitRetries++;
        const retryAfterHeader = res.headers.get('retry-after');
        const waitSec = retryAfterHeader ? parseInt(retryAfterHeader, 10) : 3;
        await new Promise((r) => setTimeout(r, Math.min(waitSec * 1000, 10000)));
        continue;
      }
      break;
    }

    if (!res || !res.ok) {
      const errBody = res ? await res.text().catch(() => '') : 'Network error';
      if (res && (res.status === 404 || errBody.includes('model_not_found'))) {
        cachedGroqModel = null;
        if (attempts < maxAttempts) {
          continue;
        }
      }
      if (attempts >= maxAttempts) {
        throw new Error(`Groq API error (status ${res?.status}): ${errBody.slice(0, 300)}`);
      }
      continue;
    }

    let rawJsonText = '';
    try {
      const completion: any = await res.json();
      rawJsonText = completion?.choices?.[0]?.message?.content || '';
      const parsed = JSON.parse(cleanJsonCodeFences(rawJsonText));
      return opts.validate(parsed);
    } catch (parseOrValErr: any) {
      if (attempts >= maxAttempts) {
        throw new GroqValidationError(
          `Groq JSON validation failed: ${parseOrValErr.message}. Output was: ${rawJsonText.slice(0, 300)}`
        );
      }
      // Retry once with validation error appended
      currentUserPrompt = `${userPrompt}\n\nCRITICAL FIX REQUIRED: Your previous response failed schema validation with error: "${parseOrValErr.message}". Return valid JSON matching the exact schema requested.`;
    }
  }

  throw new GroqValidationError('Groq calls exhausted without valid response');
}

// 7.2 TAVILY SEARCH
export interface TavilySearchResult {
  title: string;
  url: string;
  content: string;
  rawContent?: string;
  score: number;
}

export async function searchTavily(
  query: string,
  opts?: {
    searchDepth?: 'basic' | 'advanced';
    maxResults?: number;
    includeDomains?: string[];
    excludeDomains?: string[];
    includeRawContent?: boolean;
  }
): Promise<TavilySearchResult[]> {
  const { tavilyKey } = await getEffectiveKeys();
  if (!tavilyKey) {
    throw new TavilyAuthError('Tavily API Key missing in /admin or .env');
  }

  const isVideo = opts?.includeDomains?.some((d) => d.includes('youtube.com'));
  const excludeDomains = isVideo
    ? undefined
    : (opts?.excludeDomains ?? [...LEARNING_CONFIG.EXCLUDE_DOMAINS]);

  const body: any = {
    api_key: tavilyKey,
    query,
    search_depth: opts?.searchDepth ?? (isVideo ? 'basic' : 'advanced'),
    max_results: opts?.maxResults ?? 6,
    include_raw_content: opts?.includeRawContent ?? true,
  };

  if (opts?.includeDomains && opts.includeDomains.length > 0) {
    body.include_domains = opts.includeDomains;
  }
  if (excludeDomains && excludeDomains.length > 0) {
    body.exclude_domains = excludeDomains;
  }

  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });

    if (res.status === 401 || res.status === 403) {
      throw new TavilyAuthError(`Tavily auth failed: ${res.statusText}`);
    }
    if (!res.ok) {
      return [];
    }

    const data: any = await res.json();
    const results = data?.results || [];
    return results.map((r: any) => ({
      title: r.title || '',
      url: r.url || '',
      content: r.content || '',
      rawContent: r.raw_content || r.content || '',
      score: typeof r.score === 'number' ? r.score : 0,
    }));
  } catch (err: any) {
    if (err instanceof TavilyAuthError) throw err;
    return [];
  }
}

// 7.3 URL IDENTITY AND SAFETY
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

export function canonicalKey(raw: string): string {
  try {
    const yt = extractYouTubeId(raw);
    if (yt) return `yt:${yt}`;
    const u = new URL(raw);
    const host = u.hostname.toLowerCase().replace(/^(www|m|amp)\./, '');
    if (/(^|\.)wikipedia\.org$/.test(host) && u.pathname.startsWith('/wiki/')) {
      return `wiki:${decodeURIComponent(u.pathname.slice(6)).toLowerCase().replace(/_/g, ' ')}`;
    }
    const path = u.pathname.toLowerCase().replace(/\/(index\.(html?|php)|amp)$/, '').replace(/\/+$/, '');
    const keep = ['v', 'id', 'p', 'article'];
    const qs = [...u.searchParams].filter(([k]) => keep.includes(k)).map(([k, v]) => `${k}=${v}`).sort().join('&');
    return `${host}${path}${qs ? '?' + qs : ''}`;
  } catch {
    return raw.toLowerCase();
  }
}

export function registrableDomain(raw: string): string {
  try {
    const parts = new URL(raw).hostname.toLowerCase().replace(/^www\./, '').split('.');
    const sld = ['co', 'com', 'org', 'ac', 'gov', 'net'];
    return parts.length >= 3 && parts[parts.length - 1].length === 2 && sld.includes(parts[parts.length - 2])
      ? parts.slice(-3).join('.')
      : parts.slice(-2).join('.');
  } catch {
    return raw;
  }
}

export function titleSimilarity(a: string, b: string): number {
  const t = (s: string) => new Set(s.toLowerCase().split(/\W+/).filter((w) => w.length > 2));
  const A = t(a), B = t(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  A.forEach((w) => {
    if (B.has(w)) inter++;
  });
  return inter / (A.size + B.size - inter);
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
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    })
  );
  return out;
}

export function assertNoUrls(value: unknown, label: string): void {
  if (/https?:\/\/|www\./i.test(JSON.stringify(value))) {
    throw new Error(`${label}: model output contained a URL (URLs may only come from Tavily)`);
  }
}

// 7.4 LINK HEALTH
export async function checkYouTube(id: string): Promise<{
  status: 'EMBEDDABLE' | 'NO_EMBED' | 'GONE' | 'UNKNOWN';
  title?: string;
  channel?: string;
}> {
  try {
    const r = await fetch(
      'https://www.youtube.com/oembed?format=json&url=' +
        encodeURIComponent('https://www.youtube.com/watch?v=' + id),
      { signal: AbortSignal.timeout(4000) }
    );
    if (r.ok) {
      const j: any = await r.json();
      return {
        status: 'EMBEDDABLE',
        title: j.title as string,
        channel: j.author_name as string,
      };
    }
    if (r.status === 401 || r.status === 403) return { status: 'NO_EMBED' };
    if (r.status === 404 || r.status === 400) return { status: 'GONE' };
    return { status: 'UNKNOWN' };
  } catch {
    return { status: 'UNKNOWN' };
  }
}

const SOFT_404 =
  /(page not found|404 not found|no longer available|this video is unavailable|content (has been )?removed|does not exist)/i;

export async function verifyLink(url: string, sampleText?: string): Promise<LinkStatus> {
  if (!(await isSafePublicUrl(url))) return 'DEAD';
  if (sampleText && SOFT_404.test(sampleText.slice(0, 600))) return 'DEAD';
  const id = extractYouTubeId(url);
  if (id) {
    const y = await checkYouTube(id);
    return y.status === 'GONE' ? 'DEAD' : y.status === 'UNKNOWN' ? 'UNCHECKED' : 'VERIFIED';
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
      // timeout/network: try next method
    }
  }
  return 'UNCHECKED';
}

// 7.5 PARAPHRASE GUARD
export function sharesLongRun(
  source: string,
  output: string,
  maxRun = LEARNING_CONFIG.MAX_SHARED_RUN_WORDS
): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(Boolean);
  const src = norm(source),
    out = norm(output),
    n = maxRun + 1;
  const grams = new Set<string>();
  for (let i = 0; i + n <= src.length; i++) grams.add(src.slice(i, i + n).join(' '));
  for (let i = 0; i + n <= out.length; i++) if (grams.has(out.slice(i, i + n).join(' '))) return true;
  return false;
}

// 7.6 WIKIPEDIA FALLBACK
export async function fetchWikipediaExtract(query: string): Promise<{
  title: string;
  url: string;
  text: string;
} | null> {
  try {
    const headers = {
      'User-Agent': `SkillTrack/1.0 (${process.env.WIKI_CONTACT ?? 'educational-app'})`,
      Accept: 'application/json',
    };
    const s = await fetch(
      'https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&formatversion=2&srlimit=3&srsearch=' +
        encodeURIComponent(query),
      { headers, signal: AbortSignal.timeout(6000) }
    );
    if (!s.ok) return null;
    const sJson: any = await s.json();
    const title = sJson?.query?.search?.[0]?.title;
    if (!title) return null;
    const e = await fetch(
      'https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&redirects=1&format=json&formatversion=2&titles=' +
        encodeURIComponent(title),
      { headers, signal: AbortSignal.timeout(8000) }
    );
    if (!e.ok) return null;
    const eJson: any = await e.json();
    const page = eJson?.query?.pages?.[0];
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
