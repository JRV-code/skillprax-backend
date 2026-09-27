import { GoogleGenAI } from '@google/genai';
import prisma from '../prisma';
import { searchTavilyCandidates, searchWeb } from '../search/tavily';
import { generateWithGemini } from './gemini';

export const FREE_AI_FLEET = {
  groq: {
    name: 'Groq Cloud (Free Tier)',
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    fastModel: 'openai/gpt-oss-20b',       // Ultra-fast (~1000 t/s) for pings and quick evaluations
    reasoningModel: 'openai/gpt-oss-120b', // Deep step generation & textbook curation (~500 t/s)
    fallbackModel: 'qwen/qwen3.8-27b',
  },
  gemini: {
    name: 'Google AI Studio (Free Tier)',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/models',
    primaryModel: 'gemini-3.7-flash',      // Current official flagship workhorse
    fallbackModel: 'gemini-3.5-flash',
  },
  openrouter: {
    name: 'OpenRouter (Free Models)',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    primaryModel: 'openai/gpt-oss-120b:free',
    fallbackModel: 'meta-llama/llama-3.3-70b-instruct:free',
  },
};

export const AI_PROVIDERS = {
  gemini: {
    name: FREE_AI_FLEET.gemini.name,
    endpoint: FREE_AI_FLEET.gemini.endpoint,
    models: {
      fast: FREE_AI_FLEET.gemini.primaryModel,
      pro: FREE_AI_FLEET.gemini.primaryModel,
      fallback: FREE_AI_FLEET.gemini.fallbackModel,
    },
    defaultModel: FREE_AI_FLEET.gemini.primaryModel,
  },
  openai: {
    name: 'OpenAI',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    models: {
      fast: 'gpt-4o-mini',
      pro: 'gpt-4o',
      reasoning: 'o3-mini',
    },
    defaultModel: 'gpt-4o',
  },
  anthropic: {
    name: 'Anthropic Claude',
    endpoint: 'https://api.anthropic.com/v1/messages',
    models: {
      fast: 'claude-3-5-haiku-latest',
      pro: 'claude-3-7-sonnet-latest',
    },
    defaultModel: 'claude-3-7-sonnet-latest',
  },
  groq: {
    name: FREE_AI_FLEET.groq.name,
    endpoint: FREE_AI_FLEET.groq.endpoint,
    models: {
      fast: FREE_AI_FLEET.groq.fastModel,
      pro: FREE_AI_FLEET.groq.reasoningModel,
      fallback: FREE_AI_FLEET.groq.fallbackModel,
    },
    defaultModel: FREE_AI_FLEET.groq.reasoningModel,
  },
  openrouter: {
    name: FREE_AI_FLEET.openrouter.name,
    endpoint: FREE_AI_FLEET.openrouter.endpoint,
    models: {
      fast: FREE_AI_FLEET.openrouter.primaryModel,
      pro: FREE_AI_FLEET.openrouter.primaryModel,
      fallback: FREE_AI_FLEET.openrouter.fallbackModel,
    },
    defaultModel: FREE_AI_FLEET.openrouter.primaryModel,
  },
};

export interface ProviderConfig {
  endpoint: string;
  defaultModel: string;
}

export const SUPPORTED_PROVIDERS: Record<string, ProviderConfig> = {
  groq: {
    endpoint: FREE_AI_FLEET.groq.endpoint,
    defaultModel: FREE_AI_FLEET.groq.reasoningModel,
  },
  openai: {
    endpoint: AI_PROVIDERS.openai.endpoint,
    defaultModel: AI_PROVIDERS.openai.defaultModel,
  },
  anthropic: {
    endpoint: AI_PROVIDERS.anthropic.endpoint,
    defaultModel: AI_PROVIDERS.anthropic.defaultModel,
  },
  gemini: {
    endpoint: `${FREE_AI_FLEET.gemini.endpoint}/${FREE_AI_FLEET.gemini.primaryModel}:generateContent`,
    defaultModel: FREE_AI_FLEET.gemini.primaryModel,
  },
  openrouter: {
    endpoint: FREE_AI_FLEET.openrouter.endpoint,
    defaultModel: FREE_AI_FLEET.openrouter.primaryModel,
  },
};

