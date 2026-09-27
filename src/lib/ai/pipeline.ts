// skillprax-backend/src/lib/ai/pipeline.ts

export interface RawCandidate {
  title: string;
  url: string;
  snippet: string;
  domain: string;
}

export interface CuratedResource {
  title: string;
  url: string;
  badge: string;
  studyGuidance: string;
}

export interface ACU {
  id: string;
  label: string;
  description: string;
}

export interface QuizOption {
  id: string;
  text: string;
}

export interface QuizQuestion {
  id: string;
  acuId: string;
  scenario: string;
  question: string;
  options: QuizOption[];
  correctIndex: number;
  distractorExplanations: Record<string, string>;
}

export interface QuizBlueprint {
  questionCount: number;
  questions: QuizQuestion[];
}

export interface CurateAndExamineResult {
  conceptualOverview: string;
  keyTakeaways: string[];
  resources: CuratedResource[];
  acus: ACU[];
  quizBlueprint: QuizBlueprint;
}

export class PipelineExhaustionError extends Error {
  constructor(message: string, public readonly lastError?: unknown) {
    super(message);
    this.name = "PipelineExhaustionError";
  }
}

export class GroqConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GroqConfigError";
  }
}

const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

// Static whitelist in priority order
export const STATIC_MODEL_WHITELIST = [
  "openai/gpt-oss-120b",
  "llama-3.3-70b-versatile",
  "openai/gpt-oss-20b",
  "llama-3.1-8b-instant"
] as const;

interface CachedModels {
  models: string[];
  resolvedAt: number;
}

let modelsCache: CachedModels | null = null;
const MODELS_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

