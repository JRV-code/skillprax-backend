// skillprax-backend/src/lib/ai/pipeline.ts

import { TavilyCandidate, searchForStep } from "../search/tavily";

const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

/**
 * Ordered by preference. We try each until we find one the caller's API key
 * actually has access to. Multiple "generations" of the LLaMA lineup are
 * included on purpose so Groq's own model rotation/deprecation can never
 * hard-break step generation again (this is the direct fix for Issue B:
 * "model_not_found" on a hardcoded llama-3.3-70b-versatile string).
 */
const MODEL_PREFERENCE_LIST = [
  "llama-3.3-70b-versatile",
  "llama-3.1-70b-versatile",
  "llama-3.2-90b-vision-preview",
  "llama-3.1-8b-instant",
  "llama3-70b-8192",
  "llama3-8b-8192",
  "mixtral-8x7b-32768",
  "gemma2-9b-it",
];

interface GroqModelsResponse {
  data?: Array<{ id: string; [key: string]: unknown }>;
}

interface ResolvedModelCache {
  modelId: string;
  resolvedAt: number;
}

const modelCache = new Map<string, ResolvedModelCache>();
const MODEL_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

export class GroqConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GroqConfigError";
  }
}

export class GroqGenerationError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "GroqGenerationError";
  }
}

// Strictly verified Groq chat models in prioritized order:
// 1. Heavy pedagogical breakdown & reasoning: 120b / 70b
// 2. High-capacity fallback: 20b / 8b / 9b
export const ALLOWED_GROQ_MODELS = [
  "openai/gpt-oss-120b",
  "llama-3.3-70b-versatile",
  "openai/gpt-oss-20b",
  "llama-3.1-8b-instant",
  "gemma2-9b-it"
] as const;

export async function getActiveGroqModel(apiKey: string): Promise<string> {
  if (!apiKey || !apiKey.trim()) return "llama-3.1-8b-instant";
  const cleanKey = apiKey.trim();
  const cacheKey = cleanKey.slice(0, 12);
  const cached = modelCache.get(cacheKey);
  if (cached && Date.now() - cached.resolvedAt < MODEL_CACHE_TTL_MS) {
    return cached.modelId;
  }

  try {
    const res = await fetch("https://api.groq.com/openai/v1/models", {
      headers: { Authorization: `Bearer ${cleanKey}` }
    });

    if (res.ok) {
      const data: any = await res.json();
      const accountModels: string[] = (data.data || []).map((m: any) => m.id);

      // Select the highest-priority model enabled on the user's Groq account
      for (const modelId of ALLOWED_GROQ_MODELS) {
        if (accountModels.includes(modelId)) {
          console.log(`[Groq] Matched active whitelisted model: ${modelId}`);
          modelCache.set(cacheKey, { modelId, resolvedAt: Date.now() });
          return modelId;
        }
      }
    }
  } catch (err: any) {
    console.warn("[Groq] Model check failed, using fallback:", err.message);
  }

  // Safe universal fallback with 14,400 requests/day
  return "llama-3.1-8b-instant";
}

export const resolveAvailableModel = getActiveGroqModel;

interface GroqChatOptions {
  apiKey: string;
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
}

async function callGroq(options: GroqChatOptions, attempt = 0): Promise<string> {
  const { apiKey, systemPrompt, userPrompt, temperature = 0.4, maxTokens = 4096, jsonMode = true } = options;

  if (!apiKey) {
    throw new GroqConfigError("Groq API key is missing. Configure it in admin settings before generating content.");
  }

  const model = await resolveAvailableModel(apiKey);

  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature,
    max_tokens: maxTokens,
  };
  if (jsonMode) {
    body.response_format = { type: "json_object" };
  }

  let response: Response;
  try {
    response = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey.trim()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new GroqGenerationError(`Network error calling Groq: ${(err as Error).message}`, err);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const isModelError = response.status === 404 || /model_not_found|does not exist/i.test(text);

    if (isModelError && attempt < 1) {
      console.warn(`[groq] Model "${model}" rejected mid-flight, re-resolving and retrying once.`);
      modelCache.delete(apiKey.slice(0, 12));
      const idx = MODEL_PREFERENCE_LIST.indexOf(model);
      if (idx >= 0) MODEL_PREFERENCE_LIST.splice(idx, 1);
      return callGroq(options, attempt + 1);
    }

    throw new GroqGenerationError(`Groq generation failed: ${text || response.statusText}`);
  }

  const json = (await response.json()) as any;
  const content = json?.choices?.[0]?.message?.content;
  if (!content) {
    throw new GroqGenerationError("Groq returned an empty completion.");
  }
  return content;
}