export function safeJsonParse<T>(val: any, fallback: T): T {
  if (val === null || val === undefined) return fallback;
  if (typeof val === 'string') {
    try {
      return JSON.parse(val) as T;
    } catch {
      return fallback;
    }
  }
  return val as T;
}

export function safeJsonStringify(val: any): string {
  if (typeof val === 'string') return val;
  return JSON.stringify(val ?? null);
}

/**
 * Retrieves the API key for a given provider from AdminConfig (DB) or fallback .env
 */
export async function getProviderKey(provider: string): Promise<{ apiKey: string; defaultProvider: string }> {
  const config = await prisma.adminConfig.findUnique({
    where: { id: 'global_config' },
  });

  let apiKey = '';
  const defaultProvider = config?.defaultProvider || 'groq';
  const prov = (provider || defaultProvider).toLowerCase();

  if (prov === 'groq') {
    apiKey = config?.groqKey || process.env.GROQ_API_KEY || '';
  } else if (prov === 'openai') {
    apiKey = config?.openaiKey || process.env.OPENAI_API_KEY || '';
  } else if (prov === 'anthropic') {
    apiKey = config?.anthropicKey || process.env.ANTHROPIC_API_KEY || '';
  } else if (prov === 'gemini') {
    apiKey = config?.geminiKey || process.env.GEMINI_API_KEY || '';
  } else if (prov === 'openrouter') {
    apiKey = (config as any)?.openrouterKey || process.env.OPENROUTER_API_KEY || '';
  } else if (prov === 'tavily') {
    apiKey = (config as any)?.tavilyKey || process.env.TAVILY_API_KEY || '';
  }

  return { apiKey, defaultProvider };
}

/**
 * Strips markdown code blocks and parses clean JSON
 */
export function parseJsonResponse<T>(rawText: string): T {
  let cleaned = rawText.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
  }
  return JSON.parse(cleaned) as T;
}

export function sanitizeResourceUrl(url?: string, title?: string, type?: string): string {
  const t = (title || 'tutorial').trim();
  const resType = (type || 'guide').toLowerCase();

  if (url && typeof url === 'string' && url.startsWith('http')) {
    if (
      !url.includes('example.com') &&
      !url.includes('placeholder') &&
      !url.includes('localhost')
    ) {
      return url;
    }
  }

  if (resType.includes('video') || resType.includes('youtube')) {
    return `https://www.youtube.com/results?search_query=${encodeURIComponent(`${t} full tutorial`)}`;
  }
  if (resType.includes('wiki') || resType.includes('wikipedia')) {
    return `https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(t)}`;
  }
  if (resType.includes('pdf') || resType.includes('paper')) {
    return `https://www.google.com/search?q=${encodeURIComponent(`${t} filetype:pdf OR open textbook`)}`;
  }
  if (resType.includes('interactive') || resType.includes('playground') || resType.includes('repo')) {
    return `https://github.com/search?q=${encodeURIComponent(t)}`;
  }
  return `https://www.google.com/search?q=${encodeURIComponent(`${t} comprehensive guide`)}`;
}

export function sanitizeBookUrl(title: string, author?: string): string {
  const query = `${title} ${author || ''}`.trim();
  return `https://openlibrary.org/search?q=${encodeURIComponent(query)}`;
}

export function normalizeResources(resources: any[]): any[] {
  if (!Array.isArray(resources)) return [];
  return resources.map((res, index) => {
    const priority = typeof res.priority === 'number' ? res.priority : index + 1;
    const badge = res.badge || (priority === 1 ? 'START HERE' : priority === 2 ? 'FOUNDATIONAL WIKI' : 'DEEP STUDY');
    const title = res.title || `Resource ${priority}`;
    const type = res.type || 'guide';
    const url = sanitizeResourceUrl(res.url, title, type);
    const studyGuidance =
      res.studyGuidance ||
      res.whyThisFirst ||
      `Study this material to build your core understanding of ${title}.`;

    return {
      priority,
      badge,
      title,
      url,
      type,
      studyGuidance,
      whyThisFirst: studyGuidance,
    };
  });
}


async function callGemini(cleanKey: string, prompt: string): Promise<string> {
  const result = await generateWithGemini(prompt, cleanKey);
  return typeof result === 'string' ? result : JSON.stringify(result);
}

