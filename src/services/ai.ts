import { getEffectiveKeys } from '../lib/keyManager';
import { callGroqWithFallback } from '../lib/ai/pipeline';

export interface ACUInput {
  id: string;
  title?: string;
  label?: string;
  description: string;
}

export interface ResourceInput {
  type?: string;
  badge?: string;
  title: string;
  takeaway?: string;
  studyGuidance?: string;
}

export async function generateSocraticQuiz(
  stepTitle: string,
  stepIndex: number,
  totalSteps: number,
  acus: ACUInput[],
  resources: ResourceInput[],
  options: { retestMode?: boolean; priorityAcus?: string[] } = {}
) {
  const { groqKey } = await getEffectiveKeys();
  if (!groqKey) {
    throw new Error('Groq API Key is not configured. Add it in /admin or .env');
  }

  const isRetest = !!options.retestMode;
  const focusAreas = options.priorityAcus || [];

  // Format the curated curriculum that the student actually studied
  const resourceContext = resources && resources.length > 0
    ? resources.map(r => `• [${r.badge || r.type || 'Resource'}] "${r.title}": ${r.studyGuidance || r.takeaway || 'Assigned study material'}`).join('\n')
    : 'Foundational first-principles for this domain.';

  const systemPrompt = `You are the SkillPrax Socratic Evaluation Architect.
Milestone: "Step ${stepIndex} of ${totalSteps} - ${stepTitle}".

ASSIGNED STUDY CURRICULUM (Researched via Tavily & Curated for this Step):
${resourceContext}

ASSESSABLE COMPETENCY UNITS (ACUs to Test):
${acus.map(a => `- [ID: ${a.id}] ${a.title || a.label || 'ACU'}: ${a.description}`).join('\n')}

Retest Mode: ${isRetest ? `ACTIVE (Weight 70% of questions toward: ${focusAreas.join(', ')})` : 'STANDARD'}.

CRITICAL GROUNDING DIRECTIVE:
1. Every scenario question MUST directly assess concepts, principles, takeaways, or failure modes covered in the ASSIGNED STUDY CURRICULUM above.
2. Do NOT generate questions on external, unassigned trivia.
3. Obey the Equal Length Rule: All 4 choices (A, B, C, D) must have matching sentence length and complexity (within ±10%).
4. Exactly one choice has "isCorrect": true. Provide 1-sentence Socratic feedback for each choice.

Output strictly valid JSON with no markdown syntax:
{
  "questions": [
    {
      "prompt": "Scenario challenge grounded in the assigned resources...",
      "acuId": "${acus[0]?.id || 'acu-1'}",
      "options": [
        { "text": "Balanced length option A", "isCorrect": true, "feedback": "First-principles verification." },
        { "text": "Balanced length option B", "isCorrect": false, "feedback": "Misconception trap explanation." },
        { "text": "Balanced length option C", "isCorrect": false, "feedback": "Misconception trap explanation." },
        { "text": "Balanced length option D", "isCorrect": false, "feedback": "Misconception trap explanation." }
      ]
    }
  ]
}`;

  const response = await callGroqWithFallback(
    [{ role: 'system', content: systemPrompt }],
    { apiKey: groqKey, jsonMode: true, temperature: 0.25 }
  );

  let cleaned = response.content.trim();
  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.replace(/^```json\s*/i, '').replace(/\s*```$/, '');
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```\s*/, '').replace(/\s*```$/, '');
  }

  return JSON.parse(cleaned || '{"questions":[]}');
}
