import prisma from '../lib/prisma';
import { getEffectiveKeys } from '../lib/keyManager';
import { callGroqWithFallback } from '../lib/ai/pipeline';
import { extractYouTubeVideoId } from './search';
import { generateAthleticFuelingPlan, AthleticFuelingPlan } from './nutritionEngine';

export interface StepPlanItem {
  stepNumber: number;
  title: string;
  description: string;
  requiredPracticeDays: number;
}

export interface DynamicCurriculumResult {
  totalSteps: number;
  roadmapOverview: string;
  steps: StepPlanItem[];
}

export interface QuadrantItem {
  id: string;
  title: string;
  badge: string;
  takeaway: string;
  studyGuidance: string;
  detailPoints?: string[];
}

export interface StepSynthesizedContent {
  stepNumber: number;
  title: string;
  description: string;
  requiredPracticeDays: number;
  videoUrl: string;
  videoId: string;
  documentationMarkdown: string;
  documentationSourceUrl: string;
  documentationQuadrants: QuadrantItem[];
  dailyDietPlan?: AthleticFuelingPlan | null;
  quizQuestions: any[];
}

/**
 * 1. DYNAMIC STEP ESTIMATION
 * Analyzes skill scope, sub-genre, and target mastery level to compute
 * between 4 and 8 progressive pedagogical milestones.
 */