/**
 * Universal Unified LLM Caller
 */
export async function callLLM(
  provider: string,
  systemPrompt: string,
  userPrompt: string,
  overrideKey?: string,
  isDeepReasoning = false
): Promise<string> {
  const targetProvider = (provider || 'gemini').toLowerCase();

  let apiKey = overrideKey;
  if (!apiKey) {
    const keyInfo = await getProviderKey(targetProvider);
    apiKey = keyInfo.apiKey;
  }

  if (targetProvider !== 'openrouter' && (!apiKey || !apiKey.trim())) {
    throw new Error(`API key for provider '${targetProvider}' is missing. Please configure it in Admin Command Center.`);
  }

  const cleanKey = (apiKey || '').trim();

  if (targetProvider === 'anthropic') {
    const model = isDeepReasoning
      ? AI_PROVIDERS.anthropic.models.pro
      : AI_PROVIDERS.anthropic.defaultModel;

    const response = await fetch(AI_PROVIDERS.anthropic.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': cleanKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 4000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Anthropic API error (${response.status}): ${errText}`);
    }

    const data: any = await response.json();
    return data.content?.[0]?.text || '';
  }

  if (targetProvider === 'gemini') {
    return callGemini(cleanKey, `${systemPrompt}\n\nUSER REQUEST:\n${userPrompt}`);
  }

  if (targetProvider === 'openrouter') {
    const model = FREE_AI_FLEET.openrouter.primaryModel;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://skillprax.dev',
      'X-Title': 'SkillPrax Engine',
    };
    if (cleanKey) {
      headers['Authorization'] = `Bearer ${cleanKey}`;
    }

    const response = await fetch(FREE_AI_FLEET.openrouter.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.3,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      let errorMsg = errText;
      try {
        const errObj = JSON.parse(errText);
        if (errObj.error?.message) errorMsg = errObj.error.message;
      } catch (_) {}
      throw new Error(`OpenRouter API error (${response.status}): ${errorMsg}`);
    }

    const data: any = await response.json();
    return data.choices?.[0]?.message?.content || '';
  }

  // Groq and OpenAI
  const targetEndpoint =
    targetProvider === 'openai' ? AI_PROVIDERS.openai.endpoint : FREE_AI_FLEET.groq.endpoint;
  const targetModel =
    targetProvider === 'openai'
      ? isDeepReasoning
        ? AI_PROVIDERS.openai.models.reasoning
        : AI_PROVIDERS.openai.defaultModel
      : isDeepReasoning
      ? FREE_AI_FLEET.groq.reasoningModel
      : FREE_AI_FLEET.groq.fastModel;

  const response = await fetch(targetEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${cleanKey}`,
    },
    body: JSON.stringify({
      model: targetModel,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.3,
      response_format: { type: 'json_object' },
    }),
  }).catch(() => {
    return fetch(targetEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cleanKey}`,
      },
      body: JSON.stringify({
        model: targetModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.3,
      }),
    });
  });

  if (!response.ok) {
    const errText = await response.text();
    let errorMsg = errText;
    try {
      const errObj = JSON.parse(errText);
      if (errObj.error?.message) errorMsg = errObj.error.message;
    } catch (_) {}
    throw new Error(`${targetProvider.toUpperCase()} API error (${response.status}): ${errorMsg}`);
  }

  const data: any = await response.json();
  return data.choices?.[0]?.message?.content || '';
}

/**
 * Aggregates workspace baseline knowledge, target goal, passed steps, and attempts
 */
export async function buildContextPayload(workspaceId: string): Promise<string> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    include: {
      steps: {
        orderBy: { stepIndex: 'asc' },
        include: { attempts: true },
      },
    },
  });

  if (!workspace) return '';

  const passedSteps = workspace.steps.filter((s) => s.status === 'PASSED');
  const allAttempts = workspace.steps.flatMap((s) => s.attempts);

  const contextData = {
    title: workspace.title,
    category: workspace.category,
    baselineKnowledge: workspace.baselineKnowledge,
    targetGoal: workspace.targetGoal,
    completedSteps: passedSteps.map((s) => ({
      stepIndex: s.stepIndex,
      title: s.title,
      whatYouWillLearn: s.whatYouWillLearn,
      passingScore: s.passingScore,
    })),
    pastDiagnosticReports: allAttempts
      .filter((a) => !a.passed && a.diagnosticReport)
      .map((a) => ({
        diagnosticReport: a.diagnosticReport,
        weakConcepts: safeJsonParse<string[]>(a.weakConcepts, []),
      })),
  };

  return JSON.stringify(contextData, null, 2);
}

