// skillprax-backend/src/lib/ai/pipeline.ts

export class GroqConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GroqConfigError";
  }
}

export class PipelineExhaustionError extends Error {
  public lastError?: Error | unknown;
  constructor(message: string, lastError?: Error | unknown) {
    super(message);
    this.name = "PipelineExhaustionError";
    this.lastError = lastError;
  }
}

export interface RawCandidate {
  title: string;
  url: string;
  content?: string;
  score?: number;
}

export interface CuratedResource {
  title: string;
  url: string;
  badge: string;
  studyGuidance: string;
  sourceOrigin?: "tavily" | "groq-internal" | "fallback";
}

export interface ACU {
  id: string;
  label: string;
  description: string;
}

export interface QuizQuestionOption {
  id: "A" | "B" | "C" | "D";
  text: string;
}

export interface QuizQuestion {
  id: string;
  acuId: string;
  scenario: string;
  question: string;
  options: QuizQuestionOption[];
  correctOptionId: "A" | "B" | "C" | "D";
  distractorExplanations: Record<string, string>;
}

export interface QuizBlueprint {
  questionCount: number;
  questions: QuizQuestion[];
}

export interface CurateAndExamineResult {
  conceptualOverview: string;
  resources: CuratedResource[];
  acus: ACU[];
  questions: QuizQuestion[];
  quizBlueprint: QuizBlueprint;
}

// 1. MODEL WHITELIST NEGOTIATION
export const STATIC_MODEL_WHITELIST = [
  "openai/gpt-oss-120b",
  "llama-3.3-70b-versatile",
  "openai/gpt-oss-20b",
  "llama-3.1-8b-instant",
  "gemma2-9b-it",
] as const;

interface ModelCache {
  models: string[];
  expiresAt: number;
}

const modelCacheMap = new Map<string, ModelCache>();
const MODEL_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