export async function estimateDynamicCurriculum(params: {
  skillName: string;
  subGenre?: string;
  skillCategory?: 'cognitive' | 'physical';
  targetMastery?: string;
  preferredLanguage?: string;
}): Promise<DynamicCurriculumResult> {
  const { groqKey } = await getEffectiveKeys();
  const category = params.skillCategory || 'cognitive';
  const target = params.targetMastery || 'Intermediate';
  const lang = params.preferredLanguage || 'en';

  const systemPrompt = `You are a Principal Curriculum Architect and Pedagogical Engineer.
Analyze this skill: "${params.skillName}", Sub-Genre: "${params.subGenre || 'General'}", Category: "${category}", Target Mastery: "${target}".
Determine the exact number of progressive steps (between 4 and 8) needed to reach mastery.
For physical skills, assign realistic "requiredPracticeDays" (between 2 and 7 days per step). For cognitive skills, assign 1 to 2 days.
Language: Provide titles and descriptions in ${lang === 'hi' ? 'Hindi' : lang === 'fr' ? 'French' : lang === 'es' ? 'Spanish' : lang === 'de' ? 'German' : 'English'}.

Return strictly JSON:
{
  "totalSteps": number,
  "roadmapOverview": "Brief summary",
  "steps": [
    {
      "stepNumber": 1,
      "title": "Title of step",
      "description": "Clear mechanical description",
      "requiredPracticeDays": 3
    }
  ]
}`;

  try {
    const res = await callGroqWithFallback(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Synthesize the structured curriculum steps for ${params.skillName} now.` },
      ],
      { apiKey: groqKey || '', temperature: 0.2, jsonMode: true }
    );

    const parsed = JSON.parse(res.content);
    const steps: StepPlanItem[] = (parsed.steps || []).map((s: any, idx: number) => ({
      stepNumber: Number(s.stepNumber) || idx + 1,
      title: s.title || `Milestone ${idx + 1}`,
      description: s.description || 'Master core foundational mechanics.',
      requiredPracticeDays: category === 'physical' ? Math.max(2, Math.min(7, Number(s.requiredPracticeDays) || 3)) : 1,
    }));

    const totalSteps = Math.max(4, Math.min(8, Number(parsed.totalSteps) || steps.length || 5));
    return {
      totalSteps,
      roadmapOverview: parsed.roadmapOverview || `Mastery trajectory for ${params.skillName}`,
      steps: steps.slice(0, totalSteps),
    };
  } catch (err) {
    console.warn('[aiOrchestrator] Dynamic step estimation fallback triggered:', err);
    return getFallbackSteps(params.skillName, params.subGenre, category);
  }
}

/**
 * 2. TAVILY RESEARCHER (STAGE 1)
 * Queries Tavily for fresh authoritative tutorials, coaching breakdowns, and videos.
 */
async function queryTavilyResearcher(
  query: string,
  tavilyKey?: string
): Promise<{ textSnippets: string[]; sourceUrls: string[]; youtubeUrls: string[] }> {
  if (!tavilyKey) {
    return { textSnippets: [], sourceUrls: [], youtubeUrls: [] };
  }

  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: tavilyKey,
        query: `${query} tutorial breakdown guide 2026`,
        search_depth: 'advanced',
        max_results: 8,
      }),
    });

    if (res.ok) {
      const data: any = await res.json();
      const results: any[] = data.results || [];
      const textSnippets: string[] = [];
      const sourceUrls: string[] = [];
      const youtubeUrls: string[] = [];

      for (const r of results) {
        if (r.content) textSnippets.push(`[${r.title || 'Source'}]: ${r.content}`);
        if (r.url) {
          sourceUrls.push(r.url);
          if (r.url.includes('youtube.com') || r.url.includes('youtu.be')) {
            youtubeUrls.push(r.url);
          }
        }
      }

      return { textSnippets, sourceUrls, youtubeUrls };
    }
  } catch (err) {
    console.warn('[aiOrchestrator] Tavily research query failed (non-blocking):', err);
  }

  return { textSnippets: [], sourceUrls: [], youtubeUrls: [] };
}

/**
 * 3. ANTI-REPETITION VAULT ENFORCEMENT
 */
export async function getExcludedUserResources(userId?: string): Promise<{
  excludedVideoIds: Set<string>;
  excludedUrls: Set<string>;
}> {
  const excludedVideoIds = new Set<string>();
  const excludedUrls = new Set<string>();

  if (!userId) return { excludedVideoIds, excludedUrls };

  try {
    const historyRows = await prisma.userResourceHistory.findMany({
      where: { userId },
      select: { resourceType: true, resourceIdentifier: true },
    });

    for (const row of historyRows) {
      if (row.resourceType === 'video_id') {
        excludedVideoIds.add(row.resourceIdentifier);
      } else if (row.resourceType === 'doc_url') {
        excludedUrls.add(row.resourceIdentifier);
      }
    }
  } catch (err) {
    console.warn('[aiOrchestrator] User resource history lookup notice:', err);
  }

  return { excludedVideoIds, excludedUrls };
}

export async function recordUserResourceHistory(
  userId: string | undefined,
  type: 'video_id' | 'doc_url' | 'quiz_question_hash',
  identifier: string
) {
  if (!userId || !identifier) return;
  try {
    await prisma.userResourceHistory.upsert({
      where: {
        userId_resourceType_resourceIdentifier: {
          userId,
          resourceType: type,
          resourceIdentifier: identifier,
        },
      },
      update: {},
      create: {
        userId,
        resourceType: type,
        resourceIdentifier: identifier,
      },
    });
  } catch (err) {
    // Non-blocking duplicate write suppression
  }
}

/**
 * 4. SYNTHESIZER & ARCHITECT (STAGE 2)
 * Synthesizes deep structured markdown documentation, 4-quadrant cards,
 * non-repeating video recommendations, and custom Socratic questions.
 */
export async function researchAndSynthesizeStepContent(params: {
  userId?: string;
  skillName: string;
  subGenre?: string;
  skillCategory?: 'cognitive' | 'physical';
  stepNumber: number;
  stepTitle: string;
  stepDescription: string;
  requiredPracticeDays?: number;
  dietaryPreference?: string;
  medicalConditions?: string;
  preferredLanguage?: string;
}): Promise<StepSynthesizedContent> {
  const { groqKey, tavilyKey } = await getEffectiveKeys();
  const category = params.skillCategory || 'cognitive';
  const lang = params.preferredLanguage || 'en';

  // 1. Check Anti-Repetition Vault
  const { excludedVideoIds, excludedUrls } = await getExcludedUserResources(params.userId);

  // 2. Query Tavily Researcher
  const searchQuery = `${params.skillName} ${params.subGenre || ''} ${params.stepTitle} authoritative documentation breakdown mechanics tutorial`;
  const researchData = await queryTavilyResearcher(searchQuery, tavilyKey || undefined);

  // Select video candidate from researchData or curated fallback
  let selectedVideoId = '';
  let selectedVideoUrl = '';

  for (const yUrl of researchData.youtubeUrls) {
    const vid = extractYouTubeVideoId(yUrl);
    if (vid && !excludedVideoIds.has(vid)) {
      selectedVideoId = vid;
      selectedVideoUrl = yUrl;
      break;
    }
  }

  // Curated educational video fallback pool if none found
  if (!selectedVideoId) {
    const fallbackVids = getTopicVideoPool(params.skillName, category);
    for (const f of fallbackVids) {
      if (!excludedVideoIds.has(f.id)) {
        selectedVideoId = f.id;
        selectedVideoUrl = `https://www.youtube.com/watch?v=${f.id}`;
        break;
      }
    }
    if (!selectedVideoId) {
      selectedVideoId = fallbackVids[0].id;
      selectedVideoUrl = `https://www.youtube.com/watch?v=${selectedVideoId}`;
    }
  }

  // Select doc source URL
  let selectedDocUrl = researchData.sourceUrls.find((u) => !u.includes('youtube') && !excludedUrls.has(u)) ||
    `https://en.wikipedia.org/wiki/${encodeURIComponent(params.skillName)}`;

  // 3. Groq Synthesis Prompt
  const systemPrompt = `You are a Principal Pedagogical Synthesizer & Educational Curriculum Architect.
Target Skill: "${params.skillName}"
Sub-Genre: "${params.subGenre || 'Foundations'}"
Step ${params.stepNumber}: "${params.stepTitle}" - ${params.stepDescription}
Category: "${category}"
Language: Generate all output natively in ${lang === 'hi' ? 'Hindi' : lang === 'fr' ? 'French' : lang === 'es' ? 'Spanish' : lang === 'de' ? 'German' : 'English'}.

Research Context:
${researchData.textSnippets.slice(0, 5).join('\n\n')}

STRICT DIRECTIVES:
1. DO NOT provide a brief 3-sentence summary.
2. Structure comprehensive, deep educational Markdown documentation:
   # ${params.stepTitle} & Architectural Overview
   ## Core Theoretical Principles
   ## Step-by-Step Execution Mechanics (Detailed breakdown with bullet points)
   ## Edge Cases, Common Errors & Diagnostic Checkpoints
   ## Real-World Implementation & Practice Protocols
3. Extract 4 Quadrants for fast synthesis:
   - Quadrant 1: Core Principle in 60s
   - Quadrant 2: Key Mechanics & Execution
   - Quadrant 3: Traps & Misconceptions
   - Quadrant 4: Verified Reference Grounding
4. Formulate 3 conceptual Socratic Quiz Questions. Each question must have:
   - id, scenario, question, 4 options (A, B, C, D), correctOptionId, and distractorExplanations.

Return strictly JSON format:
{
  "documentationMarkdown": "Full Markdown string...",
  "quadrants": [
    {
      "id": "q1",
      "title": "Core Principle in 60s",
      "badge": "First Principles",
      "takeaway": "Short summary",
      "studyGuidance": "Actionable insight",
      "detailPoints": ["Point 1", "Point 2", "Point 3"]
    },
    {
      "id": "q2",
      "title": "Key Mechanics & Execution",
      "badge": "Mechanics",
      "takeaway": "...",
      "studyGuidance": "...",
      "detailPoints": ["..."]
    },
    {
      "id": "q3",
      "title": "Traps & Misconceptions",
      "badge": "Diagnostic Warnings",
      "takeaway": "...",
      "studyGuidance": "...",
      "detailPoints": ["..."]
    },
    {
      "id": "q4",
      "title": "Verified Reference Grounding",
      "badge": "Grounding",
      "takeaway": "...",
      "studyGuidance": "...",
      "detailPoints": ["..."]
    }
  ],
  "quizQuestions": [
    {
      "id": "q_1",
      "scenario": "A practical scenario...",
      "question": "Diagnostic question text...",
      "options": [
        { "id": "A", "text": "Option A" },
        { "id": "B", "text": "Option B" },
        { "id": "C", "text": "Option C" },
        { "id": "D", "text": "Option D" }
      ],
      "correctOptionId": "A",
      "distractorExplanations": {
        "A": "Why correct",
        "B": "Why flawed",
        "C": "Why flawed",
        "D": "Why flawed"
      }
    }
  ]
}`;

  let documentationMarkdown = '';
  let documentationQuadrants: QuadrantItem[] = [];
  let quizQuestions: any[] = [];

  try {
    const res = await callGroqWithFallback(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Generate the complete pedagogical synthesis for Step ${params.stepNumber}: ${params.stepTitle}.` },
      ],
      { apiKey: groqKey || '', temperature: 0.25, jsonMode: true }
    );

    const parsed = JSON.parse(res.content);
    documentationMarkdown = parsed.documentationMarkdown || generateFallbackMarkdown(params.stepTitle, params.skillName);
    documentationQuadrants = parsed.quadrants || getFallbackQuadrants(params.stepTitle);
    quizQuestions = parsed.quizQuestions || getFallbackQuizQuestions(params.stepTitle);
  } catch (err) {
    console.warn('[aiOrchestrator] Groq synthesis fallback triggered:', err);
    documentationMarkdown = generateFallbackMarkdown(params.stepTitle, params.skillName);
    documentationQuadrants = getFallbackQuadrants(params.stepTitle);
    quizQuestions = getFallbackQuizQuestions(params.stepTitle);
  }

  // 4. Generate daily athletic fueling plan if physical
  let dailyDietPlan: AthleticFuelingPlan | null = null;
  if (category === 'physical') {
    dailyDietPlan = await generateAthleticFuelingPlan({
      sportName: params.skillName,
      subGenre: params.subGenre,
      dietaryPreference: params.dietaryPreference || 'Vegetarian',
      medicalConditions: params.medicalConditions || 'None',
      preferredLanguage: lang,
    });
  }

  // 5. Record IDs in Anti-Repetition Vault
  if (params.userId) {
    await recordUserResourceHistory(params.userId, 'video_id', selectedVideoId);
    await recordUserResourceHistory(params.userId, 'doc_url', selectedDocUrl);
  }

  return {
    stepNumber: params.stepNumber,
    title: params.stepTitle,
    description: params.stepDescription,
    requiredPracticeDays: params.requiredPracticeDays || (category === 'physical' ? 3 : 1),
    videoUrl: selectedVideoUrl,
    videoId: selectedVideoId,
    documentationMarkdown,
    documentationSourceUrl: selectedDocUrl,
    documentationQuadrants,
    dailyDietPlan,
    quizQuestions,
  };
}

// Helpers & Fallbacks
function getTopicVideoPool(skillName: string, category: string): { id: string; title: string }[] {
  const lower = skillName.toLowerCase();
  if (lower.includes('cricket')) {
    return [
      { id: '3JZ_D3ELwOQ', title: 'Cricket Fast Bowling Biomechanics' },
      { id: 'bM7SZ5SBzyY', title: 'Wrist Position and Seam Alignment' },
      { id: 'dQw4w9WgXcQ', title: 'Run Up Rhythm and Deceleration' },
    ];
  }
  if (lower.includes('football') || lower.includes('soccer')) {
    return [
      { id: '4r7wHMg5Yjg', title: 'Ball Mastery & Cone Agility' },
      { id: '7wtfhZwyrcc', title: 'Body Feints and First Touch Precision' },
      { id: 'kXYiU_JCYtU', title: 'Shooting Technique and Weight Transfer' },
    ];
  }
  if (category === 'physical') {
    return [
      { id: '4r7wHMg5Yjg', title: 'Athletic Conditioning & Agility' },
      { id: '3JZ_D3ELwOQ', title: 'Biomechanical Movement Efficiency' },
    ];
  }
  return [
    { id: 'dQw4w9WgXcQ', title: 'Deep Technical Architecture Tutorial' },
    { id: 'bM7SZ5SBzyY', title: 'Core Principles & Clean Implementation' },
  ];
}

function getFallbackSteps(skillName: string, subGenre: string | undefined, category: string): DynamicCurriculumResult {
  const isPhysical = category === 'physical';
  return {
    totalSteps: 5,
    roadmapOverview: `Foundational mastery pathway for ${skillName}${subGenre ? ` (${subGenre})` : ''}`,
    steps: [
      {
        stepNumber: 1,
        title: 'Core Biomechanical Principles & Stance',
        description: 'Establish balance, center of gravity, and baseline execution form.',
        requiredPracticeDays: isPhysical ? 3 : 1,
      },
      {
        stepNumber: 2,
        title: 'Fundamental Kinetic Sequence & Pacing',
        description: 'Coordinate movement chains and eliminate energy leaks in execution.',
        requiredPracticeDays: isPhysical ? 4 : 1,
      },
      {
        stepNumber: 3,
        title: 'Precision Targeting & Error Correction',
        description: 'Diagnostic adjustments for consistency and pressure resistance.',
        requiredPracticeDays: isPhysical ? 3 : 1,
      },
      {
        stepNumber: 4,
        title: 'Dynamic Situational Drills & Variations',
        description: 'Simulate competitive conditions and rapid adaptive responses.',
        requiredPracticeDays: isPhysical ? 5 : 1,
      },
      {
        stepNumber: 5,
        title: 'Mastery Integration & Peak Clearance',
        description: 'High-speed execution, tactical mastery, and autonomous flow.',
        requiredPracticeDays: isPhysical ? 4 : 1,
      },
    ],
  };
}

function generateFallbackMarkdown(stepTitle: string, skillName: string): string {
  return `# ${stepTitle} & Architectural Overview

## Core Theoretical Principles
Mastering **${stepTitle}** forms a foundational pillar in achieving true proficiency within **${skillName}**. By dissecting the underlying physics and conceptual architecture, learners build an intuitive model of execution.

- **First Principles Grounding**: Every high-level technique derives from energy conservation and kinetic alignment.
- **Cognitive Load Optimization**: Break complex multi-stage tasks into isolated deliberate practice units.

## Step-by-Step Execution Mechanics
1. **Initial Alignment & Stance**: Ground your base firmly. Ensure balanced weight distribution.
2. **Kinetic Initiation**: Initiate motion from primary power sources before transferring force outward.
3. **Controlled Follow-Through**: Complete the full trajectory without premature deceleration.

## Edge Cases, Common Errors & Diagnostic Checkpoints
- **Trap 1: Rushing the Preparation Phase**: Leads to off-target trajectories and wasted force.
- **Trap 2: Muscular Tension Overload**: Fluidity generates more velocity and consistency than rigid strain.
- **Diagnostic Cue**: If fatigue sets in within 10 minutes, verify that your core posture is absorbing the workload.

## Real-World Implementation & Practice Protocols
- Complete dedicated 15-minute deliberate practice intervals daily.
- Review progress against verified benchmark recordings after each set.`;
}

function getFallbackQuadrants(stepTitle: string): QuadrantItem[] {
  return [
    {
      id: 'q1',
      title: 'Core Principle in 60s',
      badge: 'First Principles',
      takeaway: 'Kinetic balance and energy efficiency govern consistent execution.',
      studyGuidance: 'Focus on balance before accelerating velocity.',
      detailPoints: ['Balanced center of gravity', 'Zero unnecessary tension', 'Repeatable biomechanical sequence'],
    },
    {
      id: 'q2',
      title: 'Key Mechanics & Execution',
      badge: 'Mechanics',
      takeaway: 'Three-stage kinetic sequence: preparation, release/strike, and deceleration.',
      studyGuidance: 'Execute each rep at 70% speed before increasing power.',
      detailPoints: ['Stance alignment', 'Fluid energy transfer', 'Full follow-through path'],
    },
    {
      id: 'q3',
      title: 'Traps & Misconceptions',
      badge: 'Diagnostic Warnings',
      takeaway: 'Over-gripping and jerky acceleration reduce accuracy by over 40%.',
      studyGuidance: 'Stay loose and breathe rhythmically through the motion.',
      detailPoints: ['Avoid stiff joints', 'Never compromise posture for power', 'Track consistency metrics'],
    },
    {
      id: 'q4',
      title: 'Verified Reference Grounding',
      badge: 'Grounding',
      takeaway: 'Validated against official coaching handbooks and kinematic studies.',
      studyGuidance: 'Compare your practice footage against canonical form demonstrations.',
      detailPoints: ['Biomechanical motion capture evidence', 'Mastery benchmark standards', 'Progressive overload cadence'],
    },
  ];
}

function getFallbackQuizQuestions(stepTitle: string): any[] {
  return [
    {
      id: 'q_1',
      scenario: 'During practice, a learner attempts to maximize output but immediately experiences loss of control and fatigue.',
      question: 'Which mechanical adjustment will restore accuracy and energy efficiency?',
      options: [
        { id: 'A', text: 'Reduce muscular tension and focus on smooth kinetic sequencing from the core.' },
        { id: 'B', text: 'Double physical effort and grip the implement with maximum force.' },
        { id: 'C', text: 'Eliminate the preparation phase and snap the wrist immediately.' },
        { id: 'D', text: 'Skip follow-through deceleration to save energy.' },
      ],
      correctOptionId: 'A',
      distractorExplanations: {
        A: 'Correct: Fluid sequencing generates higher velocity with lower fatigue.',
        B: 'Incorrect: Extreme tension creates rigid resistance and reduces joint freedom.',
        C: 'Incorrect: Bypassing preparation destroys trajectory consistency.',
        D: 'Incorrect: Incomplete follow-through leads to repetitive strain injury.',
      },
    },
  ];
}
