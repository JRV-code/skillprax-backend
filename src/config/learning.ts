export const BLOCKED_DOMAINS = [
  'linkedin.com', 'facebook.com', 'instagram.com', 'pinterest.com', 'quora.com',
  'scribd.com', 'tiktok.com', 'x.com', 'twitter.com', 'reddit.com',
] as const;

export const LEARNING_CONFIG = {
  PASS_THRESHOLD_PERCENT: 70,          // the ONE place for the pass mark
  STEPS_MIN: 3, STEPS_MAX: 6,          // dynamic 3-6 milestone scaling
  QUIZ_MIN_QUESTIONS: 5, QUIZ_MAX_QUESTIONS: 10, // dynamic 5-10 question scaling
  CHAPTERS_MIN: 2, CHAPTERS_MAX: 4,
  TOPICS_TOTAL_MIN: 3, TOPICS_TOTAL_MAX: 8,
  FACTS_PER_TOPIC_MIN: 3, FACTS_PER_TOPIC_MAX: 5,
  VERBATIM_RUN_WORDS: 8,
  MIN_EXTRACTABLE_CHARS: 150,
  SOURCE_CHARS_PER_TOPIC: 2500,
  MAX_LINKS_PER_DOMAIN_PER_STEP: 1,
  MAX_LINKS_PER_DOMAIN_PER_WORKSPACE: 3,
  LOOKAHEAD_STEPS: 1,                  // silent prefetch never goes beyond step N+1
  ENGAGEMENT_SECONDS: 20,              // active reading time that counts as "reading"
  PACK_STALE_AFTER_MS: 300000,
  MAX_EXTRA_TOPIC_SEARCHES: 3,
  LINK_CHECK_TIMEOUT_MS: 2500,
  LINK_VERIFY_TIMEOUT_MS: 2500,
  LINK_CHECK_CONCURRENCY: 5,
  SUBGENRE_MIN: 4, SUBGENRE_MAX: 6,
  LANGUAGES: ['en', 'hi', 'gu', 'mr', 'kn', 'ta', 'te', 'fr', 'es', 'de'] as const,

  // Compatibility aliases for legacy helper modules
  MAX_SHARED_RUN_WORDS: 8,
  TOPICS_MIN: 3,
  TOPICS_MAX: 8,
  MIN_SOURCE_TEXT_CHARS: 1200,
  MIN_ANCHOR_SOURCE_CHARS: 400,
  SOURCE_CHARS_PER_CHAPTER: 2500,
  ANCHORS_MIN_PER_CHAPTER: 3,
  ANCHORS_MAX_PER_CHAPTER: 5,
  MAX_PER_DOMAIN_PER_STEP: 1,
  MAX_PER_CHANNEL_PER_STEP: 1,
  SEARCH_CONCURRENCY: 5,
  TITLE_SIMILARITY_DUP: 0.8,
  SNIPPET_MAX_CHARS: 220,
  QUIZ_MAX_OBJECTIVE_RATIO: 0.4,
  EXCLUDE_DOMAINS: BLOCKED_DOMAINS,
} as const;

export const DIFFICULTY_TIERS = [
  'FOUNDATIONS',
  'ELEMENTARY_MECHANICS',
  'INTERMEDIATE_FLUIDITY',
  'ADVANCED_SITUATIONAL_STRESS',
  'ELITE_MASTERY',
] as const;
export type DifficultyTier = (typeof DIFFICULTY_TIERS)[number];

// Desired mastery level -> END tier index. Experience level -> START tier index.
// Real dropdown labels from EnrollSkillModal.tsx
export const MASTERY_END_TIER: Record<string, number> = {
  Beginner: 1,
  Intermediate: 2,
  Advanced: 3,
  'Professional Mastery': 4,
};

export const EXPERIENCE_START_TIER: Record<string, number> = {
  'Absolute Beginner': 0,
  'No Prior Knowledge': 0,
  'Some Foundational Knowledge': 1,
  'Intermediate Practitioner': 2,
  'Working Proficiency': 2,
  'Experienced / Advanced': 3,
  'Advanced Practitioner': 3,
};

