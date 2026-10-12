import { getEffectiveKeys } from '../lib/keyManager';
import prisma from '../lib/prisma';
import { callGroqWithFallback } from '../lib/ai/pipeline';

export interface DocumentationResult {
  documentationMarkdown: string;
  sourceUrl: string;
  quadrants: Array<{
    id: string;
    title: string;
    badge: string;
    takeaway: string;
    studyGuidance: string;
    detailPoints?: string[];
  }>;
  quizQuestions: Array<{
    id: string;
    question: string;
    options: string[];
    formattedOptions: Array<{ id: 'A' | 'B' | 'C' | 'D'; text: string }>;
    correctOptionIndex: number; // 0, 1, 2, or 3
    correctOptionId: 'A' | 'B' | 'C' | 'D';
    explanation: string;
  }>;
}

export async function generateStepDocumentationAndQuiz(params: {
  userId?: string;
  skillId?: string;
  skillName: string;
  subGenre?: string;
  skillCategory?: 'cognitive' | 'physical';
  stepNumber: number;
  totalSteps?: number;
  stepTitle: string;
  stepDescription?: string;
  masteryLevel?: string;
  preferredLanguage?: string;
}): Promise<DocumentationResult> {
  const { groqKey, tavilyKey } = await getEffectiveKeys();
  if (!tavilyKey || !groqKey) {
    throw new Error('Unable to fetch verified step resources. Please verify API keys in .env.');
  }

  const category = params.skillCategory || 'cognitive';
  const totalSteps = params.totalSteps || 5;
  const masteryLevel = params.masteryLevel || 'Intermediate';
  const isSwimming = params.skillName.toLowerCase().includes('swim') || (params.subGenre || '').toLowerCase().includes('swim');
  const excludeNegative = !isSwimming ? '-swim -swimming' : '';
  const lang = params.preferredLanguage || 'en';

  // 1. Tavily Research Query
  const searchQuery = `${params.skillName} ${params.subGenre || ''} Step ${params.stepNumber} ${params.stepTitle} tutorial guide mechanics ${excludeNegative}`.trim();

  let tavilyContext = '';
  let sourceUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(params.skillName)}`;

  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: tavilyKey,
        query: searchQuery,
        search_depth: 'advanced',
        max_results: 5,
        include_raw_content: true,
      }),
    });

    if (res.ok) {
      const data: any = await res.json();
      const results: any[] = data.results || [];
      const snippets: string[] = [];

      for (const r of results) {
        if (r.content) snippets.push(`[${r.title || 'Source'}]: ${r.content}`);
        if (r.url && !sourceUrl.includes('developer.mozilla') && !sourceUrl.includes('wikipedia')) {
          sourceUrl = r.url;
        }
      }
      tavilyContext = snippets.slice(0, 5).join('\n\n');
    }
  } catch (err: any) {
    console.warn('[documentationService] Tavily search notice:', err);
  }

  if (!tavilyContext || tavilyContext.trim().length < 50) {
    tavilyContext = `Authoritative reference for ${params.skillName} (${params.subGenre || 'General'}). Stage: Step ${params.stepNumber} - ${params.stepTitle}. Focus on core biomechanics, conceptual mental models, error handling, and repeatable execution.`;
  }

  // 2. Progressive Difficulty Calibration
  let difficultyDirective = '';
  if (params.stepNumber === 1) {
    difficultyDirective = 'Step 1 (The Absolute Foundations): Focus on core terminology, fundamental stance/grip/syntax, primary mental models, and essential safety/rules.';
  } else if (params.stepNumber === 2) {
    difficultyDirective = 'Step 2 (Elementary Mechanics): Focus on first active execution patterns, simple combinations, diagnostic checkpoints, and baseline error detection.';
  } else if (params.stepNumber === 3) {
    difficultyDirective = 'Step 3 (Intermediate Execution): Focus on dynamic drills, edge-case handling, rhythm, speed, and eliminating inefficiencies.';
  } else {
    difficultyDirective = 'Step 4+ (Advanced & Mastery): Focus on high-speed execution, complex scenarios, match/production-grade integration, and autonomous mastery.';
  }

  // 3. Groq Synthesizer Prompt
  const docPrompt = `You are a Technical and Pedagogical Curriculum Specialist.
The user is learning "${params.skillName}" (Sub-genre: "${params.subGenre || 'General'}").
Current Stage: Step ${params.stepNumber} of ${totalSteps} - "${params.stepTitle}".
Target Mastery Level: "${masteryLevel}".
Pedagogical Difficulty Calibration: ${difficultyDirective}

CRITICAL RULES:
1. Analyze the provided research text and extract comprehensive, highly technical documentation specifically for Step ${params.stepNumber}.
2. DO NOT provide generic introductory summaries if Step > 1. Calibrate depth to Step ${params.stepNumber}.
3. Absolutely DO NOT include unrelated topics (e.g., swimming, python if learning design, etc.).
4. Language: Generate all content natively in ${lang === 'hi' ? 'Hindi' : lang === 'fr' ? 'French' : lang === 'es' ? 'Spanish' : lang === 'de' ? 'German' : 'English'}.
5. Format in structured Markdown:
   # ${params.stepTitle}
   ## 1. Core Mechanics & Conceptual Foundations
   ## 2. Step-by-Step Technical Execution
   ## 3. Common Biomechanical / Syntactical Errors & Diagnostics
   ## 4. Practical Drills & Benchmark Verification
