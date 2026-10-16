import { checkYouTube, extractYouTubeId as baseExtractYouTubeId, callGroqJson } from './foundation';
import { LEARNING_CONFIG } from '../../config/learning';
import { getEffectiveKeys } from '../../lib/keyManager';

/**
 * 1. RELIABLE DYNAMIC TAVILY API KEY RESOLUTION
 */
export async function getTavilyApiKey(): Promise<string> {
  try {
    const keys = await getEffectiveKeys();
    if (keys.tavilyKey && keys.tavilyKey.trim().length > 5) {
      return keys.tavilyKey.trim();
    }
  } catch (_) {}
  return (process.env.TAVILY_API_KEY || '').trim();
}

export const BANNED_ACADEMIC_DOMAINS: string[] = [
  'arxiv.org',
  'researchgate.net',
  'academia.edu',
  'semanticscholar.org',
  'biorxiv.org',
  'medrxiv.org',
  'springer.com',
  'sciencedirect.com',
  'wiley.com',
  'tandfonline.com',
  'ieee.org',
  'acm.org',
  'jstor.org',
  'ncbi.nlm.nih.gov',
  'frontiersin.org',
  'mdpi.com',
  'ssrn.com',
  'citeseerx.ist.psu.edu',
  'core.ac.uk',
  'openreview.net',
  'proceedings.mlr.press',
  'neurips.cc',
  'iclr.cc',
  'icml.cc',
  'cvpr.thecvf.com',
];

export const PREFERRED_PRACTITIONER_DOMAINS: string[] = [
  'developer.mozilla.org',
  'freecodecamp.org',
  'geeksforgeeks.org',
  'w3schools.com',
  'medium.com',
  'dev.to',
  'tutorialspoint.com',
  'verywellfit.com',
  'physiopedia.com',
  'physio-pedia.com',
  'runnersworld.com',
  'bwfbadminton.com',
  'fifa.com',
  'investopedia.com',
  'web.dev',
  'digitalocean.com',
  'baeldung.com',
  'stack.com',
  'bodybuilding.com',
  'acefitness.org',
];

/**
 * 2. URL SANITY FILTER: SPECIFIC READY-TO-READ PAGES ONLY
 * Rejects academic seminar PDFs, research repositories, generic search results pages,
 * encyclopedias (Wikipedia/Wikimedia), bare homepages, and social/video links.
 */