// Step tiers climb from where the learner IS to where they WANT to be.
export function tierForStepRange(
  stepIndex: number,
  total: number,
  startIdx: number,
  endIdx: number
): DifficultyTier {
  const end = Math.max(endIdx, startIdx); // never ask for less than they know
  if (total <= 1) return DIFFICULTY_TIERS[end];
  const idx = Math.round(startIdx + (end - startIdx) * ((stepIndex - 1) / (total - 1)));
  return DIFFICULTY_TIERS[Math.max(0, Math.min(4, idx))];
}

// Legacy helper compatibility
export function tierForStep(stepIndex: number, totalSteps: number): DifficultyTier {
  return tierForStepRange(stepIndex, totalSteps, 0, 4);
}

// Advisory range handed to Groq (it still decides within STEPS_MIN..STEPS_MAX).
export function stepRangeHint(gapOrStart: number, dailyMinutesOrEnd: number, dailyMinsOpt?: number): [number, number] {
  if (dailyMinsOpt !== undefined) {
    const { minSteps, maxSteps } = calculatePersonalizedStepBounds({
      skillName: '',
      startTierIdx: gapOrStart,
      endTierIdx: dailyMinutesOrEnd,
      dailyMinutes: dailyMinsOpt,
    });
    return [minSteps, maxSteps];
  }
  let lo = 3 + Math.floor(gapOrStart * 0.6); // gap 0..4 -> 3..5
  let hi = lo + 1;
  if (dailyMinutesOrEnd < 45) {
    lo += 1;
    hi += 1;
  }
  return [
    Math.max(LEARNING_CONFIG.STEPS_MIN, Math.min(lo, LEARNING_CONFIG.STEPS_MAX - 1)),
    Math.min(hi, LEARNING_CONFIG.STEPS_MAX),
  ];
}

// Deterministic multi-factor calculator for personalized step count (3..6 milestones)
export function calculatePersonalizedStepBounds(params: {
  skillName: string;
  subGenre?: string;
  domain?: string;
  startTierIdx?: number; // 0..3
  endTierIdx?: number;   // 1..4
  currentExperience?: string;
  desiredLevel?: string;
  dailyMinutes?: number;
}): { minSteps: number; maxSteps: number; recommendedTarget: number } {
  const skillText = `${params.skillName || ''} ${params.subGenre || ''} ${params.domain || ''}`.toLowerCase();
  const dailyMinutes = Number(params.dailyMinutes) || 60;

  // Map experience & desired level strings if numeric indices aren't passed
  const expMap: Record<string, number> = {
    'no prior knowledge': 0, 'absolute beginner': 0, 'beginner': 0, 'novice': 0,
    'some foundational knowledge': 1, 'basic familiarity': 1, 'elementary': 1,
    'intermediate practitioner': 2, 'intermediate': 2, 'working proficiency': 2,
    'experienced / advanced': 3, 'advanced practitioner': 3, 'advanced': 3,
  };
  const targetMap: Record<string, number> = {
    'beginner': 1, 'foundational': 1, 'basic': 1,
    'intermediate': 2, 'working proficiency': 2,
    'advanced': 3, 'competitive': 3,
    'professional mastery': 4, 'elite': 4, 'mastery': 4,
  };

  const startIdx = params.startTierIdx ?? (expMap[(params.currentExperience || '').toLowerCase()] ?? 0);
  const endIdx = params.endTierIdx ?? (targetMap[(params.desiredLevel || '').toLowerCase()] ?? 3);
  const gap = Math.max(1, endIdx - startIdx); // 1 to 4

  // Base step calculation across 3..6
  let score = 2.6 + gap * 0.75;

  // Time adjustment
  if (dailyMinutes <= 30) score += 0.6;
  else if (dailyMinutes >= 120) score -= 0.5;

  // Intrinsic skill complexity adjustment
  const deepSkills = /full[- ]?stack|system|architecture|machine learning|deep learning|ai|quantum|compiler|organic chemistry|calculus|physics|biomechanics|algorithm|cryptography|3d|blender|unreal|distributed|competitive|tournament|gymnastics|swimming|boxing|martial/i;
  const quickSkills = /laundry|folding|cleaning|hydration|basic|etiquette|typing|stretching|breathing|organization|note[- ]?taking/i;

  if (deepSkills.test(skillText)) score += 0.85;
  else if (quickSkills.test(skillText)) score -= 0.85;

  const recommendedTarget = Math.max(
    LEARNING_CONFIG.STEPS_MIN,
    Math.min(LEARNING_CONFIG.STEPS_MAX, Math.round(score))
  );
  const minSteps = Math.max(LEARNING_CONFIG.STEPS_MIN, recommendedTarget - 1);
  const maxSteps = Math.min(LEARNING_CONFIG.STEPS_MAX, recommendedTarget + 1);

  return { minSteps, maxSteps, recommendedTarget };
}

