export const DOMAIN_CATEGORIES = [
  { 
    id: "science-nature", 
    name: "Natural Sciences & Nature", 
    icon: "Leaf", 
    examples: "Ecology, Botany, Physics, Astronomy, Genetics, Zoology, Earth Science" 
  },
  { 
    id: "engineering-tech", 
    name: "Engineering & Applied Technology", 
    icon: "Cpu", 
    examples: "Robotics, Electronics, Software, Embedded Systems, Mechanical Eng." 
  },
  { 
    id: "math-logic", 
    name: "Mathematics, Logic & Analysis", 
    icon: "Calculator", 
    examples: "Calculus, Statistics, Discrete Math, Game Theory, Quantitative Reasoning" 
  },
  { 
    id: "business-finance", 
    name: "Business, Finance & Economics", 
    icon: "TrendingUp", 
    examples: "Financial Markets, Entrepreneurship, Marketing, Economics, Project Mgmt" 
  },
  { 
    id: "creative-arts", 
    name: "Creative Arts, Design & Media", 
    icon: "Palette", 
    examples: "3D Modeling, Blender, Music Theory, Graphic Design, Animation, Game Design" 
  },
  { 
    id: "humanities-social", 
    name: "Humanities, History & Philosophy", 
    icon: "BookOpen", 
    examples: "World History, Philosophy, Psychology, Cognitive Science, Linguistics" 
  },
  { 
    id: "health-athletics", 
    name: "Health, Physiology & Athletics", 
    icon: "Activity", 
    examples: "Exercise Physiology, Nutrition, Sports Mechanics, Kinesiology" 
  }
] as const;

export type DomainCategoryId = typeof DOMAIN_CATEGORIES[number]['id'];
export const TECHNICAL_DOMAINS = DOMAIN_CATEGORIES;

