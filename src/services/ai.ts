import { getEffectiveKeys } from '../lib/keyManager';
import { callGroqWithFallback } from '../lib/ai/pipeline';
import { SearchResultItem, extractYouTubeVideoId } from './search';

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
  url?: string;
}

export interface RoadmapGenerationParams {
  title: string;
  domain: string;
  subGenre?: string;
  profession?: string;
  age?: number;
  targetGoal?: string;
  level?: string;
}

/**
 * SKILL-TRACK Pedagogy & Curriculum Engine (v2.6)
 * Dynamically sizes curriculum roadmap between 3 and 8 sequential milestones
 * based on skill scope, sub-genre, and learner profile.
 */
export async function generateSkillRoadmap(params: {
  title: string;
  domain: string;
  subGenre?: string;
  profession?: string;
  age?: number;
  targetGoal?: string;
  level?: string;
}) {
  const { groqKey } = await getEffectiveKeys();
  if (!groqKey) {
    throw new Error('Groq API Key is not configured in /admin or .env');
  }

  const cleanTitle = (params.title || '').trim();
  const cleanDomain = (params.domain || 'General Knowledge').trim();
  const cleanSubGenre = (params.subGenre || '').trim();
  const learnerContext = `${params.profession || 'Learner'}${params.age ? ` (Age ${params.age})` : ''}`;

  const systemPrompt = `You are the SKILL-TRACK Pedagogy & Curriculum Engine (v2.6).
Domain: "${cleanDomain}"
Target Skill: "${cleanTitle}"
${cleanSubGenre ? `Specialized Sub-Genre: "${cleanSubGenre}"` : ''}
Learner Context: "${learnerContext}"
Mastery Goal: "${params.targetGoal || 'Full Competency'}"

TASK:
Synthesize an authoritative, highly structured, sequential mastery roadmap for this skill.

CRITICAL DYNAMIC SIZING DIRECTIVE (3 to 8 Milestones):
- DYNAMICALLY SCOPE ROADMAP DEPTH BETWEEN 3 AND 8 MILESTONES based on the technical scope and complexity:
  * Highly focused drills or niche skills: 3 to 4 milestones.
  * Intermediate applied mechanics: 4 to 6 milestones.
  * Deep multi-layered disciplines (e.g. Organic Chemistry, Distributed Systems): 6 to 8 milestones.
- DO NOT default to a rigid 5 steps. Evaluate the exact scope of "${cleanTitle}${cleanSubGenre ? ` (${cleanSubGenre})` : ''}".
- Each milestone MUST have a distinct, progressive title reflecting increasing rigor:
  * Milestone 1: Foundational Mental Models & Core Principles
  * Intermediate Milestones: Applied Mechanics, Execution & Non-linear Edge Cases
  * Final Milestone: Advanced Synthesis & Apex Mastery Clearance.
- Each milestone MUST contain 2 to 4 granular Assessable Competency Units (ACUs).

Output strictly valid JSON with NO markdown syntax:
{
  "title": "${cleanTitle}",
  "subTitle": "Authoritative subtitle summarizing the specialization",
  "domainCategory": "${cleanDomain}",
  "subGenre": "${cleanSubGenre}",
  "totalPlannedSteps": 5,
  "steps": [
    {
      "stepIndex": 1,
      "title": "Unique Foundational Milestone Title",
      "description": "Clear explanation of what the learner will build or verify",
      "acus": [
        { "id": "acu-1-1", "title": "Competency Unit Name", "description": "Specific measurable skill tested" },
        { "id": "acu-1-2", "title": "Competency Unit Name", "description": "Specific measurable skill tested" }
      ]
    }
  ]
}`;

  const response = await callGroqWithFallback(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Generate dynamic curriculum for "${cleanTitle}" with sub-genre "${cleanSubGenre}".` }
    ],
    { apiKey: groqKey, jsonMode: true, temperature: 0.3 }
  );

  let cleaned = response.content.trim().replace(/^```json\s*/i, '').replace(/\s*```$/, '');
  const parsed = JSON.parse(cleaned);

  // Guarantee step count is clamped between 3 and 8
  const steps = Array.isArray(parsed.steps) ? parsed.steps : [];
  const clampedSteps = steps.slice(0, 8);
  if (clampedSteps.length < 3) {
    // Add baseline steps if model returned fewer than 3
    while (clampedSteps.length < 3) {
      const idx = clampedSteps.length + 1;
      clampedSteps.push({
        stepIndex: idx,
        title: `Milestone ${idx}: Applied Synthesis`,
        description: `Deepen practical execution for ${cleanTitle}.`,
        acus: [
          { id: `acu-${idx}-1`, title: 'Core Execution Competency', description: 'Practical implementation under scenario constraints' }
        ]
      });
    }
  }

  return {
    title: parsed.title || cleanTitle,
    subTitle: parsed.subTitle || `${cleanSubGenre ? `${cleanSubGenre} ` : ''}Mastery Track`,
    domainCategory: parsed.domainCategory || cleanDomain,
    subGenre: cleanSubGenre || null,
    totalPlannedSteps: clampedSteps.length,
    steps: clampedSteps.map((s: any, idx: number) => ({
      ...s,
      stepIndex: idx + 1
    }))
  };
}

/**
 * SKILL-TRACK Socratic Evaluation Generator (8 to 12 Questions, Equal Length Rule)
 */
export async function generateSocraticQuiz(
  stepTitle: string,
  stepIndex: number,
  totalSteps: number,
  acus: ACUInput[],
  resources: ResourceInput[],
  options: { retestMode?: boolean; priorityAcus?: string[]; perfectionMode?: boolean; failedQuestionIds?: string[] } = {}
) {
  const { groqKey } = await getEffectiveKeys();
  if (!groqKey) {
    throw new Error('Groq API Key is not configured. Add it in /admin or .env');
  }

  const isRetest = !!options.retestMode;
  const isPerfection = !!options.perfectionMode;
  const focusAreas = options.priorityAcus || [];

  // Scale question count to 8 to 12 scenario-grounded questions (or 2-4 if perfection mode)
  const questionCount = isPerfection ? Math.min(4, Math.max(2, focusAreas.length || 3)) : Math.min(12, Math.max(8, Math.round((acus.length * 2.5) || 8)));

  // Format the curated curriculum that the student actually studied
  const resourceContext = resources && resources.length > 0
    ? resources.map(r => `• [${r.badge || r.type || 'Resource'}] "${r.title}": ${r.studyGuidance || r.takeaway || 'Assigned study material'}`).join('\n')
    : 'Foundational first-principles for this domain.';

  const systemPrompt = `You are the SKILL-TRACK Pedagogy & Curriculum Engine (v2.6) Socratic Evaluation Architect.
Milestone: "Step ${stepIndex} of ${totalSteps} - ${stepTitle}".
Mode: ${isPerfection ? 'TARGETED PERFECTION DRILL (Exclusively testing missed misconceptions for 100% mastery)' : isRetest ? 'ADAPTIVE RETEST (70% weighted toward prior failed concepts)' : 'STANDARD SOCRATIC EVALUATION'}.

ASSIGNED STUDY CURRICULUM (Researched via Tavily & Curated for this Step):
${resourceContext}

ASSESSABLE COMPETENCY UNITS (ACUs to Test):
${acus.map(a => `- [ID: ${a.id}] ${a.title || a.label || 'ACU'}: ${a.description}`).join('\n')}

${isPerfection ? `FOCUS MISCONCEPTIONS: ${JSON.stringify(focusAreas)}` : ''}

CRITICAL GROUNDING DIRECTIVES:
1. Generate EXACTLY ${questionCount} scenario-grounded questions.
2. Every scenario challenge MUST directly assess concepts, mechanics, takeaways, or edge cases from the ASSIGNED STUDY CURRICULUM above and the ACUs.
3. EQUAL LENGTH RULE (MANDATORY): All 4 choices (A, B, C, D) for EVERY question MUST have strictly comparable sentence length and character counts (within ±10%). The correct answer must NOT be conspicuously longer or more detailed than the distractors.
4. Distribute the correct answer evenly across options (A, B, C, D).
5. For EVERY option, include a 1-sentence diagnostic explanation ("feedback") explaining why it is correct or what specific misconception trap it represents.

Output strictly valid JSON with no markdown syntax:
{
  "questions": [
    {
      "id": "q1",
      "prompt": "Scenario challenge grounded in assigned resources...",
      "acuId": "${acus[0]?.id || 'acu-1'}",
      "options": [
        { "id": "A", "text": "Balanced length option A", "isCorrect": true, "feedback": "First-principles verification." },
        { "id": "B", "text": "Balanced length option B", "isCorrect": false, "feedback": "Misconception trap analysis." },
        { "id": "C", "text": "Balanced length option C", "isCorrect": false, "feedback": "Misconception trap analysis." },
        { "id": "D", "text": "Balanced length option D", "isCorrect": false, "feedback": "Misconception trap analysis." }
      ]
    }
  ]
}`;

  const response = await callGroqWithFallback(
    [{ role: 'system', content: systemPrompt }, { role: 'user', content: `Generate ${questionCount} Socratic questions for ${stepTitle}` }],
    { apiKey: groqKey, jsonMode: true, temperature: 0.3 }
  );

  let cleaned = response.content.trim().replace(/^```json\s*/i, '').replace(/\s*```$/, '');
  const parsed = JSON.parse(cleaned || '{"questions":[]}');
  return parsed;
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
      isYouTube: Boolean(item.videoId || item.url.includes('youtube.com') || item.url.includes('youtu.be')),
      snippet: item.content?.slice(0, 160) || ''
    }));
  }

  const systemPrompt = `You are the SKILL-TRACK Pedagogy & Curriculum Engine (v2.6) Socratic Diagnostic Specialist.
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
   - Select ONE best document candidate index ("selectedDocIndex") and ONE best video candidate index ("selectedVideoIndex").
   - DO NOT invent or fabricate URLs! Return ONLY the candidate integer indices.

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

  // Map candidate indices directly back to real Tavily URLs on the server (zero link rot!)
  const finalWeakAreas = (parsed.weakAreas || []).map((wa: any) => {
    const candidates = tavilyResultsPerTopic[wa.topic] || [];
    const docItem = (typeof wa.selectedDocIndex === 'number' && candidates[wa.selectedDocIndex]) || candidates.find(c => !c.videoId && !c.url.includes('youtube.com')) || candidates[0];
    const videoItem = (typeof wa.selectedVideoIndex === 'number' && candidates[wa.selectedVideoIndex]) || candidates.find(c => c.videoId || c.url.includes('youtube.com')) || candidates[1] || candidates[0];

    const docUrl = docItem ? docItem.url : '';
    const videoId = videoItem ? (videoItem.videoId || extractYouTubeVideoId(videoItem.url)) : null;
    const videoUrl = videoId ? `https://www.youtube.com/watch?v=${videoId}` : (videoItem ? videoItem.url : '');

    return {
      topic: wa.topic,
      misconceptionAnalysis: wa.misconceptionAnalysis || 'Conceptual confusion identified.',
      coreConcept: wa.coreConcept || 'Review foundational mechanics.',
      resources: {
        docTitle: docItem ? docItem.title : `${wa.topic} Canonical Guide`,
        docUrl: docUrl || '#',
        videoTitle: videoItem ? videoItem.title : `${wa.topic} Video Breakdown`,
        videoUrl: videoUrl || '#',
        videoId,
        criticalTakeaway: wa.docTakeaway || 'Targeted study reference.'
      }
    };
  });

  return {
    overallDiagnosis: parsed.overallDiagnosis || 'Targeted remediation required before retesting.',
    weakAreas: finalWeakAreas
  };
}