// Deterministic calculator for personalized quiz question count (5..10 questions)
export function calculatePersonalizedQuestionCount(params: {
  stepIndex: number;       // 1-based step number
  totalSteps: number;      // 3..6
  difficultyTier: string;  // FOUNDATIONS .. ELITE_MASTERY
  topicsCount: number;     // number of topics in this step
  acusCount: number;       // number of ACUs in this step
  skillName: string;
  mode?: 'initial' | 'retest' | 'perfection';
}): number {
  const { stepIndex, totalSteps, difficultyTier, topicsCount, acusCount, skillName, mode } = params;

  // Start at base 5 questions for foundational steps
  let count = 5;

  // 1. Add questions based on Difficulty Tier (0 to +2)
  const tierWeights: Record<string, number> = {
    FOUNDATIONS: 0,
    ELEMENTARY_MECHANICS: 1,
    INTERMEDIATE_FLUIDITY: 1,
    ADVANCED_SITUATIONAL_STRESS: 2,
    ELITE_MASTERY: 2,
  };
  count += tierWeights[difficultyTier] ?? 1;

  // 2. Add questions based on number of topics & competency units in this step (0 to +1)
  if (topicsCount >= 4 || acusCount >= 4) count += 1;

  // 3. Add progression weight for later milestones in the roadmap (0 to +1)
  const progressRatio = totalSteps > 1 ? (stepIndex - 1) / (totalSteps - 1) : 0;
  if (progressRatio >= 0.6) count += 1;

  // 4. Add +1 for high-density analytical/technical skills
  if (/math|physics|chemistry|algorithm|architecture|code|programming|engineering|finance|quantum/i.test(skillName)) {
    count += 1;
  }

  // Retest / perfection modes stay concise (5 to 7 questions)
  if (mode === 'retest' || mode === 'perfection') {
    return Math.max(5, Math.min(7, count));
  }

  // Clamp strictly between QUIZ_MIN_QUESTIONS (5) and QUIZ_MAX_QUESTIONS (10)
  return Math.max(
    LEARNING_CONFIG.QUIZ_MIN_QUESTIONS,
    Math.min(LEARNING_CONFIG.QUIZ_MAX_QUESTIONS, count)
  );
}

export const TIER_QUERY_MODIFIERS: Record<DifficultyTier, string> = {
  FOUNDATIONS: 'fundamentals terminology rules safety mental models for beginners',
  ELEMENTARY_MECHANICS: 'basic mechanics isolated drills simple combinations common errors',
  INTERMEDIATE_FLUIDITY: 'intermediate dynamic drills rhythm pace variation edge cases',
  ADVANCED_SITUATIONAL_STRESS: 'advanced high-speed decision making complex real-world integration',
  ELITE_MASTERY: 'elite advanced nuances optimization benchmarks fine technique',
};
