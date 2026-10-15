import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { getEffectiveKeys } from '../../lib/keyManager';
import {
  LEARNING_CONFIG,
  BLOCKED_DOMAINS,
  DIFFICULTY_TIERS,
  DifficultyTier,
} from '../../config/learning';

export type LinkStatus = 'VERIFIED' | 'UNCHECKED' | 'DEAD';
export type YouTubeCheck = {
  status: 'EMBEDDABLE' | 'NO_EMBED' | 'GONE' | 'UNKNOWN';
  title?: string;
  channel?: string;
};

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

// 6.1 GROQ CALL WITH JSON VALIDATION AND RETRY
let cachedGroqModel: string | null = null;
let cachedGroqModelExpires = 0;

export async function getBestGroqModel(apiKey: string): Promise<string> {
  if (process.env.GROQ_MODEL && process.env.GROQ_MODEL.trim()) {
    return process.env.GROQ_MODEL.trim();
  }
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
      const preferred = [
        'llama-3.3-70b-versatile',
        'llama-3.1-70b-versatile',
        'openai/gpt-oss-120b',
        'openai/gpt-oss-20b',
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
  return 'llama-3.3-70b-versatile';
}

function cleanJsonCodeFences(text: string): string {
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '');
    cleaned = cleaned.replace(/\s*```$/, '');
  }
  return cleaned.trim();
}

export function extractAndParseJson<T = any>(rawText: string): T {
  const cleaned = cleanJsonCodeFences(rawText);
  try {
    return JSON.parse(cleaned);
  } catch (err: any) {
    // 1. Try finding outermost matching braces
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        const sliced = cleaned.slice(firstBrace, lastBrace + 1);
        return JSON.parse(sliced);
      } catch (_) {}
    }

    // 2. Try repairing trailing commas or missing closing braces if cut off
    let repaired = cleaned;
    // Strip trailing commas before closing braces/brackets
    repaired = repaired.replace(/,\s*([}\]])/g, '$1');

    // Count unbalanced quotes, braces, brackets
    let inString = false;
    let escape = false;
    let openBraces = 0;
    let openBrackets = 0;

    for (let i = 0; i < repaired.length; i++) {
      const c = repaired[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (c === '\\') {
        escape = true;
        continue;
      }
      if (c === '"') {
        inString = !inString;
        continue;
      }
      if (!inString) {
        if (c === '{') openBraces++;
        else if (c === '}') openBraces = Math.max(0, openBraces - 1);
        else if (c === '[') openBrackets++;
        else if (c === ']') openBrackets = Math.max(0, openBrackets - 1);
      }
    }

    if (inString) repaired += '"';
    repaired = repaired.replace(/,\s*$/, '');
    for (let i = 0; i < openBrackets; i++) repaired += ']';
    for (let i = 0; i < openBraces; i++) repaired += '}';

    try {
      return JSON.parse(repaired);
    } catch (_) {}

    throw err;
  }
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
  let currentMaxTokens = Math.min(8192, opts.maxTokens ?? 4500);
  const temperature = opts.temperature ?? 0.2;

  let currentUserPrompt = userPrompt;
  let attempts = 0;
  const maxAttempts = (opts.retryCount ?? 1) + 2; // Extra recovery headroom for token limit healing
  let forceJsonMode = true;

  while (attempts < maxAttempts) {
    attempts++;
    let rateLimitRetries = 0;

    let res: Response | null = null;
    while (rateLimitRetries <= 2) {
      try {
        const bodyPayload: Record<string, any> = {
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: currentUserPrompt },
          ],
          max_tokens: currentMaxTokens,
          temperature,
        };

        if (forceJsonMode) {
          bodyPayload.response_format = { type: 'json_object' };
        }

        res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${groqKey}`,
          },
          body: JSON.stringify(bodyPayload),
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

      // Handle Groq 400 token limit exhaustion / json_validate_failed
      if (
        errBody.includes('max completion tokens') ||
        errBody.includes('json_validate_failed') ||
        (res && res.status === 400 && errBody.includes('Failed to generate JSON'))
      ) {
        console.warn(
          `[callGroqJson] Groq token truncation / json_validate_failed (current tokens: ${currentMaxTokens}). Scaling tokens & requesting conciseness.`
        );
        // Scale max_tokens up to Groq's maximum output limit (8192)
        currentMaxTokens = Math.min(8192, Math.max(currentMaxTokens + 3000, 7800));
        currentUserPrompt = `${userPrompt}\n\nCRITICAL CONSTRAINTS: Your previous response exceeded the completion token limit and was truncated before the JSON document closed. Be concise, direct, and avoid filler words or excessive verbosity. Return ONLY complete, valid JSON adhering to the schema so the entire document fits within limits.`;

        // If on next-to-last attempt and still failing json_validate_failed, try omitting response_format: { type: 'json_object' }
        if (attempts >= maxAttempts - 1) {
          forceJsonMode = false;
        }

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
      const parsed = extractAndParseJson(rawJsonText);
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

// 6.2 TAVILY SEARCH
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
    : (opts?.excludeDomains ?? [...BLOCKED_DOMAINS]);

  const body: any = {
    api_key: tavilyKey,
    query,
    search_depth: opts?.searchDepth ?? (isVideo ? 'basic' : 'advanced'),
    max_results: opts?.maxResults ?? 8,
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

// 6.3 IDENTITY AND SAFETY HELPERS
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
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid', 'si'].forEach(
      (p) => u.searchParams.delete(p)
    );
    const host = u.hostname.replace(/^(www|m)\./, '').toLowerCase();
    const path = u.pathname.replace(/\/+$/, '').replace(/\/(amp|index\.(html?|php))$/i, '');
    const qs = u.searchParams.toString();
    return `${host}${path}${qs ? '?' + qs : ''}`;
  } catch {
    return raw;
  }
}