export async function generateInitiationData(
  title: string,
  category: string,
  baselineKnowledge: string,
  targetGoal: string,
  provider: string
) {
  const keyInfo = await getProviderKey(provider);
  const activeProvider = (provider || keyInfo.defaultProvider || 'gemini').toLowerCase();

  let searchPromptContext = '';
  try {
    const tavilyKeyInfo = await getProviderKey('tavily');
    const candidates = await searchTavilyCandidates(`${title} ${category}`, tavilyKeyInfo.apiKey || '');
    if (candidates && candidates.length > 0) {
      searchPromptContext = `\n\nLIVE WEB RESEARCH CANDIDATES HARVESTED BY TAVILY:\n${JSON.stringify(candidates, null, 2)}\nYou MUST evaluate these candidates, pick the high-yield items, and build valid resource links using their verified URLs or search anchors. Never guess fake URLs.`;
    }
  } catch (_) {
    // Graceful fallback if Tavily is missing or fails
  }

  const systemPrompt = `You are a world-class mentor and educator dedicated to helping a student genuinely master complex subjects.
Your goal is not to fill arbitrary templates, but to teach effectively.
Analyze the user's learning goal and Tavily's live web discoveries.
Make thoughtful, custom decisions on what materials are necessary, how to study them, and how to verify understanding.
Output your final curriculum strictly in valid JSON without preamble.`;

  const userPrompt = `Create a custom mastery learning plan for a user.
Workspace Focus:
- Skill/Technology Title: "${title}"
- Domain/Context: "${category}"
- Baseline Knowledge: "${baselineKnowledge}"
- Target Goal: "${targetGoal}"
${searchPromptContext}

INSTRUCTOR INSTRUCTIONS:
1. "whatYouWillLearn":
   - Explain the concept thoroughly (2-3 paragraphs). Break down the mental model, prerequisites, and common pitfalls learners encounter.

2. "coreKeyTakeaways":
   - Provide concrete takeaways (syntax, mechanisms, formulas, or architectural trade-offs).

3. "practicalApplication":
   - Explain how Step 1 directly enables achieving "${targetGoal}".

4. AUTONOMOUS RESOURCE SELECTION ("resources"):
   - Do NOT adhere to a fixed resource count. Decide organically (choose 1 to 5 items based on necessity).
   - Choose whatever media format actually helps the learner (video, pdf, interactive playground, documentation, wiki, research paper, repository).
   - Use verified links from Tavily or guaranteed search anchors (YouTube, Wikipedia, OpenLibrary, DevDocs).
   - For each resource, give it an intuitive, contextual badge (e.g., "Interactive Sandbox", "Core Lecture", "Quick Cheat Sheet", "Deep Reference Paper", "Field Guide").
   - Clearly explain in "studyGuidance" how the student should use this resource and why it fits into their sequence.

5. AUTONOMOUS QUIZ SIZING ("questionCount"):
   - Decide the exact number of questions needed to rigorously test this step (e.g. 3 to 10 questions based on step difficulty).

OUTPUT JSON SCHEMA:
{
  "estimatedTotalSteps": 5,
  "recommendedBooks": [
    {
      "title": "string",
      "author": "string",
      "whyRead": "string",
      "searchUrl": "https://openlibrary.org/search?q=..."
    }
  ],
  "step1": {
    "title": "string",
    "difficulty": "Beginner",
    "whatYouWillLearn": "string",
    "coreKeyTakeaways": ["string"],
    "practicalApplication": "string",
    "estimatedMinutes": 45,
    "passingScore": 80,
    "questionCount": 5,
    "resources": [
      {
        "priority": 1,
        "badge": "string (contextual label)",
        "type": "video" | "pdf" | "wiki" | "guide" | "website" | "interactive",
        "title": "string",
        "url": "string",
        "studyGuidance": "string"
      }
    ]
  }
}`;

  let data: any;
  if (activeProvider === 'gemini') {
    data = await generateWithGemini(userPrompt, keyInfo.apiKey);
  } else {
    const rawJson = await callLLM(provider, systemPrompt, userPrompt);
    data = parseJsonResponse<any>(rawJson);
  }

  if (data?.step1?.resources) {
    data.step1.resources = normalizeResources(data.step1.resources);
  }
  if (Array.isArray(data?.recommendedBooks)) {
    data.recommendedBooks = data.recommendedBooks.map((b: any) => ({
      ...b,
      searchUrl: sanitizeBookUrl(b.title, b.author),
    }));
  }

  return data;
}