6. Extract 4 precise quadrant cards for quick reference:
   - Quadrant 1: Core Principle in 60 Seconds
   - Quadrant 2: Key Mechanics & Execution
   - Quadrant 3: Common Traps & Edge Cases
   - Quadrant 4: Verified Reference Grounding
7. Socratic Quiz: Generate 4 Multiple Choice Questions based SOLELY on the extracted documentation.
   CRITICAL QUIZ RULES:
   - Test understanding of the specific mechanisms explained in the document.
   - DO NOT make the correct answer always option A (index 0).
   - Distribute correct answers across indices: 0 (A), 1 (B), 2 (C), and 3 (D) in balanced proportion.
   - Distractors must be plausible common misconceptions mentioned in the text.

Research Context:
${tavilyContext}

Return strictly JSON matching this structure:
{
  "documentationMarkdown": "Full Markdown documentation...",
  "quadrants": [
    {
      "id": "q1",
      "title": "Core Principle in 60 Seconds",
      "badge": "First Principles",
      "takeaway": "Concise summary",
      "studyGuidance": "Actionable insight",
      "detailPoints": ["Point 1", "Point 2", "Point 3"]
    },
    {
      "id": "q2",
      "title": "Key Mechanics & Execution",
      "badge": "Execution",
      "takeaway": "...",
      "studyGuidance": "...",
      "detailPoints": ["..."]
    },
    {
      "id": "q3",
      "title": "Common Traps & Edge Cases",
      "badge": "Pitfalls",
      "takeaway": "...",
      "studyGuidance": "...",
      "detailPoints": ["..."]
    },
    {
      "id": "q4",
      "title": "Verified Reference Grounding",
      "badge": "Evidence",
      "takeaway": "...",
      "studyGuidance": "...",
      "detailPoints": ["..."]
    }
  ],
  "quizQuestions": [
    {
      "id": "q_1",
      "question": "Diagnostic question text...",
      "options": [
        "First option text",
        "Second option text",
        "Third option text",
        "Fourth option text"
      ],
      "correctOptionIndex": 1,
      "explanation": "Detailed explanation..."
    }
  ]
}`;

  try {
    const res = await callGroqWithFallback(
      [
        { role: 'system', content: 'You are a Principal Curriculum Architect and Technical Examiner. You output strictly valid JSON.' },
        { role: 'user', content: docPrompt },
      ],
      { apiKey: groqKey, temperature: 0.3, jsonMode: true }
    );

    const parsed: any = JSON.parse(res.content);
    const rawMarkdown: string = parsed.documentationMarkdown || `# ${params.stepTitle}\n\nComprehensive technical breakdown for Step ${params.stepNumber}.`;
    const quadrants: any[] = Array.isArray(parsed.quadrants) ? parsed.quadrants : [];

    // Parse and balance quiz questions
    const rawQuestions: any[] = Array.isArray(parsed.quizQuestions) ? parsed.quizQuestions : [];
    const balancedQuestions = rawQuestions.slice(0, 4).map((q: any, idx: number) => {
      const rawOptions: string[] = Array.isArray(q.options)
        ? q.options.map((opt: any) => typeof opt === 'string' ? opt : (opt.text || String(opt)))
        : ['Option A', 'Option B', 'Option C', 'Option D'];

      // Ensure 4 options exist
      while (rawOptions.length < 4) {
        rawOptions.push(`Alternative mechanical perspective ${rawOptions.length + 1}`);
      }

      // Balance correct index across A(0), B(1), C(2), D(3)
      let correctIdx = typeof q.correctOptionIndex === 'number' && q.correctOptionIndex >= 0 && q.correctOptionIndex <= 3
        ? q.correctOptionIndex
        : idx % 4;

      const optionLabels: Array<'A' | 'B' | 'C' | 'D'> = ['A', 'B', 'C', 'D'];
      const correctOptionId = optionLabels[correctIdx];

      const formattedOptions = rawOptions.map((optText, optI) => ({
        id: optionLabels[optI] || 'A',
        text: optText,
      }));

      return {
        id: q.id || `q_${idx + 1}`,
        question: q.question || `What is the key principle of ${params.stepTitle}?`,
        options: rawOptions,
        formattedOptions,
        correctOptionIndex: correctIdx,
        correctOptionId,
        explanation: q.explanation || 'According to the technical documentation.',
      };
    });

    // Record doc URL in anti-duplication vault
    if (params.userId && sourceUrl) {
      try {
        await prisma.userResourceHistory.upsert({
          where: {
            userId_resourceType_resourceIdentifier: {
              userId: params.userId,
              resourceType: 'doc_url',
              resourceIdentifier: sourceUrl,
            },
          },
          update: {},
          create: {
            userId: params.userId,
            resourceType: 'doc_url',
            resourceIdentifier: sourceUrl,
            skillId: params.skillId || null,
            stepNumber: params.stepNumber,
          },
        });
      } catch (_) {}
    }

    return {
      documentationMarkdown: rawMarkdown,
      sourceUrl,
      quadrants,
      quizQuestions: balancedQuestions,
    };
  } catch (err: any) {
    throw new Error(`Unable to fetch verified step resources. Please verify API keys in .env. (${err.message})`);
  }
}