export const domainOf = (raw: string): string => {
  try {
    return new URL(raw).hostname.replace(/^(www|m|amp)\./, '').toLowerCase();
  } catch {
    return 'unknown';
  }
};

export function contentFingerprint(title: string, text: string): string {
  const n = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  return createHash('sha1')
    .update(n(title).slice(0, 80) + '|' + n(text).slice(0, 400))
    .digest('hex');
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
  if (/https?:\/\/\S+/i.test(JSON.stringify(value))) {
    throw new Error(`${label}: model output contained a URL (URLs only come from Tavily)`);
  }
}

export function hasVerbatimRun(
  generated: string,
  source: string,
  run = LEARNING_CONFIG.VERBATIM_RUN_WORDS
): boolean {
  const clean = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const words = clean(generated).split(' ').filter(Boolean);
  const src = ' ' + clean(source) + ' ';
  for (let i = 0; i + run <= words.length; i++) {
    if (src.includes(' ' + words.slice(i, i + run).join(' ') + ' ')) return true;
  }
  return false;
}

// 6.4 LINK HEALTH AND THE NO-LOGIN RULE
const LOGIN_PATH =
  /(^|\/)(login|log-in|signin|sign-in|signup|sign-up|register|subscribe|paywall)(\/|$)/i;
const WALL_TEXT =
  /(sign in to (continue|read|view)|log in to (continue|read|view)|create (a|your) (free )?account|subscribe to (read|continue)|members[- ]only|premium content|reached your (free )?(article|reading) limit)/i;
const SOFT_404 =
  /(page not found|404 not found|no longer available|this video is unavailable|content (has been )?removed)/i;

export const isBlockedDomain = (url: string) =>
  BLOCKED_DOMAINS.some((d) => domainOf(url) === d || domainOf(url).endsWith('.' + d));

export function looksWalled(finalUrl: string, text?: string): boolean {
  try {
    if (LOGIN_PATH.test(new URL(finalUrl).pathname)) return true;
  } catch {
    return true;
  }
  if (isBlockedDomain(finalUrl)) return true;
  return !!text && (WALL_TEXT.test(text.slice(0, 3000)) || SOFT_404.test(text.slice(0, 600)));
}

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

