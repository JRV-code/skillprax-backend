export const LEARNING_CONFIG = {
  PASS_THRESHOLD_PERCENT: 70,          // THE one place for the pass mark
  QUIZ_MIN_QUESTIONS: 8,
  QUIZ_MAX_QUESTIONS: 12,
  QUIZ_MAX_OBJECTIVE_RATIO: 0.4,       // max share of questions from CHAPTER_OBJECTIVE anchors
  CHAPTERS_MIN: 3,
  CHAPTERS_MAX: 6,
  ANCHORS_MIN_PER_CHAPTER: 3,
  ANCHORS_MAX_PER_CHAPTER: 5,
  SOURCE_CHARS_PER_CHAPTER: 2000,      // transient text sent to Groq per chapter
  MIN_ANCHOR_SOURCE_CHARS: 400,        // below this a resource gives no source text
  SNIPPET_MAX_CHARS: 220,              // the only third-party text we persist
  MAX_SHARED_RUN_WORDS: 8,             // paraphrase guard (section 7.5)
  TOPICS_MIN: 3,
  TOPICS_MAX: 6,
  MAX_EXTRA_TOPIC_SEARCHES: 2,
  MIN_SOURCE_TEXT_CHARS: 400,
  MIN_GROUNDED_TEXT_CHARS: 400,
  MAX_PER_DOMAIN_PER_STEP: 2,          // non-YouTube
  MAX_PER_CHANNEL_PER_STEP: 2,         // YouTube
  TITLE_SIMILARITY_DUP: 0.8,           // Jaccard; mirrors/reposts count as duplicates
  MAX_REPLACEMENTS_PER_CHAPTER: 3,
  SEARCH_CONCURRENCY: 3,
  LINK_CHECK_TIMEOUT_MS: 5000,
  LINK_CHECK_CONCURRENCY: 5,
  SUBGENRE_MIN: 4,
  SUBGENRE_MAX: 6,
  LANGUAGES: ['en', 'hi', 'gu', 'mr', 'kn', 'ta', 'te', 'fr', 'es', 'de'],
  EXCLUDE_DOMAINS: [
    'pinterest.com',
    'facebook.com',
    'instagram.com',
    'tiktok.com',
    'quora.com',
    'scribd.com',
    'slideshare.net',
    'coursehero.com',
    'chegg.com',
  ],
} as const;

export const DIFFICULTY_TIERS = [
  'FOUNDATIONS',
  'ELEMENTARY_MECHANICS',
  'INTERMEDIATE_FLUIDITY',
  'ADVANCED_SITUATIONAL_STRESS',
  'ELITE_MASTERY',
] as const;
export type DifficultyTier = (typeof DIFFICULTY_TIERS)[number];

// stepIndex is 1-based; roadmaps have 3-8 steps, so map proportionally.
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