export async function generateQuizQuestions(
  stepTitle: string,
  stepObjective: string,
  difficulty: string,
  questionCount: number,
  provider: string,
  contextPayload?: string
) {
  const count = Math.min(Math.max(Number(questionCount) || 5, 1), 15);
  const systemPrompt = `You are a rigorous technical examiner. You MUST return your output strictly as a valid JSON object matching the requested schema. The response must be pure JSON with no preamble.`;

  const userPrompt = `Generate a scenario-based diagnostic technical evaluation quiz in valid json format for the topic: "${stepTitle}".
Overview & Concepts: "${stepObjective}"
Difficulty: "${difficulty}"
Target Question Count: ${count}
${contextPayload ? `Learner Context Payload:\n${contextPayload}` : ''}

Requirements:
- Provide exactly ${count} challenging, scenario-based multiple choice questions in valid json format.
- Test real-world scenarios, underlying mechanisms, troubleshooting distractor choices, and trade-off analysis.
- Each question must provide 4 distinct options (Option A, Option B, Option C, Option D).
- "correctIndex" must be an integer (0, 1, 2, or 3).
- "conceptTested" must name the target concept.
- "explanation" must explain why the correct answer is right and why distractors are wrong.

Format your response as a valid json object:
{
  "questions": [
    {
      "id": "q1",
      "question": "...",
      "options": ["Option A", "Option B", "Option C", "Option D"],
      "correctIndex": 0,
      "conceptTested": "...",
      "explanation": "..."
    }
  ]
}`;

  const rawJson = await callLLM(provider, systemPrompt, userPrompt);
  return parseJsonResponse<{ questions: any[] }>(rawJson);
}

export async function generateDiagnosticReport(
  stepTitle: string,
  stepObjective: string,
  failedQuestions: any[],
  provider: string,
  contextPayload?: string
) {
  const systemPrompt = `You are SkillPrax AI Diagnostic Agent. You analyze flawed student reasoning and generate targeted remediation. Output ONLY valid JSON matching schema.`;

  const userPrompt = `A learner failed the evaluation quiz on step "${stepTitle}".
Overview & Concepts: "${stepObjective}"
Failed Questions & Selections:
${JSON.stringify(failedQuestions, null, 2)}
${contextPayload ? `Learner Context Payload:\n${contextPayload}` : ''}

Generate:
1. "diagnosticReport": Two direct paragraphs explaining why the chosen option is flawed and clarifying the core principle.
2. "weakConcepts": Array of specific failed terms/concepts (e.g., ["State Vector Representation"]).
3. "remedialResources": 2 search links addressing the exact errors.

Output JSON:
{
  "diagnosticReport": "...",
  "weakConcepts": ["..."],
  "remedialResources": [
    {
      "title": "...",
      "url": "https://www.google.com/search?q=...",
      "type": "youtube",
      "focusArea": "..."
    }
  ]
}`;

  // Use flagship reasoning model for diagnostics
  const rawJson = await callLLM(provider, systemPrompt, userPrompt, undefined, true);
  return parseJsonResponse<{
    diagnosticReport: string;
    weakConcepts: string[];
    remedialResources: any[];
  }>(rawJson);
}