export async function verifyLink(
  url: string,
  sampleText?: string
): Promise<{ status: LinkStatus; finalUrl: string }> {
  if (!url || !/^https?:\/\//i.test(url) || !(await isSafePublicUrl(url))) {
    return { status: 'DEAD', finalUrl: url };
  }
  const yt = extractYouTubeId(url);
  if (yt) {
    const c = await checkYouTube(yt);
    return {
      status: c.status === 'GONE' ? 'DEAD' : c.status === 'UNKNOWN' ? 'UNCHECKED' : 'VERIFIED',
      finalUrl: url,
    };
  }
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LEARNING_CONFIG.LINK_VERIFY_TIMEOUT_MS || 2500);
    const res = await fetch(url, {
      method: 'HEAD',
      headers,
      redirect: 'follow',
      signal: controller.signal,
    });
    clearTimeout(timer);
    const finalUrl = res.url || url;
    if (res.status === 404 || res.status === 410) {
      return { status: 'DEAD', finalUrl };
    }
    return { status: res.ok ? 'VERIFIED' : 'UNCHECKED', finalUrl };
  } catch {
    // Timeout, CORS, or anti-bot challenge -> valid clickable web link for browser
    return { status: 'UNCHECKED', finalUrl: url };
  }
}

// 6.5 LEVEL FIT
const BEGINNER_HINT =
  /\b(beginner|beginners|intro|introduction|101|basics|basic|getting started|for dummies|crash course)\b/i;
const ADVANCED_HINT =
  /\b(advanced|expert|masterclass|in[- ]depth|deep dive|research|elite)\b/i;

export function levelFitScore(tier: DifficultyTier, text: string): number {
  const i = DIFFICULTY_TIERS.indexOf(tier);
  let s = 0;
  if (BEGINNER_HINT.test(text)) s += i <= 1 ? 1 : i === 2 ? -1 : -3;
  if (ADVANCED_HINT.test(text)) s += i >= 3 ? 1 : i === 2 ? 0 : -3;
  return s;
}