function safeParseJson<T>(raw: string, context: string): T {
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(json)?/i, "").replace(/```$/, "").trim();
  }
  try {
    return JSON.parse(cleaned) as T;
  } catch (err) {
    throw new GroqGenerationError(
      `Failed to parse Groq JSON output for ${context}. Raw output started with: ${cleaned.slice(0, 200)}`
    );
  }
}

export interface CuratedResource {
  title: string;
  url: string;
  type: "video" | "article" | "documentation" | "paper" | "interactive" | "book" | "dataset" | "tool";
  badge: string;
  studyGuidance: string;
  sourceOrigin: "tavily" | "groq-internal";
}

export interface StepContent {
  conceptualOverview: string;
  keyTakeaways: string[];
  resources: CuratedResource[];
  estimatedMinutes: number;
  questionCount?: number;
  assessableUnits?: string[];
  whatYouWillLearn?: string;
  coreKeyTakeaways?: string[];
  practicalApplication?: string;
}

export interface GenerateStepContentParams {
  groqApiKey: string;
  tavilyApiKey: string | null | undefined;
  pillar: string;
  skillName: string;
  stepTitle: string;
  stepDescription: string;
  learnerLevel: "beginner" | "intermediate" | "advanced";
}

const CURATOR_SYSTEM_PROMPT = `You are the Curator Layer of SkillPrax, an autonomous educator engine. You behave like a genuine expert human mentor across any of the 9 Universal Knowledge Pillars: Natural Sciences, Mathematics, Engineering, Social Sciences, Business & Finance, Humanities & Law, Arts & Design, Health & Athletics, and Applied Crafts.

Your job for each learning step is to:
1. Write a clear, accurate conceptual overview in your own words (never copied from any source).
2. List key takeaways the learner must walk away understanding.
3. Curate a resource list. You are NEVER restricted to a fixed number or fixed mix of resource types — choose exactly what the concept needs. One authoritative document may be enough; a hard mechanism might need a video breakdown, a paper, and an interactive simulation.

CRITICAL RULES:
- You will be given a "candidatePool" of web search results. When candidatePool is non-empty, strongly prefer using those exact URLs verbatim — do not alter them.
- When candidatePool is EMPTY, you MUST NOT return an empty resources array. Instead, use your own internal knowledge to output real, direct, canonical URLs you are confident exist and are authoritative for this exact topic (e.g. MDN Web Docs pages, official language/framework documentation, Wikipedia articles, arXiv papers, official project sites, standards bodies, university OpenCourseWare pages). Mark these with sourceOrigin "groq-internal".
- NEVER output a search-engine results page or a "search?q=" / "results?search_query=" URL. Every resource URL must be a direct destination page.
- Every resource needs a short contextual "badge" (2-4 words, e.g. "Visual Mental Model", "Official Specification", "Interactive Sandbox", "Primary Source", "Worked Examples") and "studyGuidance" (1-2 sentences telling the learner exactly what to extract or do with it).
- Resources must be genuinely relevant to the exact step, not generic domain homepages.
- Respond ONLY with a single JSON object, no prose, no markdown fences, matching this exact shape:
{
  "conceptualOverview": string,
  "keyTakeaways": string[],
  "resources": [
    { "title": string, "url": string, "type": "video"|"article"|"documentation"|"paper"|"interactive"|"book"|"dataset"|"tool", "badge": string, "studyGuidance": string, "sourceOrigin": "tavily"|"groq-internal" }
  ],
  "estimatedMinutes": number,
  "questionCount": number,
  "assessableUnits": string[]
}`;

export async function generateStepContent(params: GenerateStepContentParams): Promise<StepContent> {
  const { groqApiKey, tavilyApiKey, pillar, skillName, stepTitle, stepDescription, learnerLevel } = params;

  let candidates: TavilyCandidate[] = [];
  try {
    candidates = await searchForStep({ apiKey: tavilyApiKey, pillar, skillName, stepTitle, stepDescription });
  } catch (err) {
    console.error("[pipeline] Tavily search threw unexpectedly, proceeding with empty candidate pool:", err);
    candidates = [];
  }

  const userPrompt = JSON.stringify({
    pillar,
    skillName,
    stepTitle,
    stepDescription,
    learnerLevel,
    candidatePool: candidates.map((c) => ({ title: c.title, url: c.url, snippet: c.snippet, domain: c.domain })),
    candidatePoolSize: candidates.length,
    instruction:
      candidates.length === 0
        ? "candidatePool is EMPTY. You must use your own internal canonical knowledge to produce direct, real, authoritative resource URLs. Do not return an empty resources array."
        : "Prefer candidatePool URLs verbatim. You may still add at most 1-2 additional resources from your own internal knowledge if a critical resource type is missing from the pool (mark those sourceOrigin as groq-internal).",
  });

  const raw = await callGroq({
    apiKey: groqApiKey,
    systemPrompt: CURATOR_SYSTEM_PROMPT,
    userPrompt,
    temperature: 0.4,
    maxTokens: 3072,
    jsonMode: true,
  });

  const parsed = safeParseJson<StepContent>(raw, `step content for "${stepTitle}"`);

  if (!Array.isArray(parsed.resources) || parsed.resources.length === 0) {
    console.warn(`[pipeline] Groq returned empty resources for "${stepTitle}". Applying internal fallback.`);
    const cleanTopic = encodeURIComponent(skillName || "topic");
    parsed.resources = [
      {
        title: `Official Reference: ${stepTitle}`,
        url: `https://en.wikipedia.org/wiki/Special:Search?search=${cleanTopic}`,
        type: "wiki" as any,
        badge: "Canonical Reference",
        studyGuidance: `Review foundational concepts and definitions for ${stepTitle}.`,
        sourceOrigin: "groq-internal"
      }
    ];
  }

  const TRAMPOLINE_RE = /(\/search\?|\/results\?|search_query=|\/s\?wd=)/i;
  parsed.resources = parsed.resources.filter((r) => r.url && !TRAMPOLINE_RE.test(r.url));

  if (parsed.resources.length === 0) {
    const cleanTopic = encodeURIComponent(skillName || "topic");
    parsed.resources = [
      {
        title: `Official Reference: ${stepTitle}`,
        url: `https://en.wikipedia.org/wiki/Special:Search?search=${cleanTopic}`,
        type: "wiki" as any,
        badge: "Canonical Reference",
        studyGuidance: `Review foundational concepts and definitions for ${stepTitle}.`,
        sourceOrigin: "groq-internal"
      }
    ];
  }

  // Populate backward compatibility fields
  parsed.whatYouWillLearn = parsed.conceptualOverview || parsed.whatYouWillLearn || "";
  parsed.coreKeyTakeaways = parsed.keyTakeaways || parsed.coreKeyTakeaways || [];

  return parsed;
}