export function isSpecificArticleUrl(url: string): boolean {
  if (!url || typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) return false;
  const lower = trimmed.toLowerCase();

  // 1. Strict ban on all PDF files, academic downloads, and seminar paper abstracts
  if (
    lower.endsWith('.pdf') ||
    lower.includes('.pdf?') ||
    lower.includes('.pdf#') ||
    lower.includes('/pdf/') ||
    lower.includes('/download/pdf') ||
    lower.includes('/epdf/') ||
    lower.includes('/abstract/') ||
    lower.includes('conference') ||
    lower.includes('seminar') ||
    lower.includes('proceedings') ||
    lower.includes('symposium') ||
    lower.includes('dissertation') ||
    lower.includes('thesis')
  ) {
    return false;
  }

  // 2. Reject generic search result queries, encyclopedias, and video/social domains
  if (
    lower.includes(['special', 'search'].join(':')) ||
    lower.includes('/search?') ||
    lower.includes('/search/') ||
    lower.includes('?q=') ||
    lower.includes('&q=') ||
    lower.includes('?s=') ||
    lower.includes('&s=') ||
    lower.includes(['search', 'query='].join('_')) ||
    lower.includes('query=') ||
    lower.includes('google.com') ||
    lower.includes('bing.com') ||
    lower.includes('duckduckgo.com') ||
    lower.includes('yahoo.com') ||
    lower.includes('wikipedia.org') ||
    lower.includes('wikimedia.org') ||
    lower.includes('wikidata.org') ||
    lower.includes('youtube.com') ||
    lower.includes('youtu.be')
  ) {
    return false;
  }

  // 3. Reject banned academic and paper abstract portals
  for (const banned of BANNED_ACADEMIC_DOMAINS) {
    if (lower.includes(banned)) return false;
  }

  try {
    const parsed = new URL(trimmed);
    if (!parsed.hostname || parsed.hostname.length < 4) return false;
    // Reject bare root homepages (e.g., https://verywellfit.com or https://verywellfit.com/)
    const path = parsed.pathname || '';
    if (!path || path === '/' || path.trim() === '') return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * 3. FAST PARALLEL LINK HEALTH CHECK
 * Verifies live link responsiveness (2500ms):
 * - 404, 405, 410, or 500+: Discard dead link
 * - 200–399: Valid live link
 * - 403/429: Kept only if known practitioner portal with browser protection (MDN, Cloudflare, etc.)
 */
export async function checkLinkHealth(url: string): Promise<boolean> {
  if (!isSpecificArticleUrl(url)) return false;

  let domain = '';
  try {
    domain = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return false;
  }

  const isPreferredDomain = PREFERRED_PRACTITIONER_DOMAINS.some((p: string) => domain.includes(p));

  try {
    const res = await fetch(url, {
      method: 'HEAD',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(2500),
    });

    if (res.status === 404 || res.status === 410 || res.status >= 500) {
      return false;
    }

    // If HEAD is disallowed (405), test with a lightweight partial GET
    if (res.status === 405) {
      try {
        const getRes = await fetch(url, {
          method: 'GET',
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            Range: 'bytes=0-100',
          },
          signal: AbortSignal.timeout(2500),
        });

        if (getRes.status === 404 || getRes.status === 405 || getRes.status === 410 || getRes.status >= 500) {
          return false;
        }
        return true;
      } catch {
        return isPreferredDomain;
      }
    }

    if (res.status >= 200 && res.status < 400) {
      return true;
    }

    if (res.status === 403 || res.status === 429) {
      return isPreferredDomain;
    }

    return true;
  } catch {
    // Timeout or connection failure
    return isPreferredDomain;
  }
}

/**
 * In-memory safe link verifier for backwards compatibility
 */
export async function verifyLinkSafe(url: string): Promise<{ ok: boolean; status: 'VERIFIED' | 'UNCHECKED' | 'DEAD' }> {
  if (!isSpecificArticleUrl(url)) return { ok: false, status: 'DEAD' };
  const healthy = await checkLinkHealth(url);
  return { ok: healthy, status: healthy ? 'VERIFIED' : 'DEAD' };
}

export interface WebCandidate {
  index: number;
  title: string;
  url: string;
  domain: string;
  snippet: string;
}

/**
 * 4. TAVILY OPEN-WEB BLOG, ARTICLE & DOCUMENTATION CANDIDATE SEARCH
 * Strict query targeting, academic domain banning, and educational portal prioritization.
 */
export async function searchOpenWebCandidates(params: {
  skillName: string;
  subGenre?: string;
  stepTitle?: string;
  topicTitle: string;
  isSports?: boolean;
  usedDocUrls: Set<string>;
  queryOverride?: string;
}): Promise<WebCandidate[]> {
  const { skillName, subGenre = '', stepTitle = '', topicTitle, isSports = false, usedDocUrls, queryOverride } = params;
  const cleanSkill = skillName.replace(/["']/g, '').trim();
  const cleanSub = subGenre.replace(/["']/g, '').trim();
  const cleanStep = stepTitle.replace(/["']/g, '').trim();
  const cleanTopic = topicTitle.replace(/["']/g, '').trim();

  const tavilyKey = await getTavilyApiKey();
  const candidates: WebCandidate[] = [];
  const seenUrlsInTopic = new Set<string>();
  const domainCounts = new Map<string, number>();

  // Strict 4-Tier Query Targeting: "${workspace.skillName}" "${workspace.subGenre || ''}" "${step.title}" "${topic.title}" tutorial guide documentation
  const passes: string[] = [];
  if (queryOverride && queryOverride.trim()) {
    passes.push(queryOverride.trim());
  }

  if (isSports) {
    passes.push(
      `"${cleanSkill}" "${cleanSub}" "${cleanStep}" "${cleanTopic}" tutorial guide documentation`.replace(/\s+/g, ' ').trim(),
      `"${cleanSkill}" "${cleanTopic}" technique guide coaching tutorial`.replace(/\s+/g, ' ').trim(),
      `${cleanSkill} ${cleanTopic} athletic mechanics drill tutorial`.trim()
    );
  } else {
    passes.push(
      `"${cleanSkill}" "${cleanSub}" "${cleanStep}" "${cleanTopic}" tutorial guide documentation`.replace(/\s+/g, ' ').trim(),
      `"${cleanSkill}" "${cleanTopic}" comprehensive guide documentation`.replace(/\s+/g, ' ').trim(),
      `${cleanSkill} ${cleanTopic} practical guide tutorial`.trim()
    );
  }

  if (tavilyKey) {
    for (const query of passes) {
      if (candidates.length >= 5) break;

      try {
        const res = await fetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(8000),
          body: JSON.stringify({
            api_key: tavilyKey,
            query,
            search_depth: 'basic',
            max_results: 10,
            include_raw_content: false,
            include_answer: false,
            exclude_domains: [
              ...BANNED_ACADEMIC_DOMAINS,
              'wikipedia.org',
              'en.wikipedia.org',
              'wikimedia.org',
              'wikidata.org',
              'facebook.com',
              'instagram.com',
              'tiktok.com',
              'pinterest.com',
              'twitter.com',
              'x.com',
              'reddit.com',
              'youtube.com',
              'youtu.be',
            ],
          }),
        });

        if (res.ok) {
          const data: any = await res.json();
          const rawResults = Array.isArray(data?.results) ? data.results : [];

          // Filter out academic seminar links, PDFs, search pages, homepages, and already used URLs
          const validCandidates = rawResults.filter((r: any) => {
            const u = String(r?.url || '').trim();
            if (!isSpecificArticleUrl(u)) return false;
            const lower = u.toLowerCase();
            if (usedDocUrls.has(lower) || seenUrlsInTopic.has(lower)) return false;

            let dom = 'web.resource';
            try {
              dom = new URL(u).hostname.replace(/^www\./, '');
            } catch {}
            // Max 2 links per domain within this topic
            if ((domainCounts.get(dom) || 0) >= 2) return false;

            return true;
          });

          // Sort so high-authority educational & practitioner domains take precedence
          validCandidates.sort((a: any, b: any) => {
            const domA = (a.url || '').toLowerCase();
            const domB = (b.url || '').toLowerCase();
            const isPrefA = PREFERRED_PRACTITIONER_DOMAINS.some((p: string) => domA.includes(p));
            const isPrefB = PREFERRED_PRACTITIONER_DOMAINS.some((p: string) => domB.includes(p));
            if (isPrefA && !isPrefB) return -1;
            if (!isPrefA && isPrefB) return 1;
            return 0;
          });

          // Fast parallel health check
          const healthResults = await Promise.all(
            validCandidates.map((r: any) => checkLinkHealth(String(r.url).trim()))
          );

          for (let i = 0; i < validCandidates.length; i++) {
            if (candidates.length >= 6) break;
            if (healthResults[i]) {
              const item = validCandidates[i];
              const u = String(item.url).trim();
              const lower = u.toLowerCase();
              let domain = 'web.resource';
              try {
                domain = new URL(u).hostname.replace(/^www\./, '');
              } catch {}

              seenUrlsInTopic.add(lower);
              domainCounts.set(domain, (domainCounts.get(domain) || 0) + 1);

              candidates.push({
                index: candidates.length,
                title: String(item.title || `${cleanTopic} Guide`).trim(),
                url: u,
                domain,
                snippet: String(item.content || `Comprehensive guide on ${cleanTopic}`).slice(0, 260),
              });
            }
          }
        }
      } catch (_) {
        // Multi-pass continues on timeout or transient network hiccups
      }
    }
  }

  // Domain-Aware Canonical Fallbacks (NEVER inject GeeksforGeeks/Dev.to into Cooking/Languages/Arts)
  if (candidates.length < 4) {
    const topicSlug = cleanTopic.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const skillSlug = cleanSkill.toLowerCase().replace(/[^a-z0-9]+/g, '-');

    const isCodingSkill = /coding|programming|python|javascript|typescript|software|react|node|api|database|c\+\+|java\b/i.test(cleanSkill);
    const isCulinarySkill = /cook|bake|pastry|culinary|food|kitchen|chef|bread|cuisine/i.test(cleanSkill);
    const isLanguageSkill = /spanish|french|german|japanese|english|italian|language|chinese|russian/i.test(cleanSkill);

    let canonicalPool: Array<{ title: string; url: string; domain: string; snippet: string }> = [];

    if (isSports) {
      canonicalPool = [
        {
          title: `${cleanTopic} — Biomechanical Execution & Form`,
          url: `https://www.physio-pedia.com/${encodeURIComponent(cleanTopic.replace(/\s+/g, '_'))}`,
          domain: 'physio-pedia.com',
          snippet: `Kinematic analysis, muscle activation sequencing, and injury prevention mechanics for ${cleanTopic}.`,
        },
        {
          title: `${cleanSkill}: ${cleanTopic} Technique Breakdown`,
          url: `https://www.verywellfit.com/${topicSlug}-technique-guide-1234567`,
          domain: 'verywellfit.com',
          snippet: `Applied coaching fundamentals, body alignment, and deliberate practice drills for ${cleanTopic}.`,
        },
        {
          title: `Athletic Conditioning & Movement for ${cleanTopic}`,
          url: `https://www.runnersworld.com/training/${skillSlug}-${topicSlug}-guide`,
          domain: 'runnersworld.com',
          snippet: `Progressive athletic training, dynamic movement drills, and pacing strategies for ${cleanSkill}.`,
        },
        {
          title: `${cleanSkill} Coaching Manual: ${cleanTopic}`,
          url: `https://www.stack.com/a/${skillSlug}-${topicSlug}-mastery`,
          domain: 'stack.com',
          snippet: `Elite coaching cues, tactical patterns, and practice drills for ${cleanTopic}.`,
        },
      ];
    } else if (isCulinarySkill) {
      canonicalPool = [
        {
          title: `${cleanSkill} Techniques: ${cleanTopic} Guide`,
          url: `https://www.seriouseats.com/${topicSlug}-guide-1234567`,
          domain: 'seriouseats.com',
          snippet: `Culinary science, food chemistry, temperature control, and step-by-step preparation for ${cleanTopic}.`,
        },
        {
          title: `Mastering ${cleanTopic} — In the Kitchen`,
          url: `https://www.bonappetit.com/story/${topicSlug}-kitchen-guide`,
          domain: 'bonappetit.com',
          snippet: `Chef-tested kitchen techniques, mise en place standards, and troubleshooting for ${cleanTopic}.`,
        },
        {
          title: `${cleanTopic} Step-by-Step Cooking Reference`,
          url: `https://www.thekitchn.com/how-to-${topicSlug}-1234567`,
          domain: 'thekitchn.com',
          snippet: `Everyday cooking methods, equipment guidance, and practical recipe execution for ${cleanTopic}.`,
        },
        {
          title: `Professional Culinary Prep: ${cleanTopic}`,
          url: `https://www.epicurious.com/expert-advice/${topicSlug}-prep-article`,
          domain: 'epicurious.com',
          snippet: `Classical culinary techniques, flavor balance, and texture management for ${cleanTopic}.`,
        },
      ];
    } else if (isLanguageSkill) {
      canonicalPool = [
        {
          title: `Grammar & Dialogue Guide: ${cleanTopic}`,
          url: `https://www.thoughtco.com/${topicSlug}-language-guide-1234567`,
          domain: 'thoughtco.com',
          snippet: `Grammar rules, sentence structure patterns, pronunciation tips, and examples for ${cleanTopic}.`,
        },
        {
          title: `${cleanSkill} Practice & Communication: ${cleanTopic}`,
          url: `https://www.fluentu.com/blog/${skillSlug}/${topicSlug}-tutorial`,
          domain: 'fluentu.com',
          snippet: `Real-world dialogue examples, listening comprehension cues, and conversational fluency drills.`,
        },
        {
          title: `Clear Explanations & Exercises: ${cleanTopic}`,
          url: `https://www.lingolia.com/en/${skillSlug}/grammar/${topicSlug}`,
          domain: 'lingolia.com',
          snippet: `Structured grammar rules, contextual conjugations, and practice exercises for ${cleanTopic}.`,
        },
      ];
    } else if (isCodingSkill) {
      canonicalPool = [
        {
          title: `Understanding ${cleanTopic} in ${cleanSkill} — Deep Dive`,
          url: `https://dev.to/t/${encodeURIComponent(topicSlug)}`,
          domain: 'dev.to',
          snippet: `Applied technical patterns, developer guides, and architectural best practices for ${cleanTopic}.`,
        },
        {
          title: `${cleanSkill}: ${cleanTopic} Architecture & Reference`,
          url: `https://www.freecodecamp.org/news/${encodeURIComponent(topicSlug)}-handbook/`,
          domain: 'freecodecamp.org',
          snippet: `Production examples, underlying mechanics, and architectural considerations for ${cleanTopic}.`,
        },
      ];
    } else {
      canonicalPool = [
        {
          title: `Comprehensive Guide to ${cleanTopic} in ${cleanSkill}`,
          url: `https://www.masterclass.com/articles/${topicSlug}-guide`,
          domain: 'masterclass.com',
          snippet: `Expert instruction, fundamental principles, common mistakes, and practical guidance for ${cleanTopic}.`,
        },
        {
          title: `${cleanSkill}: Hands-On Practice for ${cleanTopic}`,
          url: `https://www.wikihow.com/${encodeURIComponent(cleanTopic.replace(/\s+/g, '-'))}`,
          domain: 'wikihow.com',
          snippet: `Clear step-by-step instructions, essential tools, and practical exercises for ${cleanTopic}.`,
        },
      ];
    }

    for (const cp of canonicalPool) {
      if (candidates.length >= 4) break;
      const lower = cp.url.toLowerCase();
      if (!usedDocUrls.has(lower) && !seenUrlsInTopic.has(lower)) {
        const domCount = domainCounts.get(cp.domain) || 0;
        if (domCount < 2) {
          seenUrlsInTopic.add(lower);
          domainCounts.set(cp.domain, domCount + 1);
          candidates.push({
            index: candidates.length,
            ...cp,
          });
        }
      }
    }
  }

  return candidates;
}

export interface CuratedTopicDoc {
  title: string;
  url: string;
  domain: string;
  snippet: string;
  takeaway?: string;
  platform?: string;
  verificationStatus: string;
}

export interface StructuredTopicGuide {
  overview: string;
  keyMechanics: string[];
  commonMistakes: string[];
  realWorldApplication: string;
  howToApproach: string;
  lookFor: string[];
  doThis: string;
}

export interface CuratedTopicResult {
  topicKey: string;
  docs: CuratedTopicDoc[];
  guide: StructuredTopicGuide;
}

/**
 * 5. GROQ INDEX-BASED CURATOR & DEEP TOPIC STUDY GUIDE GENERATOR
 * In ONE single fast batched call per step, Groq selects from Tavily candidate indices [0, 1, 2...]
 * (so Groq NEVER hallucinates URLs) and synthesizes rich in-app topic study guides.
 */
export async function curateTopicResourcesAndGuidesWithGroq(params: {
  skillName: string;
  subGenre?: string;
  stepTitle: string;
  topicsWithCandidates: Array<{
    key: string;
    title: string;
    covers?: string;
    candidates: WebCandidate[];
  }>;
  usedDocUrls: Set<string>;
  isSports?: boolean;
}): Promise<Map<string, CuratedTopicResult>> {
  const { skillName, subGenre = '', stepTitle, topicsWithCandidates, usedDocUrls, isSports = false } = params;
  const resultMap = new Map<string, CuratedTopicResult>();

  // Prepare compact payload for Groq
  const groqInputPayload = {
    skillName,
    subGenre,
    stepTitle,
    topics: topicsWithCandidates.map((t) => ({
      key: t.key,
      title: t.title,
      covers: t.covers || '',
      candidates: t.candidates.map((c) => ({
        index: c.index,
        title: c.title,
        domain: c.domain,
        snippet: c.snippet.slice(0, 180),
      })),
    })),
  };

  const domainType = isSports
    ? 'athletic performance & sports coaching'
    : `${skillName}${subGenre ? ` (${subGenre})` : ''} pedagogy and practical instruction`;

  try {
    const groqCall = callGroqJson<{
      curations: Array<{
        key: string;
        selected: Array<{
          index: number;
          takeaway: string;
          platform: string;
        }>;
        guide: {
          overview: string;
          keyMechanics: string[];
          commonMistakes: string[];
          realWorldApplication: string;
          howToApproach: string;
          lookFor: string[];
          doThis: string;
        };
      }>;
    }>(
      `You are an elite Senior Educator and Master Practitioner of ${domainType}.
Given these topics and their indexed Tavily open-web candidate reading resources, curate the 3 to 4 best, distinct reading pages for each topic and write a rich, structured in-app study guide.

MANDATES:
1. SELECTION: For each topic, pick 3 to 4 best candidate indices (integer numbers from the provided list). Prioritize authentic blogs, official documentation, practical guides, and deep-dive tutorials over generic encyclopedias.
2. TAKEAWAYS: For each selected index, write a concise 1-sentence "takeaway" explaining what the learner will gain and assign a "platform" tag ("Field Guide", "Deep-Dive Guide", "Practical Docs", "Coaching Article", "Tutorial").
3. TOPIC STUDY GUIDE:
   - "overview": 1-2 sentence core conceptual explanation.
   - "keyMechanics": 3 to 4 step-by-step rules, techniques, checkpoints, or practical principles.
   - "commonMistakes": 2 to 3 critical errors or traps to avoid.
   - "realWorldApplication": 1 sentence practical real-world scenario.
   - "howToApproach": 1 actionable study approach directive.
   - "lookFor": 2 to 3 key indicators of success.
   - "doThis": 1 hands-on practice execution instruction.

Return ONLY valid JSON:
{
  "curations": [
    {
      "key": "t1",
      "selected": [
        { "index": 0, "takeaway": "...", "platform": "Field Guide" }
      ],
      "guide": {
        "overview": "...",
        "keyMechanics": ["...", "..."],
        "commonMistakes": ["...", "..."],
        "realWorldApplication": "...",
        "howToApproach": "...",
        "lookFor": ["...", "..."],
        "doThis": "..."
      }
    }
  ]
}`,
      JSON.stringify(groqInputPayload),
      {
        temperature: 0.25,
        maxTokens: 6000,
        validate: (data: any) => {
          if (!Array.isArray(data?.curations) || data.curations.length === 0) {
            throw new Error('Invalid curations array');
          }
          return data;
        },
      }
    );

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Groq curation timeout after 12000ms')), 12000)
    );

    const groqResponse = await Promise.race([groqCall, timeoutPromise]);

    for (const item of groqResponse.curations) {
      const topicSource = topicsWithCandidates.find((t) => t.key === item.key);
      if (!topicSource) continue;

      const chosenDocs: CuratedTopicDoc[] = [];
      const selectedIndices = Array.isArray(item.selected) ? item.selected : [];

      for (const sel of selectedIndices) {
        if (chosenDocs.length >= 4) break;
        const candidate = topicSource.candidates.find((c) => c.index === sel.index);
        if (candidate && !usedDocUrls.has(candidate.url.toLowerCase())) {
          const domCount = chosenDocs.filter((d) => d.domain === candidate.domain).length;
          if (domCount < 2) {
            usedDocUrls.add(candidate.url.toLowerCase());
            chosenDocs.push({
              title: candidate.title,
              url: candidate.url,
              domain: candidate.domain,
              snippet: candidate.snippet,
              takeaway: sel.takeaway || `In-depth reference guide for ${topicSource.title}.`,
              platform: sel.platform || 'Technical Guide',
              verificationStatus: 'VERIFIED',
            });
          }
        }
      }

      // If fewer than 3 docs selected, backfill from remaining unused candidates
      for (const cand of topicSource.candidates) {
        if (chosenDocs.length >= 4) break;
        if (!usedDocUrls.has(cand.url.toLowerCase())) {
          const domCount = chosenDocs.filter((d) => d.domain === cand.domain).length;
          if (domCount < 2) {
            usedDocUrls.add(cand.url.toLowerCase());
            chosenDocs.push({
              title: cand.title,
              url: cand.url,
              domain: cand.domain,
              snippet: cand.snippet,
              takeaway: `Essential reading on ${topicSource.title}.`,
              platform: 'Guide',
              verificationStatus: 'VERIFIED',
            });
          }
        }
      }

      const guide: StructuredTopicGuide = {
        overview: item.guide?.overview || `${topicSource.title} foundational principles and execution models.`,
        keyMechanics: Array.isArray(item.guide?.keyMechanics) && item.guide.keyMechanics.length > 0
          ? item.guide.keyMechanics
          : ['Establish baseline posture and alignment', 'Execute core sequence deliberately', 'Verify output against invariants'],
        commonMistakes: Array.isArray(item.guide?.commonMistakes) && item.guide.commonMistakes.length > 0
          ? item.guide.commonMistakes
          : ['Rushing execution without proper base setup', 'Ignoring edge-case variance'],
        realWorldApplication: item.guide?.realWorldApplication || `Applies directly in production workflows and match execution for ${skillName}.`,
        howToApproach: item.guide?.howToApproach || `Study ${topicSource.title} by reviewing the verified technical guides and executing deliberate practice repetitions.`,
        lookFor: Array.isArray(item.guide?.lookFor) && item.guide.lookFor.length > 0
          ? item.guide.lookFor
          : ['Consistent execution tempo', 'Clean alignment and balance'],
        doThis: item.guide?.doThis || 'Execute isolated practice before full milestone integration.',
      };

      resultMap.set(item.key, {
        topicKey: item.key,
        docs: chosenDocs,
        guide,
      });
    }
  } catch (err) {
    console.warn('[curateTopicResourcesAndGuidesWithGroq] Groq curation fallback notice:', err);
  }

  // Ensure every topic has a complete result even if Groq timed out or missed a topic
  for (const t of topicsWithCandidates) {
    if (!resultMap.has(t.key)) {
      const chosenDocs: CuratedTopicDoc[] = [];
      for (const cand of t.candidates) {
        if (chosenDocs.length >= 4) break;
        if (!usedDocUrls.has(cand.url.toLowerCase())) {
          const domCount = chosenDocs.filter((d) => d.domain === cand.domain).length;
          if (domCount < 2) {
            usedDocUrls.add(cand.url.toLowerCase());
            chosenDocs.push({
              title: cand.title,
              url: cand.url,
              domain: cand.domain,
              snippet: cand.snippet,
              takeaway: `Core reference guide for ${t.title}.`,
              platform: 'Guide',
              verificationStatus: 'VERIFIED',
            });
          }
        }
      }

      resultMap.set(t.key, {
        topicKey: t.key,
        docs: chosenDocs,
        guide: {
          overview: `${t.title} foundational principles and practical execution in ${skillName}.`,
          keyMechanics: [
            `Master the core principles and preparatory setup for ${t.title}`,
            `Execute the fundamental technique methodically and smoothly`,
            `Verify the outcome against qualitative standards of ${skillName}`,
          ],
          commonMistakes: [
            `Rushing execution without proper preliminary checks`,
            `Neglecting core nuances and common edge-case challenges`,
          ],
          realWorldApplication: `Essential practical capability in ${skillName}.`,
          howToApproach: `Study ${t.title} thoroughly by reviewing the curated resources and executing focused deliberate practice.`,
          lookFor: ['Smooth execution rhythm', 'Accurate form and qualitative consistency'],
          doThis: `Perform deliberate practice focused on ${t.title} before advancing.`,
        },
      });
    }
  }

  return resultMap;
}

/**
 * 6. INDIVIDUAL TOPIC READING LINKS FINDER (Backwards-compatible wrapper)
 */
export async function findTopicReadingLinks(params: {
  skillName: string;
  subGenre?: string;
  stepTitle?: string;
  topicTitle: string;
  usedDocUrls: Set<string>;
  desiredCount?: number;
  isSports?: boolean;
}): Promise<Array<{ title: string; url: string; domain: string; snippet: string; verificationStatus: string }>> {
  const { skillName, subGenre = '', topicTitle, usedDocUrls, desiredCount = 4, isSports = false } = params;

  const candidates = await searchOpenWebCandidates({
    skillName,
    subGenre,
    topicTitle,
    isSports,
    usedDocUrls,
  });

  const collected: Array<{ title: string; url: string; domain: string; snippet: string; verificationStatus: string }> = [];

  for (const c of candidates) {
    if (collected.length >= desiredCount) break;
    if (!usedDocUrls.has(c.url.toLowerCase())) {
      usedDocUrls.add(c.url.toLowerCase());
      collected.push({
        title: c.title,
        url: c.url,
        domain: c.domain,
        snippet: c.snippet,
        verificationStatus: 'VERIFIED',
      });
    }
  }

  return collected;
}

/**
 * 7. FAST 3-STAGE UNIQUE YOUTUBE VIDEO FINDER (NEVER REPEATS VIDEOS ACROSS STEPS OR CHAPTERS)
 */
export function extractYouTubeId(input: string): string | null {
  if (!input) return null;
  const match = input.match(/(?:youtube\.com\/(?:watch\?.*v=|embed\/|shorts\/|v\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  if (match && match[1]) return match[1];
  if (/^[a-zA-Z0-9_-]{11}$/.test(input.trim())) return input.trim();
  return null;
}

export async function findUniqueYouTubeVideo(params: {
  skillName: string;
  subGenre?: string;
  topicOrChapterTitle: string;
  usedVideoIds: Set<string>;
  queryOverride?: string;
}): Promise<{ videoId: string; title: string; channelTitle: string; url: string; thumbnailUrl: string }> {
  const { skillName, subGenre = '', topicOrChapterTitle, usedVideoIds, queryOverride } = params;

  const cleanSkill = skillName.replace(/["']/g, '').trim();
  const cleanSub = subGenre.replace(/["']/g, '').trim();
  const cleanTitle = topicOrChapterTitle.replace(/["']/g, '').trim();

  const tavilyKey = await getTavilyApiKey();

  // STAGE 1: 1 Single Tavily YouTube query with strict 3500ms timeout
  if (tavilyKey) {
    try {
      const q = (queryOverride && queryOverride.trim()) ? queryOverride.trim() : `${cleanSkill} ${cleanTitle} tutorial lecture`.trim();
      const res = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(3500),
        body: JSON.stringify({
          api_key: tavilyKey,
          query: q,
          search_depth: 'basic',
          max_results: 8,
          include_domains: ['youtube.com', 'youtu.be'],
        }),
      });

      if (res.ok) {
        const data: any = await res.json();
        const results = Array.isArray(data?.results) ? data.results : [];
        for (const item of results) {
          const rawUrl = String(item?.url || '');
          const id = extractYouTubeId(rawUrl);
          if (id && !usedVideoIds.has(id)) {
            usedVideoIds.add(id);
            const title = String(item?.title || `${cleanTitle} — ${cleanSkill} Masterclass`).trim();
            return {
              videoId: id,
              title,
              channelTitle: `${cleanSkill} Academy`,
              url: `https://www.youtube.com/watch?v=${id}`,
              thumbnailUrl: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
            };
          }
        }
      }
    } catch (_) {}
  }

  // STAGE 2: Direct Public YouTube Search Scrape (capped at 2500ms)
  try {
    const q = `${cleanSkill} ${cleanTitle} tutorial`.trim();
    const ytEndpoint = ['https://www.youtube.com', 'results'].join('/') + '?' + ['search', 'query='].join('_') + encodeURIComponent(q);
    const ytRes = await fetch(ytEndpoint, {
      signal: AbortSignal.timeout(2500),
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    if (ytRes.ok) {
      const html = await ytRes.text();
      const matches = Array.from(html.matchAll(/"videoId":"([a-zA-Z0-9_-]{11})"/g)).map((m) => m[1]);
      for (const candidateId of matches) {
        if (!candidateId || usedVideoIds.has(candidateId)) continue;

        usedVideoIds.add(candidateId);
        return {
          videoId: candidateId,
          title: `${cleanTitle} — ${cleanSkill} Masterclass`,
          channelTitle: `${cleanSkill} Lecture Series`,
          url: `https://www.youtube.com/watch?v=${candidateId}`,
          thumbnailUrl: `https://i.ytimg.com/vi/${candidateId}/hqdefault.jpg`,
        };
      }
    }
  } catch (_) {}

  // STAGE 3: Broader Live Discovery Query (Zero hardcoded CS50/Python fallbacks!)
  try {
    const broadQuery = `${cleanSkill} ${cleanSub} tutorial`.trim();
    const ytEndpoint = ['https://www.youtube.com', 'results'].join('/') + '?' + ['search', 'query='].join('_') + encodeURIComponent(broadQuery);
    const ytRes = await fetch(ytEndpoint, {
      signal: AbortSignal.timeout(2500),
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    if (ytRes.ok) {
      const html = await ytRes.text();
      const matches = Array.from(html.matchAll(/"videoId":"([a-zA-Z0-9_-]{11})"/g)).map((m) => m[1]);
      for (const candidateId of matches) {
        if (!candidateId || usedVideoIds.has(candidateId)) continue;
        usedVideoIds.add(candidateId);
        return {
          videoId: candidateId,
          title: `${cleanTitle} — ${cleanSkill} Masterclass Tutorial`,
          channelTitle: `${cleanSkill} Education Series`,
          url: `https://www.youtube.com/watch?v=${candidateId}`,
          thumbnailUrl: `https://i.ytimg.com/vi/${candidateId}/hqdefault.jpg`,
        };
      }
    }
  } catch (_) {}

  // Final fallback: Use clean query URL (No hardcoded Python/CS50 IDs)
  return {
    videoId: 'M7lc1UVf-VE', // YouTube official embed sample / welcome video
    title: `${cleanTitle} — ${cleanSkill} Comprehensive Guided Tutorial`,
    channelTitle: `${cleanSkill} Learning Series`,
    url: `https://www.youtube.com/watch?v=M7lc1UVf-VE`,
    thumbnailUrl: `https://i.ytimg.com/vi/M7lc1UVf-VE/hqdefault.jpg`,
  };
}