// Legacy helper aliases for smooth integration
export const canonicalKey = normalizeUrl;
export const registrableDomain = domainOf;
export function titleSimilarity(a: string, b: string): number {
  const t = (s: string) => new Set(s.toLowerCase().split(/\W+/).filter((w) => w.length > 2));
  const A = t(a),
    B = t(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  A.forEach((w) => {
    if (B.has(w)) inter++;
  });
  return inter / (A.size + B.size - inter);
}
export const sharesLongRun = (source: string, output: string) => hasVerbatimRun(output, source);

// Wikipedia API helper for last-resort recovery (P6) with fallback query support
export async function fetchWikipediaExtract(
  query: string,
  fallbackQuery?: string
): Promise<{
  title: string;
  url: string;
  text: string;
} | null> {
  const headers = {
    'User-Agent': 'SkillTrack/1.0 (educational-app)',
    Accept: 'application/json',
  };

  const trySearch = async (searchTerm: string) => {
    try {
      const s = await fetch(
        'https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&formatversion=2&srlimit=3&srsearch=' +
          encodeURIComponent(searchTerm),
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
      if (text.length < 350) return null;
      return {
        title: page.title as string,
        url: 'https://en.wikipedia.org/wiki/' + encodeURIComponent(String(page.title).replace(/ /g, '_')),
        text,
      };
    } catch {
      return null;
    }
  };

  const primary = await trySearch(query);
  if (primary) return primary;

  if (fallbackQuery && fallbackQuery.trim() !== query.trim()) {
    const fallback = await trySearch(fallbackQuery);
    if (fallback) return fallback;
  }

  return null;
}

// 6.5 PROGRESSIVE 3-STAGE YOUTUBE SEARCH (ANTI-REPETITION)
export async function findUniqueYouTubeVideo(
  skillName: string,
  subGenre: string,
  chapterOrStepTitle: string,
  usedVideoIds: Set<string>
): Promise<{ videoId: string; title: string; channel: string } | null> {
  const cleanSkill = (skillName || '').replace(/["']/g, '').trim();
  const cleanTitle = (chapterOrStepTitle || '').replace(/["']/g, '').trim();
  const cleanSub = (subGenre || '').replace(/["']/g, '').trim();

  // Attempt 1 (Specific): Tavily search `${skillName} ${chapterOrStepTitle} tutorial`
  try {
    const q1 = `${cleanSkill} ${cleanTitle} tutorial`.trim();
    const res1 = await searchTavily(q1, {
      searchDepth: 'basic',
      maxResults: 10,
      includeDomains: ['youtube.com', 'youtu.be'],
      includeRawContent: false,
    });
    for (const r of res1) {
      const vId = extractYouTubeId(r.url);
      if (vId && !usedVideoIds.has(vId) && vId !== 'dQw4w9WgXcQ' && vId !== 'kJQP7kiw5Fk' && vId !== 'dQ3GLk1jUqI') {
        const ytCheck = await checkYouTube(vId);
        if (ytCheck.status !== 'GONE') {
          return {
            videoId: vId,
            title: ytCheck.title || r.title || `${cleanTitle} Tutorial`,
            channel: ytCheck.channel || r.title?.split('-')[0]?.trim() || 'Verified Channel',
          };
        }
      }
    }
  } catch (err) {
    console.warn('[findUniqueYouTubeVideo] Attempt 1 notice:', err);
  }

  // Attempt 2 (Broader): If Attempt 1 yields no unused 11-char videoId, search `${skillName} ${subGenre} ${chapterOrStepTitle}`
  try {
    const q2 = `${cleanSkill} ${cleanSub} ${cleanTitle}`.trim();
    const res2 = await searchTavily(q2, {
      searchDepth: 'basic',
      maxResults: 10,
      includeDomains: ['youtube.com', 'youtu.be'],
      includeRawContent: false,
    });
    for (const r of res2) {
      const vId = extractYouTubeId(r.url);
      if (vId && !usedVideoIds.has(vId) && vId !== 'dQw4w9WgXcQ' && vId !== 'kJQP7kiw5Fk' && vId !== 'dQ3GLk1jUqI') {
        const ytCheck = await checkYouTube(vId);
        if (ytCheck.status !== 'GONE') {
          return {
            videoId: vId,
            title: ytCheck.title || r.title || `${cleanTitle} Walkthrough`,
            channel: ytCheck.channel || r.title?.split('-')[0]?.trim() || 'Verified Channel',
          };
        }
      }
    }
  } catch (err) {
    console.warn('[findUniqueYouTubeVideo] Attempt 2 notice:', err);
  }

  // Attempt 3 (Public YouTube Search Scrape Fallback)
  try {
    const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(cleanSkill + ' ' + cleanTitle + ' tutorial')}`;
    const ytHtmlRes = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (ytHtmlRes.ok) {
      const html = await ytHtmlRes.text();
      const matches = Array.from(html.matchAll(/"videoId":"([a-zA-Z0-9_-]{11})"/g));
      for (const m of matches) {
        const vId = m[1];
        if (vId && !usedVideoIds.has(vId) && vId !== 'dQw4w9WgXcQ' && vId !== 'kJQP7kiw5Fk' && vId !== 'dQ3GLk1jUqI') {
          const ytCheck = await checkYouTube(vId);
          if (ytCheck.status !== 'GONE') {
            return {
              videoId: vId,
              title: ytCheck.title || `${cleanTitle} - ${cleanSkill} Masterclass`,
              channel: ytCheck.channel || 'YouTube Tutorial',
            };
          }
        }
      }
    }
  } catch (err) {
    console.warn('[findUniqueYouTubeVideo] Attempt 3 scrape notice:', err);
  }

  return null;
}

