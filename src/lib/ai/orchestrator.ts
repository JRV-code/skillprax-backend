import prisma from '../prisma';

export interface ProviderConfig {
  endpoint: string;
  defaultModel: string;
}

export const SUPPORTED_PROVIDERS: Record<string, ProviderConfig> = {
  groq: {
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    defaultModel: 'llama-3.3-70b-versatile',
  },
  openai: {
    endpoint: 'https://api.openai.com/v1/chat/completions',
    defaultModel: 'gpt-4o',
  },
  anthropic: {
    endpoint: 'https://api.anthropic.com/v1/messages',
    defaultModel: 'claude-3-5-sonnet-latest',
  },
  gemini: {
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent',
    defaultModel: 'gemini-1.5-flash',
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
  const prov = (provider || config?.defaultProvider || 'groq').toLowerCase();

  if (prov === 'groq') {
    apiKey = config?.groqKey || process.env.GROQ_API_KEY || '';
  } else if (prov === 'openai') {
    apiKey = config?.openaiKey || process.env.OPENAI_API_KEY || '';
  } else if (prov === 'anthropic') {
    apiKey = config?.anthropicKey || process.env.ANTHROPIC_API_KEY || '';
  } else if (prov === 'gemini') {
    apiKey = config?.geminiKey || process.env.GEMINI_API_KEY || '';
  }

  const defaultProvider = config?.defaultProvider || 'groq';
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

/**
 * Universal Unified LLM Caller
 */
export async function callLLM(
  provider: string,
  systemPrompt: string,
  userPrompt: string,
  overrideKey?: string
): Promise<string> {
  const targetProvider = (provider || 'groq').toLowerCase();
  const providerInfo = SUPPORTED_PROVIDERS[targetProvider] || SUPPORTED_PROVIDERS.groq;

  let apiKey = overrideKey;
  if (!apiKey) {
    const keyInfo = await getProviderKey(targetProvider);
    apiKey = keyInfo.apiKey;
  }

  if (!apiKey || !apiKey.trim()) {
    throw new Error(`API key for provider '${targetProvider}' is missing. Please configure it in Admin Command Center.`);
  }

  const cleanKey = apiKey.trim();

  if (targetProvider === 'anthropic') {
    const response = await fetch(providerInfo.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': cleanKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: providerInfo.defaultModel,
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
    const endpoint = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent';
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': cleanKey,
      },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [{ text: `${systemPrompt}\n\nUSER REQUEST:\n${userPrompt}` }],
          },
        ],
        generationConfig: { temperature: 0.3 },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      let errorMsg = errText;
      try {
        const errJson = JSON.parse(errText);
        if (errJson.error?.message) {
          errorMsg = errJson.error.message;
        }
      } catch (_) {}
      throw new Error(`Gemini API error (${response.status}): ${errorMsg}`);
    }

    const data: any = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }

  // Groq and OpenAI (OpenAI Chat Completions protocol)
  const response = await fetch(providerInfo.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${cleanKey}`,
    },
    body: JSON.stringify({
      model: providerInfo.defaultModel,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.3,
      response_format: { type: 'json_object' },
    }),
  }).catch(() => {
    return fetch(providerInfo.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cleanKey}`,
      },
      body: JSON.stringify({
        model: providerInfo.defaultModel,
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
    throw new Error(`${targetProvider.toUpperCase()} API error (${response.status}): ${errText}`);
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
      objective: s.objective,
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
  const systemPrompt = `You are SkillPrax, an expert AI curriculum architect. You output ONLY valid JSON matching the requested schema exactly. Do not include markdown ticks or explanation text outside the JSON object.`;

  const userPrompt = `Create a custom mastery learning plan for a user.
Workspace Info:
- Title: "${title}"
- Category: "${category}"
- Baseline Knowledge: "${baselineKnowledge}"
- Target Goal: "${targetGoal}"

Requirements:
1. Recommend 2 to 3 foundational books in "recommendedBooks". Format searchUrl as: "https://www.google.com/search?q=" + title + author URL encoded.
2. Formulate "step1" for this roadmap. Step 1 must have:
   - title
   - difficulty: "Beginner"
   - objective: detailed scope of knowledge
   - passingScore: threshold between 70 and 90 (integer)
   - questionCount: question count between 3 and 6 (integer)
   - resources: array of 3-4 items with title, url, type ("youtube" | "docs" | "reddit" | "article"), summary.
3. Set estimatedTotalSteps (integer, default 5).

Output EXACT JSON structure:
{
  "estimatedTotalSteps": 5,
  "recommendedBooks": [
    {
      "title": "...",
      "author": "...",
      "whyRead": "...",
      "searchUrl": "..."
    }
  ],
  "step1": {
    "title": "...",
    "difficulty": "Beginner",
    "objective": "...",
    "passingScore": 80,
    "questionCount": 4,
    "resources": [
      {
        "title": "...",
        "url": "...",
        "type": "youtube",
        "summary": "..."
      }
    ]
  }
}`;

  const rawJson = await callLLM(provider, systemPrompt, userPrompt);
  return parseJsonResponse<any>(rawJson);
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
Objective: "${stepObjective}"
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
Objective: "${stepObjective}"
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

  const rawJson = await callLLM(provider, systemPrompt, userPrompt);
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
Objective: "${stepObjective}"
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
  const systemPrompt = `You are SkillPrax Curriculum Architect. You generate step N+1 based on completed steps. Output ONLY valid JSON.`;

  const userPrompt = `The learner mastered Step ${workspace.currentStepIndex} in "${workspace.title}".
Baseline: "${workspace.baselineKnowledge}"
Target Goal: "${workspace.targetGoal}"
Generate Step ${nextStepIndex} of total ${workspace.estimatedTotalSteps}.
Context Payload:
${contextPayload}

Output JSON:
{
  "step": {
    "stepIndex": ${nextStepIndex},
    "title": "...",
    "difficulty": "${nextStepIndex <= 2 ? 'Intermediate' : nextStepIndex <= 4 ? 'Advanced' : 'Mastery'}",
    "objective": "...",
    "passingScore": 80,
    "questionCount": 5,
    "resources": [
      {
        "title": "...",
        "url": "...",
        "type": "docs",
        "summary": "..."
      }
    ]
  }
}`;

  const rawJson = await callLLM(provider, systemPrompt, userPrompt);
  return parseJsonResponse<{ step: any }>(rawJson);
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

    if (!apiKey) {
      throw new Error(`API key for provider '${prov}' is missing. Please configure it in Admin Settings.`);
    }

    if (prov === 'gemini') {
      const endpoint = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent';
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [{ text: 'ping' }],
            },
          ],
          generationConfig: {
            maxOutputTokens: 10,
          },
        }),
      });

      const latencyMs = Date.now() - startTime;

      if (!response.ok) {
        const errText = await response.text();
        let errorMsg = errText;
        try {
          const errJson = JSON.parse(errText);
          if (errJson.error?.message) {
            errorMsg = errJson.error.message;
          }
        } catch (_) {}
        return { ok: false, latencyMs, error: `Gemini API error (${response.status}): ${errorMsg}` };
      }

      const data: any = await response.json();
      const replyText = data.candidates?.[0]?.content?.parts?.[0]?.text || 'ok';
      return { ok: true, latencyMs, response: replyText };
    }

    const response = await callLLM(
      prov,
      'You are a connection ping checker. Output JSON: {"status": "ok"}',
      'Ping status test',
      apiKey
    );
    const latencyMs = Date.now() - startTime;
    return { ok: true, latencyMs, response };
  } catch (err: any) {
    const latencyMs = Date.now() - startTime;
    return { ok: false, latencyMs, error: err.message || 'Connection failed' };
  }
}