export async function getAvailableModels(apiKey?: string): Promise<string[]> {
  if (modelsCache && Date.now() - modelsCache.resolvedAt < MODELS_CACHE_TTL_MS) {
    return modelsCache.models;
  }

  const key = apiKey?.trim() || process.env.GROQ_API_KEY?.trim();
  if (!key) {
    return [...STATIC_MODEL_WHITELIST];
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${GROQ_BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (res.ok) {
      const data: any = await res.json();
      const liveIds: string[] = (data.data || []).map((m: any) => m.id);
      const intersected = STATIC_MODEL_WHITELIST.filter((m) => liveIds.includes(m));
      const result = intersected.length > 0 ? intersected : [...STATIC_MODEL_WHITELIST];
      modelsCache = { models: result, resolvedAt: Date.now() };
      return result;
    }
  } catch (err) {
    console.warn("[pipeline] Model discovery GET /models failed/timed out, using static whitelist fallback:", (err as Error).message);
  }

  return [...STATIC_MODEL_WHITELIST];
}

export async function getActiveGroqModel(apiKey?: string): Promise<string> {
  const models = await getAvailableModels(apiKey);
  return models[0] || "llama-3.1-8b-instant";
}

interface CallGroqOptions {
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
}

export async function callGroqWithFallback(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  options: CallGroqOptions = {}
): Promise<{ content: string; usedModel: string }> {
  const key = options.apiKey?.trim() || process.env.GROQ_API_KEY?.trim();
  if (!key) {
    throw new GroqConfigError("GROQ_API_KEY is missing from configuration and environment.");
  }

  const availableModels = await getAvailableModels(key);
  let lastError: unknown = null;

  for (const model of availableModels) {
    let attempts = 0;
    const maxRetriesPerModel = 3;

    while (attempts < maxRetriesPerModel) {
      attempts++;
      try {
        const body: Record<string, unknown> = {
          model,
          messages,
          temperature: options.temperature ?? 0.3,
          max_tokens: options.maxTokens ?? 3500,
        };
        if (options.jsonMode !== false) {
          body.response_format = { type: "json_object" };
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 45000);
        const res = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (res.ok) {
          const data: any = await res.json();
          const content = data.choices?.[0]?.message?.content;
          if (content) {
            console.log(JSON.stringify({ event: "groq_completion_success", model, attempts }));
            return { content, usedModel: model };
          }
        }

        const errText = await res.text().catch(() => "");
        const status = res.status;
        const isModelIncompatible =
          status === 404 ||
          status === 403 ||
          /model_not_found|model_decommissioned|model_terms_required|does not exist/i.test(errText);

        if (isModelIncompatible) {
          console.warn(`[pipeline] Model ${model} rejected (${status}), falling through to next model in whitelist. Error: ${errText.slice(0, 150)}`);
          lastError = new Error(`Model ${model} unavailable: ${errText}`);
          break; // Break inner retry loop, try next model in whitelist
        }

        // Handle rate limit (429) or 5xx server errors with exponential backoff
        if (status === 429 || status >= 500) {
          const delayMs = Math.pow(2, attempts) * 250; // 500ms, 1000ms, 2000ms
          console.warn(`[pipeline] Model ${model} returned HTTP ${status}, backing off ${delayMs}ms (attempt ${attempts}/${maxRetriesPerModel})...`);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          lastError = new Error(`HTTP ${status}: ${errText}`);
          continue; // Retry same model
        }

        // Any other non-retriable error
        lastError = new Error(`HTTP ${status}: ${errText}`);
        break;
      } catch (err: any) {
        lastError = err;
        if (err.name === "AbortError") {
          console.warn(`[pipeline] Model ${model} request timed out (attempt ${attempts}/${maxRetriesPerModel})`);
        }
        const delayMs = Math.pow(2, attempts) * 250;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  throw new PipelineExhaustionError(
    "All whitelisted Groq models were exhausted without successful generation. Please check API keys, rate limits, and network connectivity.",
    lastError
  );
}

// Trampoline & Search URL Filter Regex List
const TRAMPOLINE_REGEXES: RegExp[] = [
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

const CANONICAL_ALLOWLIST_HOSTS = new Set([
  "developer.mozilla.org",
  "docs.python.org",
  "react.dev",
  "en.wikipedia.org",
  "wikipedia.org",
  "arxiv.org",
  "w3.org",
  "gnu.org",
  "rust-lang.org",
  "go.dev",
  "typescriptlang.org",
  "kubernetes.io",
  "docker.com",
]);

function isDenylistedSearchUrl(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    const path = parsed.pathname;

    // Check regex patterns
    if (TRAMPOLINE_REGEXES.some((rx) => rx.test(`${parsed.hostname}${path}${parsed.search}`))) {
      return true;
    }

    // Bare root domain check: if path is '/' or empty and not on allowlist
    if ((path === "/" || path === "") && !CANONICAL_ALLOWLIST_HOSTS.has(host)) {
      return true;
    }

    return false;
  } catch {
    return true; // Invalid URL
  }
}

function normalizeUrl(urlStr: string): string {
  try {
    const parsed = new URL(urlStr);
    const paramsToStrip = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "si", "feature", "ref", "gclid"];
    paramsToStrip.forEach((p) => parsed.searchParams.delete(p));
    return parsed.toString();
  } catch {
    return urlStr;
  }
}

export async function harvestResources(topic: string, stepContext: string): Promise<RawCandidate[]> {
  const apiKey = process.env.TAVILY_API_KEY?.trim();
  if (!apiKey) {
    console.warn("[pipeline] TAVILY_API_KEY not set. Skipping live web harvest.");
    return [];
  }

  const query = `${topic} ${stepContext} documentation guide tutorial`.slice(0, 150);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        search_depth: "basic",
        max_results: 8,
        include_answer: false,
        include_raw_content: false,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      console.warn(`[pipeline] Tavily HTTP ${res.status}: ${await res.text().catch(() => "")}`);
      return [];
    }

    const data: any = await res.json();
    const results = data.results || [];
    const candidates: RawCandidate[] = [];
    const seenUrls = new Set<string>();

    for (const r of results) {
      if (!r.url || !r.title) continue;
      const normalized = normalizeUrl(r.url);
      if (isDenylistedSearchUrl(normalized)) continue;
      if (seenUrls.has(normalized)) continue;

      seenUrls.add(normalized);
      candidates.push({
        title: r.title.trim(),
        url: normalized,
        snippet: (r.content || "").trim().slice(0, 300),
        domain: new URL(normalized).hostname.replace(/^www\./, ""),
      });
    }

    return candidates;
  } catch (err) {
    console.warn("[pipeline] Tavily harvest error:", (err as Error).message);
    return [];
  }
}

const LAST_RESORT_RESOURCES: Record<string, CuratedResource[]> = {
  general: [
    {
      title: "Wikipedia Reference Portal",
      url: "https://en.wikipedia.org/wiki/Main_Page",
      badge: "Encyclopedia Reference",
      studyGuidance: "Review foundational terminology and historical background.",
    },
    {
      title: "MDN Web Docs",
      url: "https://developer.mozilla.org",
      badge: "Authoritative Reference",
      studyGuidance: "Consult open technical documentation and standard specifications.",
    },
  ],
};

function cleanJsonFence(raw: string): string {
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(json)?/i, "").replace(/```$/, "").trim();
  }
  return cleaned;
}

export async function curateAndExamine(
  topic: string,
  stepContext: string,
  candidates: RawCandidate[] = [],
  apiKey?: string
): Promise<CurateAndExamineResult> {
  const systemPrompt = `You are the master mentor and curriculum architect of SkillPrax.
You reject boilerplate templates and fixed quotas. You possess full pedagogical authority across all disciplines.

YOUR MANDATES:
1. "conceptualOverview": Write a deep, 2-3 paragraph breakdown explaining core mechanics, mental models, and principles.
2. "keyTakeaways": Provide 3-5 concrete terms, architectural laws, or syntax rules.
3. "acus": Deconstruct this step into 3 to 8 Atomic Competency Units (ACUs) — distinct, independently testable mechanisms or trade-offs. Each ACU needs { "id": "acu-1", "label": "Short Title", "description": "What is evaluated" }.
4. "resources": Select 1 to 4 direct instructional destination materials.
   - If provided candidates are valid and directly instructional, curate the best ones.
   - If candidates are empty, low-quality, or invalid search links, you MUST supply 1 to 4 canonical, direct content URLs from your own knowledge (e.g. MDN Web Docs, official language/framework docs, Wikipedia articles, arXiv papers).
   - NEVER return an empty resources array under any circumstance.
   - NEVER output search-query URLs (no youtube.com/results, no google.com/search). Every URL must be a direct destination page.
   - Assign each resource a contextual "badge" (2-4 words, e.g., "Visual Mental Model", "Official Specification", "Interactive Sandbox") and "studyGuidance" telling the student what to extract.
5. "quizBlueprint": Generate scenario-based evaluation questions strictly matching the ACUs.
   - "questionCount" must equal the number of ACUs (between 3 and 8).
   - Each question must have { "id": "q1", "acuId": "acu-1", "scenario": "...", "question": "...", "options": [{ "id": "A", "text": "..." }, { "id": "B", "text": "..." }, { "id": "C", "text": "..." }, { "id": "D", "text": "..." }], "correctIndex": 0, "distractorExplanations": { "A": "...", "B": "...", "C": "...", "D": "..." } }.
   - Provide a clear diagnostic explanation for why EACH option (A, B, C, D) is correct or incorrect.

OUTPUT STRICT JSON MATCHING THIS SCHEMA:
{
  "conceptualOverview": "string",
  "keyTakeaways": ["string"],
  "acus": [{ "id": "acu-1", "label": "string", "description": "string" }],
  "resources": [{ "title": "string", "url": "string", "badge": "string", "studyGuidance": "string" }],
  "quizBlueprint": {
    "questionCount": number,
    "questions": [
      {
        "id": "q1",
        "acuId": "acu-1",
        "scenario": "string",
        "question": "string",
        "options": [{ "id": "A", "text": "string" }, { "id": "B", "text": "string" }, { "id": "C", "text": "string" }, { "id": "D", "text": "string" }],
        "correctIndex": number,
        "distractorExplanations": { "A": "string", "B": "string", "C": "string", "D": "string" }
      }
    ]
  }
}`;

  const userPrompt = JSON.stringify({
    topic,
    stepContext,
    harvestedCandidates: candidates,
    candidateCount: candidates.length,
    instruction: candidates.length === 0
      ? "Tavily candidate pool is EMPTY. Use your own internal canonical knowledge to output direct, real, authoritative resource URLs (MDN, Wikipedia, official docs). Do NOT return an empty resources array."
      : "Curate direct destination URLs from harvestedCandidates verbatim if valid. You may supplement with canonical documentation from internal knowledge if needed.",
  });

  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  let rawOutput = "";
  let attemptCount = 0;

  while (attemptCount < 2) {
    attemptCount++;
    const res = await callGroqWithFallback(messages, { apiKey, jsonMode: true });
    rawOutput = cleanJsonFence(res.content);

    try {
      const parsed: CurateAndExamineResult = JSON.parse(rawOutput);

      // Validation Pass: Filter denylisted URLs
      if (Array.isArray(parsed.resources)) {
        parsed.resources = parsed.resources.filter((r) => r.url && !isDenylistedSearchUrl(r.url));
      } else {
        parsed.resources = [];
      }

      // If resources became empty after validation pass, re-prompt once with correction
      if (parsed.resources.length === 0 && attemptCount < 2) {
        console.warn("[pipeline] Groq output search-results URLs that were denylisted. Re-prompting Groq with explicit correction message...");
        messages.push({ role: "assistant", content: rawOutput });
        messages.push({
          role: "user",
          content: "Your previous output included search-results URLs, which are strictly forbidden. Regenerate using ONLY direct content destination URLs (e.g. Wikipedia deep-links, MDN pages, official language docs). Do NOT return an empty resources array.",
        });
        continue;
      }

      // If still empty after 2 attempts, apply last-resort fallback
      if (parsed.resources.length === 0) {
        console.warn("[pipeline] Applying last-resort canonical fallback resources.");
        const cleanTopic = encodeURIComponent(topic || "learning");
        parsed.resources = [
          {
            title: `Encyclopedia Reference: ${topic}`,
            url: `https://en.wikipedia.org/wiki/Special:Search?search=${cleanTopic}`,
            badge: "Canonical Reference",
            studyGuidance: `Review foundational concepts and definitions for ${topic}.`,
          },
          {
            title: `Documentation Portal: ${topic}`,
            url: `https://developer.mozilla.org`,
            badge: "Official Documentation",
            studyGuidance: `Consult technical documentation and standards.`,
          },
        ];
      }

      // Validate & Clamp ACU and Quiz Sizing (min 3, max 8)
      const rawAcus = Array.isArray(parsed.acus) ? parsed.acus : [];
      const clampCount = Math.max(3, Math.min(8, rawAcus.length || 5));

      if (!parsed.quizBlueprint || !Array.isArray(parsed.quizBlueprint.questions)) {
        parsed.quizBlueprint = { questionCount: clampCount, questions: [] };
      }
      parsed.quizBlueprint.questionCount = parsed.quizBlueprint.questions.length || clampCount;

      return parsed;
    } catch (parseErr) {
      if (attemptCount >= 2) {
        throw new GroqConfigError(`Failed to parse Groq JSON response: ${(parseErr as Error).message}`);
      }
    }
  }

  throw new PipelineExhaustionError("Curator pipeline failed to generate valid structured curriculum.");
}

