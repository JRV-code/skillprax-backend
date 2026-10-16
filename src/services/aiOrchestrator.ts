import prisma from '../lib/prisma';
import { getEffectiveKeys } from '../lib/keyManager';
import { callGroqWithFallback } from '../lib/ai/pipeline';
import { extractYouTubeVideoId } from './search';
import { generateAthleticFuelingPlan, AthleticFuelingPlan } from './nutritionEngine';
import { fetchVerifiedStepVideo } from './videoService';
import { generateStepDocumentationAndQuiz } from './documentationService';
import { calculatePersonalizedStepBounds } from '../config/learning';

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
  documentationQuadrants: any;
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

  const langMap: Record<string, string> = {
    en: 'English',
    hi: 'Hindi',
    gu: 'Gujarati',
    mr: 'Marathi',
    kn: 'Kannada',
    ta: 'Tamil',
    te: 'Telugu',
    fr: 'French',
    es: 'Spanish',
    de: 'German',
  };
  const targetLanguage = langMap[lang] || 'English';

  const { minSteps, maxSteps, recommendedTarget } = calculatePersonalizedStepBounds({
    skillName: params.skillName,
    subGenre: params.subGenre,
    desiredLevel: target,
  });

  const systemPrompt = `You are a Principal Curriculum Architect and Pedagogical Engineer.
Analyze this skill: "${params.skillName}", Sub-Genre: "${params.subGenre || 'General'}", Category: "${category}", Target Mastery: "${target}".
CRITICAL MILESTONE COUNT MANDATE:
You MUST generate EXACTLY ${recommendedTarget} progressive milestones (stepNumber 1 through ${recommendedTarget}) in the "steps" array and set "totalSteps": ${recommendedTarget}.
DO NOT default to 4 steps unless ${recommendedTarget} === 4!

STRICT 100% DOMAIN-AUTHENTIC MILESTONE TITLES MANDATE:
- Every single step title and description MUST explicitly name concrete techniques, concepts, rules, or practical methods specific to "${params.skillName}" (${params.subGenre || 'Core'}).
- NEVER use generic labels like "Foundations", "Elementary Mechanics", "Core Biomechanical Principles", or "Intermediate Fluidity" for cognitive or creative skills like Cooking, Languages, or Arts!
- Step 1 must name the exact starting techniques for ${params.skillName}.
- Intermediate steps must name concrete techniques and problem-solving scenarios for ${params.skillName}.
- The final step must name peak fluency and advanced capstone execution in ${params.skillName}.

For physical skills, assign realistic "requiredPracticeDays" (between 2 and 7 days per step). For cognitive skills, assign 1 to 2 days.
Language: Provide all roadmap overviews, titles, and descriptions strictly in ${targetLanguage}.

Return strictly JSON:
{
  "totalSteps": ${recommendedTarget},
  "roadmapOverview": "Brief summary",
  "steps": [
    {
      "stepNumber": 1,
      "title": "Concrete Title Naming Specific Skill Techniques",
      "description": "Clear mechanical description",
      "requiredPracticeDays": 3
    }
  ]
}`;

  try {
    const res = await callGroqWithFallback(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Synthesize the structured curriculum steps for ${params.skillName} (${params.subGenre || 'Core'}) now.` },
      ],
      { apiKey: groqKey || '', temperature: 0.2, jsonMode: true, maxTokens: 4096 }
    );

    const parsed = JSON.parse(res.content);
    const steps: StepPlanItem[] = (parsed.steps || []).map((s: any, idx: number) => ({
      stepNumber: Number(s.stepNumber) || idx + 1,
      title: s.title || `Milestone ${idx + 1}`,
      description: s.description || 'Master core foundational mechanics.',
      requiredPracticeDays: category === 'physical' ? Math.max(2, Math.min(7, Number(s.requiredPracticeDays) || 3)) : 1,
    }));

    const totalSteps = Math.max(3, Math.min(6, Number(parsed.totalSteps) || steps.length || recommendedTarget));
    return {
      totalSteps,
      roadmapOverview: parsed.roadmapOverview || `Mastery trajectory for ${params.skillName}`,
      steps: steps.slice(0, totalSteps),
    };
  } catch (err) {
    console.warn('[aiOrchestrator] Dynamic step estimation fallback triggered:', err);
    return getFallbackSteps(params.skillName, params.subGenre, category, target);
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

  // 1. Fetch Verified Video via videoService (Anti-duplication, negative swimming filters)
  let videoData: { videoId: string; videoUrl: string };
  try {
    videoData = await fetchVerifiedStepVideo({
      userId: params.userId,
      skillName: params.skillName,
      subGenre: params.subGenre,
      stepNumber: params.stepNumber,
      stepTitle: params.stepTitle,
      skillCategory: category,
    });
  } catch (err: any) {
    throw new Error('Unable to fetch verified step resources. Please verify API keys in .env.');
  }

  const selectedVideoId = videoData.videoId;
  const selectedVideoUrl = videoData.videoUrl;

  // 2. Fetch Verified Documentation & Balanced Quiz via documentationService
  const docData = await generateStepDocumentationAndQuiz({
    userId: params.userId,
    skillName: params.skillName,
    subGenre: params.subGenre,
    skillCategory: category,
    stepNumber: params.stepNumber,
    stepTitle: params.stepTitle,
    stepDescription: params.stepDescription,
    preferredLanguage: lang,
  });

  const selectedDocUrl = docData.sourceUrl;
  const documentationMarkdown = docData.documentationMarkdown;
  const documentationQuadrants = docData.quadrants;
  const quizQuestions = docData.quizQuestions;

  // 3. Generate daily athletic fueling plan if physical
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

  // 4. Record IDs in Anti-Repetition Vault
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

function getFallbackSteps(
  skillName: string,
  subGenre: string | undefined,
  category: string,
  targetMastery?: string
): DynamicCurriculumResult {
  const isPhysical = category === 'physical';
  const isCulinary = /cook|bake|pastry|culinary|food|kitchen|chef/i.test(skillName);
  const isLanguage = /spanish|french|german|japanese|english|italian|language|chinese|mandarin/i.test(skillName);

  const { recommendedTarget } = calculatePersonalizedStepBounds({
    skillName,
    subGenre,
    desiredLevel: targetMastery,
  });

  let pool: Array<{ title: string; description: string; requiredPracticeDays: number }>;

  if (isCulinary) {
    pool = [
      {
        title: 'Core Kitchen Foundations, Knife Skills & Prep Mise en Place',
        description: 'Master chef knife grip, precision slicing, kitchen safety, and prep organization.',
        requiredPracticeDays: 2,
      },
      {
        title: 'Heat Control, Sautéing & Foundational Pan Sauces',
        description: 'Understand thermal conductivity, Maillard browning, and pan deglazing.',
        requiredPracticeDays: 3,
      },
      {
        title: 'Flavor Balancing, Seasoning & Palate Calibration',
        description: 'Balance acid, salt, fat, heat, and sweetness through deliberate tasting.',
        requiredPracticeDays: 3,
      },
      {
        title: 'Multi-Element Meal Timing & Protein Mastery',
        description: 'Internal temperature management, resting protocols, and synchronizing multiple dishes.',
        requiredPracticeDays: 4,
      },
      {
        title: 'Advanced Culinary Techniques & Emulsion Chemistry',
        description: 'Sous-vide, reduction glazes, complex emulsions, and texture contrast.',
        requiredPracticeDays: 4,
      },
      {
        title: 'Creative Recipe Development & Professional Presentation',
        description: 'Independent menu composition, flavor pairing, and artistic plating architecture.',
        requiredPracticeDays: 5,
      },
    ];
  } else if (isLanguage) {
    pool = [
      {
        title: 'Core Phonetics, High-Frequency Vocabulary & Baseline Pronunciation',
        description: 'Phonetic accuracy, foundational survival phrases, and daily core vocabulary.',
        requiredPracticeDays: 2,
      },
      {
        title: 'Sentence Architecture, Present-Tense Verbs & Connectors',
        description: 'Construct complete thoughts, express opinions, and link basic clauses.',
        requiredPracticeDays: 3,
      },
      {
        title: 'Past & Future Narratives (Tense Mastery) & Active Listening',
        description: 'Narrate past experiences, discuss future plans, and train listening comprehension.',
        requiredPracticeDays: 4,
      },
      {
        title: 'Spontaneous Conversational Fluency & Idiomatic Expressions',
        description: 'Rapid question-and-response drills without intermediate native-language translation.',
        requiredPracticeDays: 4,
      },
      {
        title: 'Nuanced Discourse, Complex Subordinate Clauses & Register',
        description: 'Formal vs. informal register, hypothetical reasoning, and nuanced opinions.',
        requiredPracticeDays: 5,
      },
      {
        title: 'Native-Pace Conversational Fluency & Cultural Idioms',
        description: 'Effortless native-cadence discussions, humor, debate, and specialized topics.',
        requiredPracticeDays: 5,
      },
    ];
  } else if (isPhysical) {
    pool = [
      {
        title: `${skillName} Athletic Stance, Balance & Center of Gravity`,
        description: 'Establish balance, center of gravity, and baseline movement mechanics.',
        requiredPracticeDays: 3,
      },
      {
        title: 'Kinetic Sequencing, Energy Transfer & Core Drills',
        description: 'Coordinate movement chains and eliminate energy leaks in execution.',
        requiredPracticeDays: 4,
      },
      {
        title: 'Form Consistency, Pacing & Movement Correction',
        description: 'Diagnostic adjustments for consistency and pressure resistance.',
        requiredPracticeDays: 3,
      },
      {
        title: 'Dynamic Situational Drills & Tactical Variations',
        description: 'Simulate competitive conditions and rapid adaptive responses.',
        requiredPracticeDays: 5,
      },
      {
        title: 'Match-Pace Execution, Agility & Decision Making',
        description: 'Multi-variable scenario navigation and tactical synthesis.',
        requiredPracticeDays: 4,
      },
      {
        title: 'High-Performance Mastery & Autonomous Competitive Flow',
        description: 'High-speed execution, tactical mastery, and autonomous flow.',
        requiredPracticeDays: 4,
      },
    ];
  } else {
    pool = [
      {
        title: `${skillName} Core Principles, Fundamentals & Mental Models`,
        description: `Establish core vocabulary, theoretical models, and fundamental execution in ${skillName}.`,
        requiredPracticeDays: 1,
      },
      {
        title: `Practical Techniques & Standard Workflows in ${skillName}`,
        description: `Hands-on implementation of established patterns and core methodologies.`,
        requiredPracticeDays: 2,
      },
      {
        title: `Real-World Scenarios, Error Detection & Diagnostic Troubleshooting`,
        description: `Identify common mistakes, debug discrepancies, and apply corrective protocols.`,
        requiredPracticeDays: 2,
      },
      {
        title: `Complex Problem Solving & Fluid Execution`,
        description: `Tackle multi-step challenges and integrate multiple techniques seamlessly.`,
        requiredPracticeDays: 3,
      },
      {
        title: `Advanced Nuances, Edge-Case Handling & Optimization`,
        description: `High-complexity applications, performance optimization, and professional standards.`,
        requiredPracticeDays: 3,
      },
      {
        title: `Independent Creative Mastery & Capstone Integration in ${skillName}`,
        description: `Autonomous project execution, creative synthesis, and full milestone clearance.`,
        requiredPracticeDays: 4,
      },
    ];
  }

  const chosen = pool.slice(0, recommendedTarget).map((p, idx) => ({
    stepNumber: idx + 1,
    ...p,
  }));

  return {
    totalSteps: chosen.length,
    roadmapOverview: `Curated mastery pathway for ${skillName}${subGenre ? ` (${subGenre})` : ''}`,
    steps: chosen,
  };
}
