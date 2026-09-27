export const UNIVERSAL_DOMAINS = [
  {
    id: "natural-physical-sciences",
    label: "Natural & Physical Sciences",
    description: "Physics, Chemistry, Biology, Earth & Space Sciences, Ecology, Botany, Genetics",
    icon: "Atom"
  },
  {
    id: "formal-sciences-math",
    label: "Formal Sciences & Mathematics",
    description: "Pure Mathematics, Calculus, Discrete Logic, Probability, Statistics, Game Theory",
    icon: "Sigma"
  },
  {
    id: "engineering-applied-tech",
    label: "Engineering & Applied Technology",
    description: "Software, Hardware, Robotics, Electronics, Mechanical, Aerospace, Embedded Systems",
    icon: "Cpu"
  },
  {
    id: "social-sciences-behavior",
    label: "Social Sciences & Human Behavior",
    description: "Psychology, Cognitive Science, Economics, Sociology, Anthropology, Political Systems",
    icon: "Users"
  },
  {
    id: "business-finance-leadership",
    label: "Business, Finance & Strategy",
    description: "Financial Markets, Venture Creation, Operations, Marketing, Organizational Design",
    icon: "TrendingUp"
  },
  {
    id: "humanities-philosophy-law",
    label: "Humanities, Philosophy & Law",
    description: "Ethics, Epistemology, World History, Jurisprudence, Linguistics, Critical Theory",
    icon: "BookOpen"
  },
  {
    id: "arts-media-architecture",
    label: "Arts, Media & Spatial Design",
    description: "Visual Arts, 3D Modeling, Architecture, Music Composition, UI/UX, Industrial Design",
    icon: "Palette"
  },
  {
    id: "health-medicine-athletics",
    label: "Health, Physiology & Performance",
    description: "Human Anatomy, Nutrition, Biomechanics, Kinesiology, Sports Training, Medicine",
    icon: "Activity"
  },
  {
    id: "practical-crafts-trades",
    label: "Practical Crafts & Applied Trades",
    description: "Electronics Repair, Fabrication, Audio Production, Agriculture, Precision Carpentry",
    icon: "Wrench"
  }
] as const;

export type UniversalDomainId = typeof UNIVERSAL_DOMAINS[number]['id'];

// Compatibility exports
export const DOMAIN_CATEGORIES = UNIVERSAL_DOMAINS.map(d => ({
  id: d.id,
  name: d.label,
  examples: d.description,
  icon: d.icon
}));
export const TECHNICAL_DOMAINS = DOMAIN_CATEGORIES;