// Backward compatibility exports
export async function generateStepContent(params: any) {
  const result = await curateAndExamine(
    params.skillName || params.topic,
    params.stepTitle,
    [],
    params.groqApiKey
  );
  return {
    conceptualOverview: result.conceptualOverview,
    keyTakeaways: result.keyTakeaways,
    resources: result.resources,
    estimatedMinutes: 45,
    questionCount: result.quizBlueprint.questionCount,
    assessableUnits: result.acus.map((a) => a.label),
  };
}

export async function generateQuiz(params: any) {
  const result = await curateAndExamine(
    params.skillName || params.topic,
    params.stepTitle,
    [],
    params.groqApiKey
  );
  return {
    acuBreakdown: result.acus.map((a) => a.label),
    questionCount: result.quizBlueprint.questionCount,
    questions: result.quizBlueprint.questions,
  };
}

export async function runPedagogicalCuratorPipeline(params: any) {
  const candidates = await harvestResources(params.topic, params.stepTitle);
  const result = await curateAndExamine(params.topic, params.stepTitle, candidates, params.groqKey);
  return {
    whatYouWillLearn: result.conceptualOverview,
    coreKeyTakeaways: result.keyTakeaways,
    practicalApplication: params.goal,
    questionCount: result.quizBlueprint.questionCount,
    assessableUnits: result.acus.map((a) => a.label),
    resources: result.resources,
  };
}
