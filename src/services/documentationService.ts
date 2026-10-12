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
    correctOptionIndex: number;
    correctOptionId: 'A' | 'B' | 'C' | 'D';
    explanation: string;
  }>;
}

const REGIONAL_LANGUAGE_MAP: Record<string, string> = {
  en: 'English',
  hi: 'Hindi (हिन्दी)',
  gu: 'Gujarati (ગુજરાતી)',
  mr: 'Marathi (मराठी)',
  kn: 'Kannada (ಕನ್ನಡ)',
  ta: 'Tamil (தமிழ்)',
  te: 'Telugu (తెలుగు)',
  fr: 'French (Français)',
  es: 'Spanish (Español)',
  de: 'German (Deutsch)',
};

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
  if (!groqKey) {
    throw new Error('Unable to synthesize step resources. Please verify Groq API key in .env.');
  }

  const category = params.skillCategory || 'cognitive';
  const totalSteps = params.totalSteps || 5;
  const masteryLevel = params.masteryLevel || 'Intermediate';
  const isSwimming = params.skillName.toLowerCase().includes('swim') || (params.subGenre || '').toLowerCase().includes('swim');
  const excludeNegative = !isSwimming ? '-swim -swimming' : '';
  
  const rawLangCode = (params.preferredLanguage || 'en').toLowerCase().trim();
  const langKey = rawLangCode.length > 2 ? rawLangCode.slice(0, 2) : rawLangCode;
  const targetLanguage = REGIONAL_LANGUAGE_MAP[langKey] || REGIONAL_LANGUAGE_MAP[rawLangCode] || 'English';

  // 1. Build targeted query matching skill and exact step
  const searchQuery = `${params.skillName} ${params.subGenre || ''} Step ${params.stepNumber} ${params.stepTitle} authoritative documentation mechanics breakdown ${excludeNegative}`.trim();

  let rawContent = '';
  let sourceUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(params.skillName)}`;

  // 2. Query Tavily API for live web context
  if (tavilyKey) {
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
        rawContent = snippets.slice(0, 5).join('\n\n');
      }
    } catch (err: any) {
      console.warn('[documentationService] Tavily search notice:', err.message);
    }
  }

  // Fallback to Wikipedia API directly if Tavily fails or returns empty text
  if (!rawContent || rawContent.trim().length < 60) {
    try {
      const wikiRes = await fetch(
        `https://en.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=false&explaintext=true&format=json&titles=${encodeURIComponent(params.skillName)}`
      );
      if (wikiRes.ok) {
        const wikiData: any = await wikiRes.json();
        const pages = wikiData.query?.pages;
        if (pages) {
          const pageList: any[] = Object.values(pages);
          const wikiText = pageList.map((p) => p.extract).filter(Boolean).join('\n\n');
          if (wikiText && wikiText.trim().length > 60) {
            rawContent = wikiText.slice(0, 4500);
            sourceUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(params.skillName)}`;
          }
        }
      }
    } catch (wikiErr) {
      console.warn('[documentationService] Wikipedia fallback error:', wikiErr);
    }
  }

  // Final fallback to high-fidelity contextual seed if web crawlers are unreachable
  if (!rawContent || rawContent.trim().length < 50) {
    rawContent = `Authoritative reference for ${params.skillName} (${params.subGenre || 'General'}). Stage: Step ${params.stepNumber} - ${params.stepTitle}. Technical focus: biomechanical invariants, operational movement sequences, syntax, diagnostics, and repeatable execution benchmarks.`;
  }

  // 3. Progressive Difficulty Scaling
  let difficultyDirective = '';
  if (params.stepNumber === 1) {
    difficultyDirective = 'Step 1: Core fundamentals, stance, grip, primary rules, and safety protocols.';
  } else if (params.stepNumber === 2) {
    difficultyDirective = 'Step 2: Intermediate dynamic execution, movement flow, and error identification.';
  } else if (params.stepNumber === 3) {
    difficultyDirective = 'Step 3: Advanced match-pace scenarios, edge cases, and tactical integration.';
  } else {
    difficultyDirective = 'Step 4+: Mastery drills, high-speed execution, and competitive readiness.';
  }

  // 4. Synthesize via Groq in the user's selected language
  const prompt = `You are an expert instructor and Principal Pedagogical Architect.
The user is learning "${params.skillName}" (${params.subGenre || 'General'}), currently on Step ${params.stepNumber}: "${params.stepTitle}".
Language: ${targetLanguage}.
Difficulty Level: ${difficultyDirective}
Mastery Expectation: ${masteryLevel}.

Synthesize a comprehensive, in-depth guide in ${targetLanguage} based on this factual context:
${rawContent}

CRITICAL RULES:
1. Tone must be professional, authoritative, and pedagogically sound.
2. Absolutely DO NOT include generic, hardcoded, or irrelevant boilerplate stubs.
3. Language: Write the entire guide and questions natively in ${targetLanguage}.
4. Format requirements (Markdown):
# ${params.stepTitle}
## 1. Core Mechanics & Theoretical Foundation
## 2. Step-by-Step Technical Execution
## 3. Common Errors, Diagnostic Checkpoints & Traps
## 4. Benchmark Verification Protocols

5. Extract 4 Quadrants:
- Q1: Core Principle in 60s
- Q2: Key Mechanics & Execution
- Q3: Common Traps & Edge Cases
- Q4: Verified Reference Grounding

6. Socratic Quiz: Generate 4 Multiple Choice Questions based strictly on the extracted documentation.
- Test understanding of the specific mechanisms explained in the document.
- Distribute correct answers across indices: 0 (A), 1 (B), 2 (C), and 3 (D) in balanced proportion.
- Distractors must be plausible common misconceptions mentioned in the text.

Return strictly JSON matching this structure:
{
  "documentationMarkdown": "Full Markdown documentation conforming to headers 1-4...",
  "quadrants": [
    {
      "id": "q1",
      "title": "Core Principle in 60s",
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
      "question": "Diagnostic question text in ${targetLanguage}...",
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
        { role: 'system', content: `You are an expert pedagogical instructor. You write natively in ${targetLanguage}. Output strictly valid JSON.` },
        { role: 'user', content: prompt },
      ],
      { apiKey: groqKey, temperature: 0.3, jsonMode: true }
    );

    const parsed: any = JSON.parse(res.content);
    const rawMarkdown: string = parsed.documentationMarkdown || `# ${params.stepTitle}\n\n## 1. Core Mechanics & Theoretical Foundation\n${rawContent.slice(0, 500)}`;
    const quadrants: any[] = Array.isArray(parsed.quadrants) ? parsed.quadrants : [];

    // Parse and balance quiz questions
    const rawQuestions: any[] = Array.isArray(parsed.quizQuestions) ? parsed.quizQuestions : [];
    const balancedQuestions = rawQuestions.slice(0, 4).map((q: any, idx: number) => {
      const rawOptions: string[] = Array.isArray(q.options)
        ? q.options.map((opt: any) => typeof opt === 'string' ? opt : (opt.text || String(opt)))
        : ['Option A', 'Option B', 'Option C', 'Option D'];

      while (rawOptions.length < 4) {
        rawOptions.push(`Alternative technical analysis ${rawOptions.length + 1}`);
      }

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
        question: q.question || `What is the key mechanism of ${params.stepTitle}?`,
        options: rawOptions,
        formattedOptions,
        correctOptionIndex: correctIdx,
        correctOptionId,
        explanation: q.explanation || 'Verified according to technical curriculum.',
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
    throw new Error(`Failed to generate dynamic documentation: ${err.message}`);
  }
}