export async function getAvailableModels(apiKey: string): Promise<string[]> {
  const cleanKey = apiKey.trim();
  const cached = modelCacheMap.get(cleanKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.models;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const res = await fetch("https://api.groq.com/openai/v1/models", {
      headers: { Authorization: `Bearer ${cleanKey}` },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (res.ok) {
      const data: any = await res.json();
      const liveIds: string[] = (data?.data || []).map((m: { id: string }) => m.id);
      const intersected = STATIC_MODEL_WHITELIST.filter((m) => liveIds.includes(m));

      const available = intersected.length > 0 ? intersected : Array.from(STATIC_MODEL_WHITELIST);
      modelCacheMap.set(cleanKey, { models: available, expiresAt: Date.now() + MODEL_CACHE_TTL_MS });
      return available;
    }
  } catch (err) {
    console.warn("[pipeline] Dynamic model discovery failed or timed out. Falling back to static whitelist.", err);
  }

  return Array.from(STATIC_MODEL_WHITELIST);
}

export async function getActiveGroqModel(apiKey: string): Promise<string> {
  const models = await getAvailableModels(apiKey);
  return models[0] || STATIC_MODEL_WHITELIST[0];
}

function isRetryableModelError(errorStr: string, status?: number): boolean {
  const lower = errorStr.toLowerCase();
  return (
    status === 404 ||
    status === 403 ||
    lower.includes("model_not_found") ||
    lower.includes("model_decommissioned") ||
    lower.includes("does not exist") ||
    lower.includes("terms") ||
    lower.includes("permission")
  );
}

export async function callGroqWithFallback(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  options: { apiKey: string; jsonMode?: boolean }
): Promise<{ content: string; modelUsed: string }> {
  const availableModels = await getAvailableModels(options.apiKey);
  let lastError: Error | unknown;

  for (const model of availableModels) {
    let attempts = 0;
    const maxAttemptsOnModel = 3;

    while (attempts < maxAttemptsOnModel) {
      attempts++;
      try {
        const payload: Record<string, any> = {
          model,
          messages,
          temperature: 0.2,
          max_tokens: 4000,
        };
        if (options.jsonMode) {
          payload.response_format = { type: "json_object" };
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);

        const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${options.apiKey.trim()}`,
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (!res.ok) {
          const errText = await res.text();
          const isModelDefunct = isRetryableModelError(errText, res.status);

          if (isModelDefunct) {
            console.warn(`[pipeline] Model "${model}" returned non-retryable status (${res.status}): ${errText}. Falling through to next model.`);
            lastError = new Error(`Model ${model} error (${res.status}): ${errText}`);
            break;
          }

          if (res.status === 429 || res.status >= 500) {
            lastError = new Error(`Model ${model} transient error (${res.status}): ${errText}`);
            if (attempts < maxAttemptsOnModel) {
              const delay = Math.pow(2, attempts - 1) * 500;
              await new Promise((resolve) => setTimeout(resolve, delay));
              continue;
            }
          }

          lastError = new Error(`Model ${model} failed with HTTP ${res.status}: ${errText}`);
          break;
        }

        const data: any = await res.json();
        const content = data?.choices?.[0]?.message?.content || "";
        if (!content.trim()) {
          throw new Error(`Model ${model} returned empty response content.`);
        }

        console.info(`[pipeline] Successfully generated response using model: ${model}`);
        return { content, modelUsed: model };
      } catch (err: any) {
        lastError = err;
        if (err?.name === "AbortError") {
          console.warn(`[pipeline] Model ${model} request timed out on attempt ${attempts}.`);
        }
        if (attempts < maxAttemptsOnModel) {
          const delay = Math.pow(2, attempts - 1) * 500;
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
  }

  throw new PipelineExhaustionError(
    "All Groq whitelist models failed or were unavailable.",
    lastError
  );
}

// 2. TAVILY LIVE HARVESTER WITH URL DENYLIST
const DENYLIST_REGEXES = [
  /youtube\.com\/results/i,
  /google\.com\/search/i,
  /bing\.com\/search/i,
  /duckduckgo\.com\/\?q=/i,
  /yahoo\.com\/search/i,
  /baidu\.com\/s/i,
  /yandex\.com\/search/i,
];

const CANONICAL_DOCS_ALLOWLIST = [
  "developer.mozilla.org",
  "docs.python.org",
  "arxiv.org",
  "en.wikipedia.org",
  "wikipedia.org",
  "doc.rust-lang.org",
  "go.dev",
  "kubernetes.io",
  "typescriptlang.org",
  "react.dev",
  "nextjs.org",
  "nodejs.org",
  "fastify.dev",
  "prisma.io",
];

export function normalizeUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const paramsToStrip = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "si", "feature", "fbclid", "gclid"];
    paramsToStrip.forEach((p) => parsed.searchParams.delete(p));
    return parsed.toString().replace(/\/$/, "");
  } catch (_) {
    return rawUrl;
  }
}

export function isDenylistedSearchUrl(rawUrl: string): boolean {
  if (!rawUrl || typeof rawUrl !== "string") return true;

  for (const regex of DENYLIST_REGEXES) {
    if (regex.test(rawUrl)) return true;
  }

  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    const pathname = parsed.pathname;

    if (pathname === "" || pathname === "/") {
      const isAllowedCanonical = CANONICAL_DOCS_ALLOWLIST.some((allowed) => host.includes(allowed));
      if (!isAllowedCanonical) {
        return true;
      }
    }
  } catch (_) {
    return true;
  }

  return false;
}

export async function harvestResources(
  topic: string,
  stepContext: string,
  tavilyApiKey?: string | null
): Promise<RawCandidate[]> {
  const apiKey = tavilyApiKey || process.env.TAVILY_API_KEY;
  if (!apiKey) {
    console.warn("[pipeline] TAVILY_API_KEY missing. Returning empty candidate pool.");
    return [];
  }

  try {
    const query = `${topic} ${stepContext} official guide documentation tutorial reference`.trim();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);

    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey.trim(),
        query,
        include_raw_content: false,
        max_results: 10,
        search_depth: "basic",
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      console.warn(`[pipeline] Tavily API returned HTTP ${res.status}. Fallback to internal knowledge.`);
      return [];
    }

    const data: any = await res.json();
    const results: any[] = data?.results || [];

    const seenUrls = new Set<string>();
    const candidates: RawCandidate[] = [];

    for (const r of results) {
      if (!r.url || typeof r.url !== "string") continue;
      if (isDenylistedSearchUrl(r.url)) continue;

      const norm = normalizeUrl(r.url);
      if (seenUrls.has(norm)) continue;
      seenUrls.add(norm);

      candidates.push({
        title: r.title || topic,
        url: norm,
        content: r.content ? String(r.content).slice(0, 300) : "",
        score: r.score,
      });
    }

    return candidates;
  } catch (err) {
    console.warn("[pipeline] Tavily harvest failed or timed out. Returning empty pool.", err);
    return [];
  }
}

function cleanJsonFence(raw: string): string {
  let cleaned = raw.trim();
  if (cleaned.startsWith("```json")) {
    cleaned = cleaned.replace(/^```json\s*/i, "").replace(/\s*```$/, "");
  } else if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```\s*/, "").replace(/\s*```$/, "");
  }
  return cleaned.trim();
}

// PHASE B: EXPORTED QUIZ BLUEPRINT GENERATOR FOR ON-DEMAND AUTO-HEALING
export async function generateQuizBlueprint(
  topic: string,
  stepTitle: string,
  assessableUnits: ACU[],
  takeaways: string[],
  apiKey: string
): Promise<QuizQuestion[]> {
  if (!assessableUnits || assessableUnits.length === 0) {
    return [];
  }

  const systemPrompt = `You are a diagnostic evaluation examiner. Your task is to generate scenario-based evaluation questions strictly mapped 1-to-1 with the provided Atomic Competency Units (ACUs).

YOUR MANDATES:
1. Generate EXACTLY one scenario-based multiple choice question per ACU in the provided list.
2. Tag each question with the "acuId" of the ACU it evaluates.
3. Provide 4 options (A, B, C, D) for each question.
4. Set "correctOptionId" to "A", "B", "C", or "D".
5. Provide specific diagnostic "distractorExplanations" for EVERY option (A, B, C, D) detailing why that specific option is correct or represents a misconception.

OUTPUT STRICT JSON MATCHING THIS SCHEMA:
{
  "questions": [
    {
      "id": "q1",
      "acuId": "acu-1",
      "scenario": "string",
      "question": "string",
      "options": [{ "id": "A", "text": "string" }, { "id": "B", "text": "string" }, { "id": "C", "text": "string" }, { "id": "D", "text": "string" }],
      "correctOptionId": "A",
      "distractorExplanations": { "A": "string", "B": "string", "C": "string", "D": "string" }
    }
  ]
}`;

  const userPrompt = JSON.stringify({
    topic,
    stepTitle,
    assessableUnits,
    takeaways,
  });

  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  try {
    const res = await callGroqWithFallback(messages, { apiKey, jsonMode: true });
    const raw = cleanJsonFence(res.content);
    const parsed: any = JSON.parse(raw);
    const questions: QuizQuestion[] = Array.isArray(parsed.questions)
      ? parsed.questions
      : Array.isArray(parsed.quizBlueprint?.questions)
      ? parsed.quizBlueprint.questions
      : [];

    if (questions.length > 0) {
      return questions;
    }
  } catch (err) {
    console.warn("[pipeline] Phase B generateQuizBlueprint failed or timed out. Returning fallback questions.", err);
  }

  // Fallback questions generated directly from ACUs
  return assessableUnits.map((acu, idx) => ({
    id: `q${idx + 1}`,
    acuId: acu.id,
    scenario: `Evaluating competency in ${acu.label} for ${stepTitle}.`,
    question: `Which pattern correctly demonstrates ${acu.description}?`,
    options: [
      { id: "A", text: `Enforce validation and verify ${acu.label} mechanics.` },
      { id: "B", text: "Bypass edge case checking in production logic." },
      { id: "C", text: "Ignore system constraints during initialization." },
      { id: "D", text: "Hardcode configuration parameters without environment abstraction." },
    ],
    correctOptionId: "A",
    distractorExplanations: {
      A: `Correct application of ${acu.label}.`,
      B: "Ignoring edge cases causes unhandled runtime exceptions.",
      C: "Bypassing constraints creates race conditions.",
      D: "Hardcoding parameters breaks environment portability.",
    },
  }));
}

// TWO-PHASE PIPELINE: PHASE A (Curate & Decompose) + PHASE B (Examine)
export async function curateAndExamine(
  topic: string,
  stepContext: string,
  candidates: RawCandidate[],
  apiKey: string
): Promise<CurateAndExamineResult> {
  const systemPrompt = `You are an expert Principal Systems Architect and Cognitive Educator.
You have full pedagogical authority over how many learning resources to curate and how many Atomic Competency Units (ACUs) to identify for this step.

YOUR MANDATES:
1. "conceptualOverview": Write a deep, 2-3 paragraph pedagogical breakdown explaining core mechanics, mental models, architectural trade-offs, and principles for this step.
2. "resources": Curate destination learning materials.
   - Do not default to a round number. Curate the MINIMUM set of distinct, non-redundant assets needed for complete step mastery (1 to 6+ based on topic complexity).
   - If provided Tavily candidates are valid direct destination pages, curate from them.
   - If candidates are empty, low-quality, or search-query URLs, supply canonical resources from internal knowledge (MDN, official docs, primary papers, Wikipedia).
   - NEVER return an empty resources array.
   - NEVER output search-query URLs.
   - Assign each resource a descriptive "badge" (2-4 words) and "studyGuidance".

3. "acus": Deconstruct this step into an EXHAUSTIVE list of Atomic Competency Units (ACUs).
   - Every distinct, independently testable concept, mechanism, edge case, or trade-off must be its own ACU.
   - Format each ACU as { "id": "acu-1", "label": "Short Title", "description": "What is evaluated" }.

OUTPUT STRICT JSON MATCHING THIS SCHEMA:
{
  "conceptualOverview": "string",
  "resources": [{ "title": "string", "url": "string", "badge": "string", "studyGuidance": "string" }],
  "acus": [{ "id": "acu-1", "label": "string", "description": "string" }]
}`;

  const userPrompt = JSON.stringify({
    topic,
    stepContext,
    harvestedCandidates: candidates,
    candidateCount: candidates.length,
    instruction: candidates.length === 0
      ? "Tavily candidate pool is EMPTY. Use internal canonical knowledge to output direct destination URLs (MDN, Wikipedia, official docs). Do NOT return an empty resources array."
      : "Curate direct destination URLs from harvestedCandidates if valid. Supplement with canonical documentation if needed.",
  });

  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  let conceptualOverview = `Master core principles and architectural patterns for ${topic}: ${stepContext}.`;
  let resources: CuratedResource[] = [];
  let acus: ACU[] = [];

  // PHASE A Execution
  try {
    const res = await callGroqWithFallback(messages, { apiKey, jsonMode: true });
    const rawOutput = cleanJsonFence(res.content);
    const parsed: any = JSON.parse(rawOutput);

    if (parsed.conceptualOverview) {
      conceptualOverview = parsed.conceptualOverview;
    }
    if (Array.isArray(parsed.resources)) {
      resources = parsed.resources.filter((r: any) => r && r.url && !isDenylistedSearchUrl(r.url));
    }
    if (Array.isArray(parsed.acus)) {
      acus = parsed.acus;
    }
  } catch (err) {
    console.warn("[pipeline] Phase A execution failed. Using fallback curriculum.", err);
  }

  // Fallbacks if Phase A returned empty arrays
  if (resources.length === 0) {
    resources = [
      {
        title: `Encyclopedia Reference: ${topic}`,
        url: `https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(topic)}`,
        badge: "Canonical Reference",
        studyGuidance: `Review foundational concepts for ${topic}.`,
        sourceOrigin: "fallback",
      },
    ];
  }

  if (acus.length === 0) {
    acus = [
      { id: "acu-1", label: "Core Principles", description: `Foundational concepts of ${topic}` },
      { id: "acu-2", label: "Practical Implementation", description: `Implementation of ${stepContext}` },
      { id: "acu-3", label: "Architecture & Trade-offs", description: `System architecture and trade-offs` },
    ];
  }

  // PHASE B Execution (Quiz Generation)
  let questions: QuizQuestion[] = [];
  try {
    const takeaways = acus.map((a) => a.label);
    questions = await generateQuizBlueprint(topic, stepContext, acus, takeaways, apiKey);
  } catch (phaseBErr) {
    console.warn("[pipeline] Phase B (Quiz Blueprint) failed or timed out. Graceful fallback: track creation proceeds.", phaseBErr);
    questions = [];
  }

  const quizBlueprint: QuizBlueprint = {
    questionCount: questions.length,
    questions,
  };

  return {
    conceptualOverview,
    resources,
    acus,
    questions,
    quizBlueprint,
  };
}
