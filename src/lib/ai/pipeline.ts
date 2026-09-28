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
  tavilyApiKey?: string | null,
  domainCategory?: string,
  targetGoal?: string
): Promise<RawCandidate[]> {
  const apiKey = tavilyApiKey || process.env.TAVILY_API_KEY;
  if (!apiKey) {
    console.warn("[pipeline] TAVILY_API_KEY missing. Returning empty candidate pool.");
    return [];
  }

  try {
    // Bias search terms toward the stated domain and goal
    const domainBias = domainCategory && domainCategory !== "General Knowledge" ? ` ${domainCategory}` : "";
    const goalBias = targetGoal && targetGoal !== "Full Mastery" ? ` ${targetGoal}` : "";
    const query = `${topic}${domainBias}${goalBias} ${stepContext} official guide documentation tutorial reference`.trim();
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

// ============================================================
// PHASE A: SYNTHESIZE STEP MATERIALS — Level-calibrated resource curation + ACU decomposition
// ============================================================
export async function synthesizeStepMaterials(
  title: string,
  domainCategory: string,
  targetGoal: string,
  level: string,
  candidates: RawCandidate[],
  groqKey?: string
): Promise<{ resources: CuratedResource[]; acus: ACU[] }> {
  const apiKey = groqKey || process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new GroqConfigError("GROQ_API_KEY is required for synthesizeStepMaterials.");
  }

  const levelGuidance = level === "advanced" || level === "expert"
    ? "This learner is ADVANCED. Produce denser ACUs covering edge cases, failure modes, architectural trade-offs, and non-obvious interactions. Resources should target advanced documentation, primary papers, and expert-level references."
    : level === "intermediate"
    ? "This learner is INTERMEDIATE. Balance foundational reinforcement with practical application ACUs. Resources should mix tutorials with deeper reference material."
    : "This learner is a BEGINNER. Produce foundational ACUs covering core concepts, mental models, and first-principles understanding. Resources should be accessible introductions, official getting-started guides, and beginner-friendly references.";

  const systemPrompt = `You are an expert Principal Systems Architect and Cognitive Educator.
You have full pedagogical authority over how many learning resources to curate and how many Atomic Competency Units (ACUs) to identify.

YOUR MANDATES:
1. "resources": Curate destination learning materials.
   - Decide independently how many of the provided Tavily candidates, if any, are worth surfacing. You may select zero of them and supply only your own canonical resources, all of them, or any subset. There is no target number — the only test is genuine pedagogical necessity for a learner at the stated level pursuing the stated goal.
   - If candidates are empty, low-quality, or search-query URLs, supply canonical resources from internal knowledge (MDN, official docs, primary papers, Wikipedia).
   - NEVER return an empty resources array.
   - NEVER output search-query URLs.
   - Assign each resource a descriptive "badge" (2-4 words) and "studyGuidance".

2. "acus": Deconstruct this topic into an EXHAUSTIVE list of Atomic Competency Units (ACUs) calibrated to the learner's level.
   - ${levelGuidance}
   - Every distinct, independently testable concept, mechanism, edge case, or trade-off must be its own ACU.
   - Format each ACU as { "id": "acu-N", "label": "Short Title", "description": "What is evaluated" }.

OUTPUT STRICT JSON MATCHING THIS SCHEMA:
{
  "resources": [{ "title": "string", "url": "string", "badge": "string", "studyGuidance": "string" }],
  "acus": [{ "id": "acu-1", "label": "string", "description": "string" }]
}`;

  const userPrompt = JSON.stringify({
    title,
    domainCategory,
    targetGoal,
    level,
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

  let resources: CuratedResource[] = [];
  let acus: ACU[] = [];

  try {
    const res = await callGroqWithFallback(messages, { apiKey, jsonMode: true });
    const rawOutput = cleanJsonFence(res.content);
    const parsed: any = JSON.parse(rawOutput);

    if (Array.isArray(parsed.resources)) {
      resources = parsed.resources.filter((r: any) => r && r.url && !isDenylistedSearchUrl(r.url));
    }
    if (Array.isArray(parsed.acus)) {
      acus = parsed.acus;
    }
  } catch (err) {
    console.warn("[pipeline] Phase A (synthesizeStepMaterials) failed. Using fallback.", err);
  }

  // Fallbacks if Groq returned empty
  if (resources.length === 0) {
    resources = [
      {
        title: `Encyclopedia Reference: ${title}`,
        url: `https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(title)}`,
        badge: "Canonical Reference",
        studyGuidance: `Review foundational concepts for ${title}.`,
        sourceOrigin: "fallback",
      },
    ];
  }

  if (acus.length === 0) {
    acus = [
      { id: "acu-1", label: "Core Principles", description: `Foundational concepts of ${title}` },
      { id: "acu-2", label: "Practical Implementation", description: `Practical application of ${title}` },
      { id: "acu-3", label: "Architecture & Trade-offs", description: `System design and trade-offs for ${title}` },
    ];
  }

  return { resources, acus };
}

// ============================================================
// PHASE B: SYNTHESIZE QUIZ FROM MATERIAL — Material-scoped, 1 question per ACU
// ============================================================
export async function synthesizeQuizFromMaterial(
  acus: ACU[],
  resources: CuratedResource[],
  groqKey?: string,
  options?: { seed?: string; temperature?: number }
): Promise<QuizQuestion[]> {
  const apiKey = groqKey || process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new GroqConfigError("GROQ_API_KEY is required for synthesizeQuizFromMaterial.");
  }

  if (!acus || acus.length === 0) {
    return [];
  }

  const seedStr = options?.seed || Math.random().toString(36).substring(7);
  const temp = options?.temperature ?? 0.8;

  const systemPrompt = `You are a diagnostic evaluation examiner. Your task is to generate NOVEL, scenario-based evaluation questions.
Randomization Seed: "${seedStr}". Produce completely fresh scenarios and distractor options. Do NOT repeat previous questions.

Author questions using ONLY the specific concepts, explanations, and practical mechanisms introduced in the provided curated resources and Atomic Competency Units for this step.

YOUR MANDATES:
1. Write EXACTLY one scenario-based multiple choice question per ACU in the provided list. questions.length MUST equal acus.length.
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
    acus,
    curatedResources: resources.map((r) => ({
      title: r.title,
      badge: r.badge,
      studyGuidance: r.studyGuidance,
    })),
    expectedQuestionCount: acus.length,
  });

  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  try {
    const res = await callGroqWithFallback(messages, { apiKey, jsonMode: true });
    const raw = cleanJsonFence(res.content);
    const parsed: any = JSON.parse(raw);
    let questions: QuizQuestion[] = Array.isArray(parsed.questions)
      ? parsed.questions
      : Array.isArray(parsed.quizBlueprint?.questions)
      ? parsed.quizBlueprint.questions
      : [];

    // Mismatch guard: re-prompt once if count doesn't match
    if (questions.length > 0 && questions.length !== acus.length) {
      console.warn(`[pipeline] Quiz count mismatch: got ${questions.length}, expected ${acus.length}. Re-prompting once.`);
      try {
        const rePromptMessages = [
          ...messages,
          { role: "assistant" as const, content: res.content },
          {
            role: "user" as const,
            content: `You generated ${questions.length} questions but there are ${acus.length} ACUs. You MUST generate exactly ${acus.length} questions, one per ACU. Regenerate the full JSON with the correct count.`,
          },
        ];
        const res2 = await callGroqWithFallback(rePromptMessages, { apiKey, jsonMode: true });
        const raw2 = cleanJsonFence(res2.content);
        const parsed2: any = JSON.parse(raw2);
        const q2 = Array.isArray(parsed2.questions) ? parsed2.questions : [];
        if (q2.length >= 2 && q2.length <= 20) {
          questions = q2;
        }
      } catch (reErr) {
        console.warn("[pipeline] Re-prompt for quiz count correction failed.", reErr);
      }
    }

    // Defensive bounds: reject if still wildly off
    if (questions.length >= 2 && questions.length <= 20) {
      return questions;
    }
    if (questions.length > 0) {
      return questions; // accept whatever we got if between 1 and 20
    }
  } catch (err) {
    console.warn("[pipeline] Phase B synthesizeQuizFromMaterial failed. Returning fallback questions.", err);
  }

  // Fallback questions generated directly from ACUs
  return acus.map((acu, idx) => ({
    id: `q${idx + 1}`,
    acuId: acu.id,
    scenario: `Evaluating competency in ${acu.label}.`,
    question: `Which pattern correctly demonstrates ${acu.description}?`,
    options: [
      { id: "A" as const, text: `Enforce validation and verify ${acu.label} mechanics.` },
      { id: "B" as const, text: "Bypass edge case checking in production logic." },
      { id: "C" as const, text: "Ignore system constraints during initialization." },
      { id: "D" as const, text: "Hardcode configuration parameters without environment abstraction." },
    ],
    correctOptionId: "A" as const,
    distractorExplanations: {
      A: `Correct application of ${acu.label}.`,
      B: "Ignoring edge cases causes unhandled runtime exceptions.",
      C: "Bypassing constraints creates race conditions.",
      D: "Hardcoding parameters breaks environment portability.",
    },
  }));
}
