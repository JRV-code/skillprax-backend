export const LEARNING_CONFIG = {
  PASS_THRESHOLD_PERCENT: 75,    // the one place to change the pass mark
  QUIZ_MIN_QUESTIONS: 8,
  QUIZ_MAX_QUESTIONS: 12,
  SOURCE_TEXT_MAX_CHARS: 12000,  // total source text sent to Groq per synthesis
  MIN_SOURCE_TEXT_CHARS: 800,    // below this a page is not usable as text
  MIN_GROUNDED_TEXT_CHARS: 1500, // minimum text needed to generate a quiz
  SUBGENRE_MIN: 4,
  SUBGENRE_MAX: 6,
  TOPICS_MIN: 3,
  TOPICS_MAX: 6,
  MAX_EXTRA_TOPIC_SEARCHES: 3,   // cost cap for per-topic recovery searches
  LINK_CHECK_TIMEOUT_MS: 5000,
  LINK_CHECK_CONCURRENCY: 5,
} as const;

export const DIFFICULTY_TIERS = [
  'FOUNDATIONS',
  'ELEMENTARY_MECHANICS',
  'INTERMEDIATE_FLUIDITY',
  'ADVANCED_SITUATIONAL_STRESS',
  'ELITE_MASTERY',
] as const;
export type DifficultyTier = (typeof DIFFICULTY_TIERS)[number];

// stepIndex is 1-based. Roadmaps have 3-8 steps, so map position onto the
// 5-tier curve proportionally instead of assuming exactly 5 steps.
export function tierForStep(stepIndex: number, totalSteps: number): DifficultyTier {
  if (totalSteps <= 1) return DIFFICULTY_TIERS[0];
  const ratio = (stepIndex - 1) / (totalSteps - 1);
  return DIFFICULTY_TIERS[Math.min(4, Math.round(ratio * 4))];
}

export const TIER_QUERY_MODIFIERS: Record<DifficultyTier, string> = {
  FOUNDATIONS: 'fundamentals terminology rules safety mental models for beginners',
  ELEMENTARY_MECHANICS: 'basic mechanics isolated drills simple combinations common errors',
  INTERMEDIATE_FLUIDITY: 'intermediate dynamic drills rhythm pace variation edge cases',
  ADVANCED_SITUATIONAL_STRESS: 'advanced high-speed decision making complex real-world integration',
  ELITE_MASTERY: 'elite advanced nuances optimization benchmarks fine technique',
};
