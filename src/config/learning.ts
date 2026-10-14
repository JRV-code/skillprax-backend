export const BLOCKED_DOMAINS = [
  'linkedin.com', 'facebook.com', 'instagram.com', 'pinterest.com', 'quora.com',
  'scribd.com', 'researchgate.net', 'academia.edu', 'udemy.com', 'coursera.org',
  'skillshare.com', 'masterclass.com', 'medium.com', 'nytimes.com', 'wsj.com',
  'ft.com', 'bloomberg.com', 'tiktok.com', 'x.com', 'twitter.com', 'reddit.com',
] as const;

export const LEARNING_CONFIG = {
  PASS_THRESHOLD_PERCENT: 70,          // the ONE place for the pass mark
  STEPS_MIN: 3, STEPS_MAX: 8,          // matches the "3-8 MILESTONES" badge
  QUIZ_MIN_QUESTIONS: 8, QUIZ_MAX_QUESTIONS: 12,
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
  LINK_CHECK_TIMEOUT_MS: 5000,
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
export function stepRangeHint(gap: number, dailyMinutes: number): [number, number] {
  let lo = 3 + Math.floor(gap * 0.75); // gap 0..4 -> 3..6
  let hi = lo + 2;
  if (dailyMinutes < 45) {
    lo += 1;
    hi += 1;
  } // smaller milestones for short sessions
  return [Math.min(lo, 7), Math.min(hi, 8)];
}

export const TIER_QUERY_MODIFIERS: Record<DifficultyTier, string> = {
  FOUNDATIONS: 'fundamentals terminology rules safety mental models for beginners',
  ELEMENTARY_MECHANICS: 'basic mechanics isolated drills simple combinations common errors',
  INTERMEDIATE_FLUIDITY: 'intermediate dynamic drills rhythm pace variation edge cases',
  ADVANCED_SITUATIONAL_STRESS: 'advanced high-speed decision making complex real-world integration',
  ELITE_MASTERY: 'elite advanced nuances optimization benchmarks fine technique',
};
