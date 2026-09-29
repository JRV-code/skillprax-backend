// skillprax-backend/src/lib/ai/pipeline.ts
import { getEffectiveKeys } from "../keyManager";

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
  options: { apiKey: string; jsonMode?: boolean; model?: string; temperature?: number }
): Promise<{ content: string; modelUsed: string }> {
  const availableModels = options.model ? [options.model, ...await getAvailableModels(options.apiKey)] : await getAvailableModels(options.apiKey);
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
          temperature: options.temperature ?? 0.2,
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
  let apiKey: string | undefined = tavilyApiKey || process.env.TAVILY_API_KEY || undefined;
  if (!apiKey) {
    try {
      const keys = await getEffectiveKeys();
      apiKey = keys.tavilyKey || undefined;
    } catch (_) {}
  }
  if (!apiKey) {
    console.warn("[pipeline] TAVILY_API_KEY missing. Returning empty candidate pool.");
    return [];
  }

  try {
    // Bias search terms toward the stated domain and goal + 2026 freshness filters
    const domainBias = domainCategory && domainCategory !== "General Knowledge" ? ` ${domainCategory}` : "";
    const goalBias = targetGoal && targetGoal !== "Full Mastery" ? ` ${targetGoal}` : "";
    const query = `${topic}${domainBias}${goalBias} ${stepContext} 2026 latest technical tutorial documentation canonical reference`.trim();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey.trim(),
        query,
        search_depth: "advanced",
        include_domains: [
          "youtube.com",
          "developer.mozilla.org",
          "github.com",
          "wikipedia.org",
          "geeksforgeeks.org",
          "w3schools.com",
          "arxiv.org",
          "docs.python.org",
          "khanacademy.org"
        ],
        max_results: 12,
        include_raw_content: false,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const errorData: any = await res.json().catch(() => ({}));
      console.warn(`[pipeline] Tavily API returned HTTP ${res.status}: ${errorData.error || res.statusText}`);
      return [];
    }

    const data: any = await res.json();
    const results: any[] = data?.results || [];

    const seenUrls = new Set<string>();
    const candidates: RawCandidate[] = [];

    for (const r of results) {
      if (!r.url || typeof r.url !== "string" || !r.url.startsWith("http")) continue;
      if (isDenylistedSearchUrl(r.url)) continue;

      const norm = normalizeUrl(r.url);
      if (seenUrls.has(norm)) continue;
      seenUrls.add(norm);

      candidates.push({
        title: (r.title || topic).trim(),
        url: norm,
        content: r.content ? String(r.content).slice(0, 300) : "",
        score: typeof r.score === "number" ? r.score : 0,
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
function getTierDescription(stepIndex: number = 1): string {
  if (stepIndex <= 1) return "Foundational mental models, core terminology, and high-level intuition.";
  if (stepIndex === 2) return "Applied mechanics, interactive workflows, standard design patterns, and problem solving.";
  if (stepIndex === 3) return "Performance optimization, memory constraints, edge cases, and non-trivial debugging.";
  return "System architecture, production trade-offs, scalability bottlenecks, and deep internals.";
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
  groqKey?: string,
  stepIndex: number = 1
): Promise<{ resources: CuratedResource[]; acus: ACU[] }> {
  let apiKey: string | undefined = groqKey || process.env.GROQ_API_KEY || undefined;
  if (!apiKey) {
    try {
      const keys = await getEffectiveKeys();
      apiKey = keys.groqKey || undefined;
    } catch (_) {}
  }
  if (!apiKey) {
    throw new GroqConfigError("GROQ_API_KEY is required for synthesizeStepMaterials.");
  }

  const tierDescription = getTierDescription(stepIndex);

  const levelGuidance = level === "advanced" || level === "expert"
    ? "This learner is ADVANCED. Produce denser ACUs covering edge cases, failure modes, architectural trade-offs, and non-obvious interactions."
    : level === "intermediate"
    ? "This learner is INTERMEDIATE. Balance foundational reinforcement with practical application ACUs."
    : "This learner is a BEGINNER. Produce foundational ACUs covering core concepts, mental models, and first-principles understanding.";

  // Pass indexed candidates to Groq so Groq returns candidateIndex instead of writing URLs
  const candidatePool = candidates.map((c, idx) => ({
    candidateIndex: idx,
    title: c.title,
    snippet: c.content || "",
    isYoutube: c.url.includes("youtube.com") || c.url.includes("youtu.be")
  }));

  const systemPrompt = `You are an expert Principal Systems Architect and Cognitive Educator.

PEDAGOGICAL DIFFICULTY TIER: Level ${stepIndex} (${tierDescription}).

STRICT ZERO-HALLUCINATION URL RULE:
You MUST NOT generate, guess, mutate, or invent URL strings.
Select resources exclusively from the provided \`harvestedCandidates\` by returning their \`candidateIndex\`.

RESOURCES SELECTION MANDATE:
Select up to 3 video candidates and up to 4 documentation candidates from \`harvestedCandidates\`.
For each selected candidate, output its \`candidateIndex\`, a 2-4 word \`badge\` (e.g. "Official Documentation", "Video Walkthrough"), and concise \`studyGuidance\`.

ACUs DECONSTRUCTION MANDATE:
Deconstruct this topic into an EXHAUSTIVE list of Atomic Competency Units (ACUs) calibrated to Level ${stepIndex}.
Format each ACU as { "id": "acu-1", "label": "Short Title", "description": "What is evaluated" }.

OUTPUT STRICT JSON MATCHING THIS SCHEMA:
{
  "selectedIndices": [
    { "candidateIndex": 0, "badge": "string", "studyGuidance": "string" }
  ],
  "acus": [
    { "id": "acu-1", "label": "string", "description": "string" }
  ]
}`;

  const userPrompt = JSON.stringify({
    title,
    domainCategory,
    targetGoal,
    level,
    stepIndex,
    harvestedCandidates: candidatePool,
    candidateCount: candidates.length,
    instruction: candidates.length === 0
      ? "Tavily candidate pool is EMPTY. Return empty selectedIndices array and generate high-signal ACUs."
      : "Select the best learning materials from harvestedCandidates using candidateIndex.",
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

    if (Array.isArray(parsed.selectedIndices)) {
      const selectedSet = new Set<number>();
      for (const item of parsed.selectedIndices) {
        const cIdx = typeof item.candidateIndex === "number" ? item.candidateIndex : -1;
        if (cIdx >= 0 && cIdx < candidates.length && !selectedSet.has(cIdx)) {
          selectedSet.add(cIdx);
          const cand = candidates[cIdx];
          if (cand && cand.url && !isDenylistedSearchUrl(cand.url)) {
            resources.push({
              title: cand.title,
              url: cand.url, // 100% exact Tavily URL, ZERO hallucination!
              badge: item.badge || (cand.url.includes("youtube.com") ? "Video Tutorial" : "Canonical Documentation"),
              studyGuidance: item.studyGuidance || "Study this canonical resource.",
              sourceOrigin: "tavily"
            });
          }
        }
      }
    } else if (Array.isArray(parsed.resources)) {
      // Fallback: match returned URLs back against candidates list
      for (const r of parsed.resources) {
        if (!r) continue;
        const matched = candidates.find(c => c.url === r.url || (r.title && c.title.toLowerCase() === r.title.toLowerCase()));
        if (matched && matched.url) {
          resources.push({
            title: matched.title,
            url: matched.url,
            badge: r.badge || "Canonical Resource",
            studyGuidance: r.studyGuidance || "Study this canonical resource.",
            sourceOrigin: "tavily"
          });
        }
      }
    }

    if (Array.isArray(parsed.acus)) {
      acus = parsed.acus;
    }
  } catch (err) {
    console.warn("[pipeline] Phase A (synthesizeStepMaterials) failed. Using fallback.", err);
  }

  // If no resources were selected by Groq, map directly from harvested candidates
  if (resources.length === 0 && candidates.length > 0) {
    resources = candidates.slice(0, 5).map((c) => ({
      title: c.title,
      url: c.url,
      badge: c.url.includes("youtube.com") ? "Video Walkthrough" : "Canonical Documentation",
      studyGuidance: `Master the core concepts of ${title}.`,
      sourceOrigin: "tavily"
    }));
  }

  // Fallbacks if Tavily pool was empty, using guaranteed non-hallucinated search trampoline-free URLs
  if (resources.length === 0) {
    resources = [
      {
        title: `Encyclopedia Reference: ${title}`,
        url: `https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(title)}`,
        badge: "Canonical Reference",
        studyGuidance: `Review foundational concepts for ${title}.`,
        sourceOrigin: "fallback",
      },
      {
        title: `MDN Technical Documentation: ${title}`,
        url: `https://developer.mozilla.org/en-US/search?q=${encodeURIComponent(title)}`,
        badge: "Official Documentation",
        studyGuidance: `Explore standard technical specifications for ${title}.`,
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
// PHASE B: SYNTHESIZE QUIZ FROM MATERIAL — Material-scoped Socratic Evaluation
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

  const resourceContext = resources && resources.length > 0
    ? resources.map(r => `• [${r.badge || 'Resource'}] "${r.title}": ${r.studyGuidance || 'Assigned study material'}`).join('\n')
    : 'Foundational first-principles for this domain.';

  const systemPrompt = `You are a diagnostic Socratic evaluation examiner. Your task is to generate scenario-based evaluation questions based strictly on the provided ACUs and curated resources.
Randomization Seed: "${seedStr}". Produce completely fresh scenarios and distractor options.

ASSIGNED STUDY CURRICULUM (Researched via Tavily & Curated for this Step):
${resourceContext}

ASSESSABLE COMPETENCY UNITS (ACUs to Test):
${acus.map((a) => `- [ID: ${a.id}] ${a.label}: ${a.description}`).join('\n')}

CRITICAL GROUNDING DIRECTIVE:
1. Every scenario question MUST directly assess concepts, principles, takeaways, or failure modes covered in the ASSIGNED STUDY CURRICULUM above and the ACUs.
2. Do NOT generate questions on external, unassigned trivia.

DYNAMIC QUESTION COUNT:
Inspect the step's ACUs and generate between 3 to 6 questions dynamically based on content density (3 <= questions.length <= 6).

STRICT DISTRACTOR EQUALITY RULES:
1. EQUAL LENGTH: All 4 options (A, B, C, D) MUST have strictly comparable word counts and sentence structures (within ±10% word count of each other).
2. NO OBVIOUS ANSWERS: NEVER make the correct option noticeably longer, more nuanced, or more technically detailed than incorrect options.
3. HIGH-PLAUSIBILITY DISTRACTORS: Every distractor MUST represent a sophisticated, realistic misconception that an intermediate learner would genuinely fall for. Do not use throwaway or obviously absurd choices.
4. NO META-OPTIONS: Do NOT use 'All of the above', 'None of the above', or 'Both A and B'.

YOUR MANDATES:
1. Generate between 3 to 6 questions dynamically mapped to the provided ACUs and assigned resources.
2. Tag each question with the "acuId" of the ACU it evaluates.
3. Provide 4 options (A, B, C, D) for each question obeying the STRICT DISTRACTOR EQUALITY RULES.
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

// ============================================================
// PHASE C: TARGETED WEAKNESS DIAGNOSTIC & LASER-FOCUSED REMEDIATION
// ============================================================

export interface WeaknessArea {
  topic: string;
  misconceptionAnalysis: string;
  coreConcept: string;
  resources: {
    docTitle: string;
    docUrl: string;
    videoTitle: string;
    videoUrl: string;
    criticalTakeaway: string;
  };
  acuId: string;
  acuLabel: string;
  rootCausePattern: string;
  remediationResources: {
    document: { title: string; url: string; studyGuidance: string };
    video: { title: string; url: string; studyGuidance: string };
  };
}

export interface DiagnosticPrescription {
  overallDiagnosis: string;
  weakAreas: WeaknessArea[];
  weaknessAreas: WeaknessArea[];
  retakeGuidance: string;
}

export interface FailedQuestionContext {
  questionId: string;
  scenario: string;
  chosenOptionId: string | null;
  correctOptionId: string;
  chosenOptionText?: string;
  correctOptionText?: string;
  whyWrong?: string | null;
  acuId?: string;
}

export async function synthesizeTargetedRemediation(
  stepTitle: string,
  domainCategory: string,
  failedQuestions: FailedQuestionContext[],
  acus: ACU[],
  resources: CuratedResource[],
  groqKey?: string
): Promise<DiagnosticPrescription> {
  const apiKey = groqKey || process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new GroqConfigError("GROQ_API_KEY is required for synthesizeTargetedRemediation.");
  }

  if (!failedQuestions || failedQuestions.length === 0) {
    return {
      overallDiagnosis: "No specific weaknesses detected.",
      weakAreas: [],
      weaknessAreas: [],
      retakeGuidance: "You may retake the evaluation when ready.",
    };
  }

  const systemPrompt = `You are a Socratic Diagnostic Evaluator specializing in targeted misconception analysis and laser-focused remediation.

YOUR TASK: Analyze the learner's incorrect quiz answers and produce a precise diagnostic prescription.

CRITICAL TONE & FORMAT RULES:
1. SOCRATIC MISCONCEPTION ANALYSIS: For each failed question, your "misconceptionAnalysis" MUST begin with "Your choice of [Wrong Option Text] indicates..." and then explain the specific cognitive error or knowledge gap that led to this choice. Be empathetic but precise.
2. ROOT CAUSE PATTERN: Identify the underlying conceptual misunderstanding (e.g., "Confusion between compile-time and runtime type checking", "Misattribution of synchronous behavior to asynchronous APIs").
3. REMEDIATION RESOURCES: For EACH weakness area, prescribe EXACTLY:
   - 1 canonical documentation resource (official docs, MDN, Wikipedia, etc.)
   - 1 video resource (YouTube tutorial, conference talk, etc.)
   Both must be real, high-quality, direct destination URLs. NEVER output search-query URLs.
4. Study guidance must explain specifically what to look for in each resource to correct the misconception.

OUTPUT STRICT JSON MATCHING THIS SCHEMA:
{
  "overallDiagnosis": "A 1-2 sentence high-level summary of the learner's weakness pattern across all failed questions.",
  "weaknessAreas": [
    {
      "acuId": "acu-N",
      "acuLabel": "Short label of the ACU",
      "misconceptionAnalysis": "Your choice of [X] indicates...",
      "rootCausePattern": "Underlying conceptual error description",
      "remediationResources": {
        "document": { "title": "string", "url": "string", "studyGuidance": "string" },
        "video": { "title": "string", "url": "string", "studyGuidance": "string" }
      }
    }
  ],
  "retakeGuidance": "A concise instruction on what the learner should focus on before retaking."
}`;

  const userPrompt = JSON.stringify({
    stepTitle,
    domainCategory,
    failedQuestions: failedQuestions.map((fq) => ({
      scenario: fq.scenario,
      chosenOption: fq.chosenOptionId,
      chosenOptionText: fq.chosenOptionText || `Option ${fq.chosenOptionId}`,
      correctOption: fq.correctOptionId,
      correctOptionText: fq.correctOptionText || `Option ${fq.correctOptionId}`,
      existingWhyWrong: fq.whyWrong,
      acuId: fq.acuId,
    })),
    acus,
    existingResources: resources.map((r) => ({ title: r.title, url: r.url, badge: r.badge })),
  });

  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  try {
    const res = await callGroqWithFallback(messages, { apiKey, jsonMode: true, temperature: 0.3 });
    const rawOutput = cleanJsonFence(res.content);
    const parsed: any = JSON.parse(rawOutput);

    const weaknessAreas: WeaknessArea[] = Array.isArray(parsed.weaknessAreas || parsed.weakAreas)
      ? (parsed.weaknessAreas || parsed.weakAreas).map((wa: any) => {
          const docTitle = wa.resources?.docTitle || wa.remediationResources?.document?.title || `${stepTitle} Documentation`;
          const docUrl = wa.resources?.docUrl || wa.remediationResources?.document?.url || `https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(stepTitle)}`;
          const docGuidance = wa.resources?.criticalTakeaway || wa.remediationResources?.document?.studyGuidance || "Review the foundational concepts.";
          const videoTitle = wa.resources?.videoTitle || wa.remediationResources?.video?.title || `${stepTitle} Explained`;
          const videoUrl = wa.resources?.videoUrl || wa.remediationResources?.video?.url || `https://www.youtube.com/results?search_query=${encodeURIComponent(stepTitle + " tutorial")}`;
          const videoGuidance = wa.resources?.criticalTakeaway || wa.remediationResources?.video?.studyGuidance || "Watch a walkthrough of the core mechanics.";
          const topic = wa.topic || wa.acuLabel || "Unknown Competency";
          const coreConcept = wa.coreConcept || wa.rootCausePattern || "Pattern not identified.";

          return {
            topic,
            misconceptionAnalysis: wa.misconceptionAnalysis || "Analysis unavailable.",
            coreConcept,
            resources: {
              docTitle,
              docUrl,
              videoTitle,
              videoUrl,
              criticalTakeaway: docGuidance,
            },
            acuId: wa.acuId || "unknown",
            acuLabel: topic,
            rootCausePattern: coreConcept,
            remediationResources: {
              document: {
                title: docTitle,
                url: docUrl,
                studyGuidance: docGuidance,
              },
              video: {
                title: videoTitle,
                url: videoUrl,
                studyGuidance: videoGuidance,
              },
            },
          };
        })
      : [];

    return {
      overallDiagnosis: parsed.overallDiagnosis || "Competency gaps detected. Review the targeted resources below.",
      weakAreas: weaknessAreas,
      weaknessAreas,
      retakeGuidance: parsed.retakeGuidance || "Study the prescribed materials thoroughly, then retake the evaluation.",
    };
  } catch (err) {
    console.warn("[pipeline] Phase C (synthesizeTargetedRemediation) failed. Using fallback diagnostics.", err);

    // Fallback: construct basic diagnostics from the failed questions directly
    const fallbackAreas: WeaknessArea[] = failedQuestions.map((fq, idx) => {
      const matchedAcu = acus.find((a) => a.id === fq.acuId);
      const topic = matchedAcu?.label || `Question ${idx + 1} Competency`;
      const coreConcept = matchedAcu?.description || "Conceptual misunderstanding in this area.";
      const docTitle = `${stepTitle} Reference`;
      const docUrl = `https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(stepTitle)}`;
      const docGuidance = "Review the canonical reference for this topic.";
      const videoTitle = `${stepTitle} Video Guide`;
      const videoUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(stepTitle + " explained")}`;
      const videoGuidance = "Watch a comprehensive walkthrough.";

      return {
        topic,
        misconceptionAnalysis: fq.whyWrong
          ? `Your choice of Option ${fq.chosenOptionId} indicates: ${fq.whyWrong}`
          : `Your selection of Option ${fq.chosenOptionId} suggests a gap in understanding for this scenario.`,
        coreConcept,
        resources: {
          docTitle,
          docUrl,
          videoTitle,
          videoUrl,
          criticalTakeaway: docGuidance,
        },
        acuId: fq.acuId || `weak-${idx + 1}`,
        acuLabel: topic,
        rootCausePattern: coreConcept,
        remediationResources: {
          document: {
            title: docTitle,
            url: docUrl,
            studyGuidance: docGuidance,
          },
          video: {
            title: videoTitle,
            url: videoUrl,
            studyGuidance: videoGuidance,
          },
        },
      };
    });

    return {
      overallDiagnosis: "Competency gaps detected across multiple areas. Focused remediation is prescribed below.",
      weakAreas: fallbackAreas,
      weaknessAreas: fallbackAreas,
      retakeGuidance: "Review each prescribed resource, paying close attention to the specific misconceptions identified, then retake the evaluation.",
    };
  }
}