export interface QuizQuestion {
  id: string;
  acuLabel: string;
  scenario: string;
  question: string;
  options: string[];
  correctIndex: number;
  distractorExplanations: string[];
}

export interface GeneratedQuiz {
  acuBreakdown: string[];
  questionCount: number;
  questions: QuizQuestion[];
}

export interface GenerateQuizParams {
  groqApiKey: string;
  pillar: string;
  skillName: string;
  stepTitle: string;
  stepDescription: string;
  conceptualOverview: string;
  learnerLevel: "beginner" | "intermediate" | "advanced";
}

const QUIZ_SYSTEM_PROMPT = `You are the diagnostic evaluation layer of SkillPrax. For a given learning step, you must:

1. Decompose the step's conceptual density into "Atomic Competency Units" (ACUs) — the distinct mechanisms, failure modes, trade-offs, or facts a competent learner must be able to apply. A shallow step might have 3 ACUs; a dense one might have up to 10. NEVER let the user choose this number — you determine it from the material itself.
2. Write exactly one scenario-based, application-level question per ACU (not simple recall). Each question needs 4 options, exactly one correct, and a distinct explanation for EVERY option (including the correct one) describing what misconception each wrong answer reflects.

Constraints:
- questionCount must equal the number of ACUs you identified, and must be between 3 and 10 inclusive. If your natural ACU count falls outside that range, merge closely related ACUs or split an overly broad one until it fits, without losing coverage.
- Questions must test understanding and application, not just definition recall.
- Respond ONLY with a single JSON object, no prose, no markdown fences, matching this exact shape:
{
  "acuBreakdown": string[],
  "questionCount": number,
  "questions": [
    {
      "id": string,
      "acuLabel": string,
      "scenario": string,
      "question": string,
      "options": string[4],
      "correctIndex": number,
      "distractorExplanations": string[4]
    }
  ]
}`;

export async function generateQuiz(params: GenerateQuizParams): Promise<GeneratedQuiz> {
  const { groqApiKey, pillar, skillName, stepTitle, stepDescription, conceptualOverview, learnerLevel } = params;

  const userPrompt = JSON.stringify({ pillar, skillName, stepTitle, stepDescription, conceptualOverview, learnerLevel });

  const raw = await callGroq({
    apiKey: groqApiKey,
    systemPrompt: QUIZ_SYSTEM_PROMPT,
    userPrompt,
    temperature: 0.5,
    maxTokens: 4096,
    jsonMode: true,
  });

  const parsed = safeParseJson<GeneratedQuiz>(raw, `quiz for "${stepTitle}"`);

  if (!Array.isArray(parsed.questions) || parsed.questions.length === 0) {
    throw new GroqGenerationError(`Groq returned zero quiz questions for step "${stepTitle}".`);
  }
  if (parsed.questions.length < 3 || parsed.questions.length > 10) {
    console.warn(
      `[pipeline] Quiz for "${stepTitle}" returned ${parsed.questions.length} questions, outside the 3-10 ACU range.`
    );
  }
  parsed.questionCount = parsed.questions.length;

  return parsed;
}

// Backward compatibility alias
export async function runPedagogicalCuratorPipeline(params: {
  domain: string;
  topic: string;
  stepIndex: number;
  stepTitle: string;
  goal: string;
  groqKey: string;
  tavilyKey?: string | null;
}) {
  const content = await generateStepContent({
    groqApiKey: params.groqKey,
    tavilyApiKey: params.tavilyKey,
    pillar: params.domain,
    skillName: params.topic,
    stepTitle: params.stepTitle,
    stepDescription: params.goal,
    learnerLevel: "beginner"
  });

  return {
    whatYouWillLearn: content.conceptualOverview,
    coreKeyTakeaways: content.keyTakeaways,
    practicalApplication: params.goal,
    questionCount: content.questionCount || 5,
    assessableUnits: content.assessableUnits || content.keyTakeaways,
    resources: content.resources
  };
}