export async function generateRemedialQuiz(
  stepTitle: string,
  stepObjective: string,
  weakConcepts: string[],
  provider: string,
  contextPayload?: string
) {
  const systemPrompt = `You are SkillPrax Quiz Engine. Generate targeted remedial questions for weak concepts only. Output ONLY valid JSON.`;

  const userPrompt = `Generate a targeted 3-4 question remedial quiz for "${stepTitle}".
Overview & Concepts: "${stepObjective}"
Weak Concepts: ${JSON.stringify(weakConcepts)}
${contextPayload ? `Learner Context Payload:\n${contextPayload}` : ''}

Output JSON:
{
  "questions": [
    {
      "id": "rq1",
      "question": "...",
      "options": ["Option A", "Option B", "Option C", "Option D"],
      "correctIndex": 0,
      "conceptTested": "..."
    }
  ]
}`;

  const rawJson = await callLLM(provider, systemPrompt, userPrompt);
  return parseJsonResponse<{ questions: any[] }>(rawJson);
}

export async function generateNextStep(
  workspace: any,
  provider: string,
  contextPayload: string
) {
  const nextStepIndex = workspace.currentStepIndex + 1;
  const keyInfo = await getProviderKey(provider);
  const activeProvider = (provider || keyInfo.defaultProvider || 'gemini').toLowerCase();

  let searchPromptContext = '';
  try {
    const tavilyKeyInfo = await getProviderKey('tavily');
    const candidates = await searchTavilyCandidates(`${workspace.title} step ${nextStepIndex}`, tavilyKeyInfo.apiKey || '');
    if (candidates && candidates.length > 0) {
      searchPromptContext = `\n\nLIVE WEB RESEARCH CANDIDATES HARVESTED BY TAVILY:\n${JSON.stringify(candidates, null, 2)}\nYou MUST evaluate these candidates, pick the high-yield items, and build valid resource links using their verified URLs or search anchors. Never guess fake URLs.`;
    }
  } catch (_) {}

  const systemPrompt = `You are a world-class mentor and educator dedicated to helping a student genuinely master complex subjects.
Your goal is not to fill arbitrary templates, but to teach effectively.
Analyze the user's learning goal, context history, and Tavily's live web discoveries.
Make thoughtful, custom decisions on what materials are necessary for Step ${nextStepIndex}, how to study them, and how to verify understanding.
Output your final curriculum strictly in valid JSON without preamble.`;

  const userPrompt = `The learner mastered Step ${workspace.currentStepIndex} in "${workspace.title}".
Baseline Knowledge: "${workspace.baselineKnowledge}"
Target Goal: "${workspace.targetGoal}"
Generate Step ${nextStepIndex} of total ${workspace.estimatedTotalSteps}.
Context Payload:
${contextPayload}
${searchPromptContext}

INSTRUCTOR INSTRUCTIONS FOR STEP ${nextStepIndex}:
1. "whatYouWillLearn":
   - Explain the concept thoroughly (2-3 paragraphs). Break down the mental model, prerequisites, and common pitfalls learners encounter.

2. "coreKeyTakeaways":
   - Provide concrete takeaways (syntax, mechanisms, formulas, or architectural trade-offs).

3. "practicalApplication":
   - Explain how Step ${nextStepIndex} directly connects to the student's real-world target goal.

4. AUTONOMOUS RESOURCE SELECTION ("resources"):
   - Decide organically on resource count (1 to 5 items based on necessity).
   - Choose whatever media format actually helps the learner (video, pdf, interactive playground, documentation, wiki, research paper, repository).
   - For each resource, give it an intuitive, contextual badge (e.g., "Interactive Sandbox", "Core Lecture", "Quick Cheat Sheet", "Deep Reference Paper", "Field Guide").
   - Clearly explain in "studyGuidance" how the student should use this resource and why it fits into their sequence.

5. AUTONOMOUS QUIZ SIZING ("questionCount"):
   - Decide the exact number of questions needed to test this step (e.g. 3 to 10 questions based on difficulty).

OUTPUT JSON SCHEMA:
{
  "step": {
    "stepIndex": ${nextStepIndex},
    "title": "string",
    "difficulty": "${nextStepIndex <= 2 ? 'Intermediate' : nextStepIndex <= 4 ? 'Advanced' : 'Mastery'}",
    "whatYouWillLearn": "string",
    "coreKeyTakeaways": ["string"],
    "practicalApplication": "string",
    "estimatedMinutes": 45,
    "passingScore": 80,
    "questionCount": 5,
    "resources": [
      {
        "priority": 1,
        "badge": "string (contextual label)",
        "type": "video" | "pdf" | "wiki" | "guide" | "website" | "interactive",
        "title": "string",
        "url": "string",
        "studyGuidance": "string"
      }
    ]
  }
}`;

  let data: any;
  if (activeProvider === 'gemini') {
    data = await generateWithGemini(userPrompt, keyInfo.apiKey);
  } else {
    const rawJson = await callLLM(provider, systemPrompt, userPrompt);
    data = parseJsonResponse<{ step: any }>(rawJson);
  }

  if (data?.step?.resources) {
    data.step.resources = normalizeResources(data.step.resources);
  }

  return data;
}

