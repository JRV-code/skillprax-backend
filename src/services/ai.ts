import { getEffectiveKeys } from '../lib/keyManager';
import { callGroqWithFallback } from '../lib/ai/pipeline';
import { SearchResultItem } from './search';

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

// ZERO-HALLUCINATION REMEDIATION CURATOR
export async function synthesizeTargetedRemediationWithTavily(
  stepTitle: string,
  failedItems: { prompt: string; userOption: string; correctOption: string; acuTitle: string }[],
  tavilyResultsPerTopic: Record<string, SearchResultItem[]>
) {
  const { groqKey } = await getEffectiveKeys();
  if (!groqKey) throw new Error('Groq API Key is not configured in /admin or .env');

  // Prepare indexed search items for Groq to choose from
  const topicCandidatesMap: Record<string, any[]> = {};
  for (const [topic, items] of Object.entries(tavilyResultsPerTopic)) {
    topicCandidatesMap[topic] = items.map((item, idx) => ({
      index: idx,
      title: item.title,
      isYouTube: item.url.includes('youtube.com') || item.url.includes('youtu.be'),
      snippet: item.content?.slice(0, 150) || ''
    }));
  }

  const systemPrompt = `You are the SkillPrax Socratic Diagnostic Specialist.
Milestone: "${stepTitle}".
Student Missed Challenges:
${JSON.stringify(failedItems, null, 2)}

Live Web Search Candidates Per Failed Competency:
${JSON.stringify(topicCandidatesMap, null, 2)}

TASK:
1. Formulate the "overallDiagnosis" summarizing the cognitive traps identified.
2. For each failed topic:
   - Provide "misconceptionAnalysis": Explain why the student's reasoning failed based on what they selected.
   - Provide "coreConcept": State the first-principles law, rule, or physical mechanic.
   - Select ONE best document index and ONE best video index from the candidates provided.
   - DO NOT invent or fabricate URLs! Return only the chosen candidate integer indices.

Output strictly valid JSON with this schema:
{
  "overallDiagnosis": "Summary of cognitive blindspots...",
  "weakAreas": [
    {
      "topic": "Name of failed topic",
      "misconceptionAnalysis": "Detailed Socratic breakdown...",
      "coreConcept": "Governing principle...",
      "selectedDocIndex": 0,
      "docTakeaway": "Single sentence takeaway for the document",
      "selectedVideoIndex": 1,
      "videoTakeaway": "Single sentence takeaway for the video"
    }
  ]
}`;

  const response = await callGroqWithFallback(
    [{ role: 'system', content: systemPrompt }],
    { apiKey: groqKey, jsonMode: true, temperature: 0.1 }
  );

  let cleaned = response.content.trim().replace(/^```json\s*/i, '').replace(/\s*```$/, '');
  const parsed = JSON.parse(cleaned || '{"weakAreas":[]}');

  // Map candidate indices directly back to real Tavily URLs
  const finalWeakAreas = (parsed.weakAreas || []).map((wa: any) => {
    const candidates = tavilyResultsPerTopic[wa.topic] || [];
    const docItem = (typeof wa.selectedDocIndex === 'number' && candidates[wa.selectedDocIndex]) || candidates.find(c => !c.url.includes('youtube.com')) || candidates[0];
    const videoItem = (typeof wa.selectedVideoIndex === 'number' && candidates[wa.selectedVideoIndex]) || candidates.find(c => c.url.includes('youtube.com')) || candidates[1] || candidates[0];

    return {
      topic: wa.topic,
      misconceptionAnalysis: wa.misconceptionAnalysis || 'Conceptual confusion identified.',
      coreConcept: wa.coreConcept || 'Review foundational mechanics.',
      resources: {
        docTitle: docItem ? docItem.title : `${wa.topic} Canonical Guide`,
        docUrl: docItem ? docItem.url : 'https://en.wikipedia.org/wiki/Special:Search?search=' + encodeURIComponent(wa.topic),
        videoTitle: videoItem ? videoItem.title : `${wa.topic} Video Breakdown`,
        videoUrl: videoItem ? videoItem.url : 'https://www.youtube.com/results?search_query=' + encodeURIComponent(`${stepTitle} ${wa.topic} tutorial`),
        criticalTakeaway: wa.docTakeaway || 'Targeted study reference.'
      }
    };
  });

  return {
    overallDiagnosis: parsed.overallDiagnosis || 'Targeted remediation required before retesting.',
    weakAreas: finalWeakAreas
  };
}
