import prisma from '../lib/prisma';
import { getEffectiveKeys } from '../lib/keyManager';
import { callGroqWithFallback } from '../lib/ai/pipeline';
import { extractYouTubeVideoId } from './search';
import { generateAthleticFuelingPlan, AthleticFuelingPlan } from './nutritionEngine';
import { fetchVerifiedStepVideo } from './videoService';
import { generateStepDocumentationAndQuiz } from './documentationService';

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

  const systemPrompt = `You are a Principal Curriculum Architect and Pedagogical Engineer.
Analyze this skill: "${params.skillName}", Sub-Genre: "${params.subGenre || 'General'}", Category: "${category}", Target Mastery: "${target}".
Determine the exact number of progressive steps (between 4 and 8) needed to reach true mastery.

STRICT PROGRESSIVE CURRICULUM LEVELING MANDATE:
- Step 1: Core fundamentals, stance, grip/base, primary rules, and safety protocols.
- Step 2: Intermediate dynamic execution, kinetic flow, and common error identification.
- Step 3: Advanced match-pace scenarios, edge cases, pressure testing, and tactical integration.
- Step 4+: Peak mastery drills, high-speed execution, autonomous flow, and competitive readiness.

For physical skills, assign realistic "requiredPracticeDays" (between 2 and 7 days per step). For cognitive skills, assign 1 to 2 days.
Language: Provide all roadmap overviews, titles, and descriptions strictly in ${targetLanguage}.

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
