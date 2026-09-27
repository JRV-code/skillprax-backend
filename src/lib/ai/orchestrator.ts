import { GoogleGenAI } from '@google/genai';
import prisma from '../prisma';
import { searchWeb } from '../search/tavily';
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
  const defaultProvider = config?.defaultProvider || 'gemini';
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
  const resType = (type || 'docs').toLowerCase();

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
    return `https://www.youtube.com/results?search_query=${encodeURIComponent(`${t} tutorial`)}`;
  }
  if (resType.includes('book') || resType.includes('openlibrary')) {
    return `https://openlibrary.org/search?q=${encodeURIComponent(t)}`;
  }
  return `https://devdocs.io/#q=${encodeURIComponent(t)}`;
}

export function sanitizeBookUrl(title: string, author?: string): string {
  const query = `${title} ${author || ''}`.trim();
  return `https://openlibrary.org/search?q=${encodeURIComponent(query)}`;
}

export function normalizeResources(resources: any[]): any[] {
  if (!Array.isArray(resources)) return [];
  const sliced = resources.slice(0, 3);
  return sliced.map((res, index) => {
    const priority = index + 1;
    const badge =
      priority === 1 ? 'START HERE' : priority === 2 ? 'APPLY & PRACTICE' : 'DEEP DIVE';
    const title = res.title || `Resource ${priority}`;
    const url = sanitizeResourceUrl(res.url, title, res.type);
    const type = res.type || (priority === 1 ? 'video' : 'docs');
    const whyThisFirst =
      res.whyThisFirst ||
      (priority === 1
        ? 'Watch/Read this foundational breakdown first to build the core visual mental model.'
        : priority === 2
        ? 'Use this authoritative manual to write code and test key mechanisms.'
        : 'Explore advanced edge cases and production considerations.');

    return {
      priority,
      badge: res.badge || badge,
      title,
      url,
      type,
      whyThisFirst,
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

  // If Gemini, use native Google search grounding directly without requiring Tavily
  if (activeProvider === 'gemini') {
    const prompt = `You are SkillPrax, an expert AI pedagogical architect with native real-time Google search capabilities. Establish a deep, dynamic, personalized learning path with verified live URLs without rigid templates. Output ONLY valid JSON matching the requested schema.

Create a custom mastery learning plan for a user.
Workspace Focus:
- Skill/Technology Title: "${title}"
- Domain/Context: "${category}"
- Baseline Knowledge: "${baselineKnowledge}"
- Target Goal: "${targetGoal}"

Pedagogical Requirements for Step 1:
1. "whatYouWillLearn": Comprehensive conceptual overview (2-3 detailed paragraphs explaining mental models, core architecture, and prerequisites).
2. "coreKeyTakeaways": Array of 3 to 5 concrete strings (exact mechanisms, terms, syntax rules, or mental models).
3. "practicalApplication": Explanation of how Step 1 directly enables achieving "${targetGoal}".
4. "estimatedMinutes": Realistic integer duration in minutes (e.g. 45).
5. "resources": Array of EXACTLY 1 to 3 prioritized, sequence-ranked learning resources:
   - Priority 1 (badge: "START HERE"): Best foundational video or interactive walkthrough.
   - Priority 2 (badge: "APPLY & PRACTICE"): Authoritative reference manual or official documentation page.
   - Priority 3 (badge: "DEEP DIVE"): Optional item for complex edge cases.
   - Include "whyThisFirst" explaining why student must study Priority 1 before Priority 2.
6. "recommendedBooks": 1 to 2 standard textbooks with author, publication context, and searchUrl.

Output JSON structure:
{
  "estimatedTotalSteps": 5,
  "recommendedBooks": [
    {
      "title": "...",
      "author": "...",
      "whyRead": "...",
      "searchUrl": "https://openlibrary.org/search?q=..."
    }
  ],
  "step1": {
    "title": "...",
    "difficulty": "Beginner",
    "whatYouWillLearn": "...",
    "coreKeyTakeaways": ["...", "...", "..."],
    "practicalApplication": "...",
    "estimatedMinutes": 45,
    "passingScore": 80,
    "questionCount": 5,
    "resources": [
      {
        "priority": 1,
        "badge": "START HERE",
        "title": "...",
        "url": "...",
        "type": "video",
        "whyThisFirst": "..."
      }
    ]
  }
}`;

    const data = await generateWithGemini(prompt, keyInfo.apiKey);
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

  // Non-Gemini providers (Groq, OpenRouter, OpenAI, Anthropic)
  let searchPromptContext = '';
  try {
    const tavilyKeyInfo = await getProviderKey('tavily');
    if (tavilyKeyInfo.apiKey) {
      const tavilyResults = await searchWeb(`${title} modern documentation and guide`, tavilyKeyInfo.apiKey);
      if (tavilyResults && tavilyResults.length > 0) {
        searchPromptContext = `\n\nVERIFIED LIVE SOURCES:\n${JSON.stringify(tavilyResults, null, 2)}\nYou MUST construct resources using ONLY these validated URLs or direct YouTube search queries (https://www.youtube.com/results?search_query=...). Never guess deep URLs.`;
      }
    }
  } catch (_) {
    // Graceful fallback if Tavily is missing or fails
  }

  const systemPrompt = `You are SkillPrax, an expert AI pedagogical architect. You establish deep, dynamic, personalized learning paths without rigid templates. Output ONLY valid JSON matching the requested schema.`;

  const userPrompt = `Create a custom mastery learning plan for a user.
Workspace Focus:
- Skill/Technology Title: "${title}"
- Domain/Context: "${category}"
- Baseline Knowledge: "${baselineKnowledge}"
- Target Goal: "${targetGoal}"
${searchPromptContext}

Pedagogical Requirements for Step 1:
1. "whatYouWillLearn": Comprehensive conceptual overview (2-3 detailed paragraphs explaining mental models, core architecture, and prerequisites).
2. "coreKeyTakeaways": Array of 3 to 5 concrete strings (exact mechanisms, terms, syntax rules, or mental models).
3. "practicalApplication": Explanation of how Step 1 directly enables achieving "${targetGoal}".
4. "estimatedMinutes": Realistic integer duration in minutes (e.g. 45).
5. "resources": Array of EXACTLY 1 to 3 prioritized, sequence-ranked learning resources:
   - Priority 1 (badge: "START HERE"): Best foundational video or interactive walkthrough.
   - Priority 2 (badge: "APPLY & PRACTICE"): Authoritative reference manual or official documentation page.
   - Priority 3 (badge: "DEEP DIVE"): Optional item for complex edge cases.
   - Include "whyThisFirst" explaining why student must study Priority 1 before Priority 2.
6. "recommendedBooks": 1 to 2 standard textbooks with author, publication context, and searchUrl.

Output JSON structure:
{
  "estimatedTotalSteps": 5,
  "recommendedBooks": [
    {
      "title": "...",
      "author": "...",
      "whyRead": "...",
      "searchUrl": "https://openlibrary.org/search?q=..."
    }
  ],
  "step1": {
    "title": "...",
    "difficulty": "Beginner",
    "whatYouWillLearn": "...",
    "coreKeyTakeaways": ["...", "...", "..."],
    "practicalApplication": "...",
    "estimatedMinutes": 45,
    "passingScore": 80,
    "questionCount": 5,
    "resources": [
      {
        "priority": 1,
        "badge": "START HERE",
        "title": "...",
        "url": "...",
        "type": "video",
        "whyThisFirst": "..."
      }
    ]
  }
}`;

  const rawJson = await callLLM(provider, systemPrompt, userPrompt);
  const data = parseJsonResponse<any>(rawJson);

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
  const systemPrompt = `You are SkillPrax Quiz Engine. You construct multiple choice evaluation quizzes. Output ONLY valid JSON.`;

  const userPrompt = `Generate a ${questionCount}-question evaluation quiz for:
Step Title: "${stepTitle}"
Difficulty: "${difficulty}"
Overview & Concepts: "${stepObjective}"
${contextPayload ? `Learner Context Payload:\n${contextPayload}` : ''}

Rules:
- Questions must strictly test the concepts in the objective.
- Provide 4 distinct options per question.
- "correctIndex" must be an integer (0, 1, 2, or 3).
- "conceptTested" must name the target concept.

Output JSON format:
{
  "questions": [
    {
      "id": "q1",
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

  if (activeProvider === 'gemini') {
    const prompt = `You are SkillPrax Curriculum Architect with native real-time Google search capabilities. You generate step N+1 with deep pedagogical structure and real verified URLs. Output ONLY valid JSON matching schema.

The learner mastered Step ${workspace.currentStepIndex} in "${workspace.title}".
Baseline: "${workspace.baselineKnowledge}"
Target Goal: "${workspace.targetGoal}"
Generate Step ${nextStepIndex} of total ${workspace.estimatedTotalSteps}.
Context Payload:
${contextPayload}

Output JSON structure:
{
  "step": {
    "stepIndex": ${nextStepIndex},
    "title": "...",
    "difficulty": "${nextStepIndex <= 2 ? 'Intermediate' : nextStepIndex <= 4 ? 'Advanced' : 'Mastery'}",
    "whatYouWillLearn": "Comprehensive 2-3 paragraph overview...",
    "coreKeyTakeaways": ["Takeaway 1", "Takeaway 2", "Takeaway 3"],
    "practicalApplication": "How this connects to target goal...",
    "estimatedMinutes": 45,
    "passingScore": 80,
    "questionCount": 5,
    "resources": [
      {
        "priority": 1,
        "badge": "START HERE",
        "title": "...",
        "url": "...",
        "type": "video",
        "whyThisFirst": "..."
      }
    ]
  }
}`;

    const data = await generateWithGemini(prompt, keyInfo.apiKey);
    if (data?.step?.resources) {
      data.step.resources = normalizeResources(data.step.resources);
    }
    return data;
  }

  // Non-Gemini providers
  let searchPromptContext = '';
  try {
    const tavilyKeyInfo = await getProviderKey('tavily');
    if (tavilyKeyInfo.apiKey) {
      const tavilyResults = await searchWeb(`${workspace.title} modern documentation and guide`, tavilyKeyInfo.apiKey);
      if (tavilyResults && tavilyResults.length > 0) {
        searchPromptContext = `\n\nVERIFIED LIVE SOURCES:\n${JSON.stringify(tavilyResults, null, 2)}\nYou MUST construct resources using ONLY these validated URLs or direct YouTube search queries (https://www.youtube.com/results?search_query=...). Never guess deep URLs.`;
      }
    }
  } catch (_) {}

  const systemPrompt = `You are SkillPrax Curriculum Architect. You generate step N+1 with deep pedagogical structure. Output ONLY valid JSON.`;

  const userPrompt = `The learner mastered Step ${workspace.currentStepIndex} in "${workspace.title}".
Baseline: "${workspace.baselineKnowledge}"
Target Goal: "${workspace.targetGoal}"
Generate Step ${nextStepIndex} of total ${workspace.estimatedTotalSteps}.
Context Payload:
${contextPayload}
${searchPromptContext}

Output JSON structure:
{
  "step": {
    "stepIndex": ${nextStepIndex},
    "title": "...",
    "difficulty": "${nextStepIndex <= 2 ? 'Intermediate' : nextStepIndex <= 4 ? 'Advanced' : 'Mastery'}",
    "whatYouWillLearn": "Comprehensive 2-3 paragraph overview...",
    "coreKeyTakeaways": ["Takeaway 1", "Takeaway 2", "Takeaway 3"],
    "practicalApplication": "How this connects to target goal...",
    "estimatedMinutes": 45,
    "passingScore": 80,
    "questionCount": 5,
    "resources": [
      {
        "priority": 1,
        "badge": "START HERE",
        "title": "...",
        "url": "...",
        "type": "video",
        "whyThisFirst": "..."
      }
    ]
  }
}`;

  const rawJson = await callLLM(provider, systemPrompt, userPrompt);
  const data = parseJsonResponse<{ step: any }>(rawJson);

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
      const results = await searchWeb('React Server Components modern documentation', cleanKey);
      const latencyMs = Date.now() - startTime;
      if (results && results.length > 0) {
        return { ok: true, latencyMs, response: `Tavily Web Search operational. Grounded ${results.length} live verified sources.` };
      }
      return { ok: true, latencyMs, response: 'Tavily Search connected.' };
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