export async function testProviderConnection(provider: string, key?: string) {
  const startTime = Date.now();
  const prov = (provider || 'groq').toLowerCase();

  try {
    let apiKey = key?.trim();
    if (!apiKey) {
      const keyInfo = await getProviderKey(prov);
      apiKey = keyInfo.apiKey?.trim();
    }

    if (prov !== 'openrouter' && prov !== 'tavily' && !apiKey) {
      throw new Error(`API key for provider '${prov}' is missing. Please configure it in Admin Settings.`);
    }

    if (prov === 'tavily') {
      const cleanKey = (apiKey || '').trim();
      if (!cleanKey) {
        throw new Error("Tavily API key is missing. Please configure it in Admin Command Center.");
      }
      const res = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${cleanKey}`,
        },
        body: JSON.stringify({
          api_key: cleanKey,
          query: 'ping',
          max_results: 1,
        }),
      });

      const latencyMs = Date.now() - startTime;
      if (res.ok) {
        return { ok: true, latencyMs, response: 'Tavily Web Search operational. Live search connection verified.' };
      }
      const errText = await res.text();
      return { ok: false, latencyMs, error: `Tavily API error (${res.status}): ${errText}` };
    }

    if (prov === 'gemini') {
      const cleanKey = (apiKey || '').trim();
      const modelsToTry = [FREE_AI_FLEET.gemini.primaryModel, FREE_AI_FLEET.gemini.fallbackModel];
      let lastError = '';

      for (const modelName of modelsToTry) {
        // 1. Try official SDK
        try {
          const ai = new GoogleGenAI({ apiKey: cleanKey });
          const response = await ai.models.generateContent({
            model: modelName,
            contents: 'ping',
          });
          const latencyMs = Date.now() - startTime;
          const replyText = response.text || 'ok';
          return { ok: true, latencyMs, response: replyText };
        } catch (err: any) {
          lastError = err?.message || String(err);
        }

        // 2. Direct REST endpoint
        try {
          const endpoint = `${FREE_AI_FLEET.gemini.endpoint}/${modelName}:generateContent?key=${encodeURIComponent(cleanKey)}`;
          const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
              generationConfig: { maxOutputTokens: 5 },
            }),
          });

          const latencyMs = Date.now() - startTime;

          if (response.ok) {
            const data: any = await response.json();
            const replyText = data.candidates?.[0]?.content?.parts?.[0]?.text || 'ok';
            return { ok: true, latencyMs, response: replyText };
          }

          const errText = await response.text();
          let errorMsg = errText;
          try {
            const errJson = JSON.parse(errText);
            if (errJson.error?.message) {
              errorMsg = errJson.error.message;
            }
          } catch (_) {}

          lastError = errorMsg;
          if (response.status !== 404 && !errText.includes('NOT_FOUND')) {
            return { ok: false, latencyMs, error: lastError };
          }
        } catch (restErr: any) {
          lastError = restErr?.message || String(restErr);
        }
      }

      const latencyMs = Date.now() - startTime;
      return { ok: false, latencyMs, error: lastError || 'Gemini connection failed' };
    }

    const response = await callLLM(
      prov,
      'You are a connection ping checker. Output JSON: {"status": "ok"}',
      'Ping status test',
      apiKey,
      false // Use fast model for pings
    );
    const latencyMs = Date.now() - startTime;
    return { ok: true, latencyMs, response };
  } catch (err: any) {
    const latencyMs = Date.now() - startTime;
    return { ok: false, latencyMs, error: err?.message || String(err) || 'Connection failed' };
  }
}
