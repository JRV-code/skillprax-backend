import { SPORTS_TAXONOMY, SportSpecialization } from './sportsTaxonomy';

export interface SkillSpecialization {
  keywords: string[];
  subgenres: string[];
}

export const UNIVERSAL_SKILLS_TAXONOMY: Record<string, SkillSpecialization> = {
  // 1. Culinary Arts & Cooking
  cooking: {
    keywords: ['cooking', 'cook', 'culinary', 'culinary arts', 'chef', 'food prep', 'kitchen skills'],
    subgenres: [
      'Knife Skills, Mise en Place & Classical French Prep',
      'Pan Searing, Deglazing & Artisan Sauces (Pan Sauces, Roux & Reductions)',
      'Indian Regional Curries, Tempering (Tadka) & Whole-Spice Chemistry',
      'Italian Handmade Pasta, Emulsified Sauces & Slow Ragus',
      'High-Heat Wok Hei & East Asian Stir-Fry Mastery',
      'Slow-Roasting, Braising & Protein Temperature Control',
    ],
  },
  baking: {
    keywords: ['baking', 'bake', 'pastry', 'pastry arts', 'bread', 'sourdough', 'patisserie'],
    subgenres: [
      'Artisan Sourdough, Dough Hydration & Wild Yeast Fermentation',
      'Laminated Viennoiserie (Croissants, Danish & Puff Pastry)',
      'Pastry Crèmes, Fruit Curds & Ganache Emulsification',
      'Structured Cake Science, Crumb Architecture & Buttercreams',
      'French Macarons, Meringue Precision & Choux Pastry',
      'Tempered Chocolate, Bonbons & Confectionery Science',
    ],
  },

  // 2. Languages
  spanish: {
    keywords: ['spanish', 'español', 'conversational spanish', 'learn spanish'],
    subgenres: [
      'Conversational Fluency & Spontaneous Sentence Construction',
      'Past-Tense Narration (Preterite vs. Imperfect Contrasts)',
      'Subjunctive Mood Mastery & Nuanced Hypothetical Scenarios',
      'Native Listening Comprehension, Accent Reduction & Cadence',
      'Everyday Idiomatic Expressions, Connectors & Colloquialisms',
      'Professional, Workplace & Travel Dialogue Precision',
    ],
  },
  french: {
    keywords: ['french', 'français', 'learn french', 'conversational french'],
    subgenres: [
      'French Phonetics, Nasal Vowels, Silent Letters & Liaison Mastery',
      'Everyday Conversational Fluency & Spontaneous Dialogue',
      'Passé Composé vs. Imparfait Storytelling Precision',
      'Subjunctive Mood & Conditional Hypotheticals in French',
      'Everyday Idioms, Slang (Argot) & Colloquial Speech Patterns',
      'Professional Business & Formal French Correspondence',
    ],
  },
  japanese: {
    keywords: ['japanese', 'nihongo', 'learn japanese'],
    subgenres: [
      'Hiragana, Katakana & Radical Stroke Foundation',
      'Essential Particle Precision (Wa, Ga, Wo, Ni, De) & Basic Syntax',
      'Conversational Fluency & Polite (Keigo) vs. Casual Nuances',
      'Kanji Memory Mnemonics & High-Frequency JLPT Vocab',
      'Authentic Listening Comprehension & Native Speech Rhythm',
      'Compound Verbs, Te-Form Sequencing & Real-World Dialogues',
    ],
  },
  german: {
    keywords: ['german', 'deutsch', 'learn german'],
    subgenres: [
      'German Sentence Word Order (V2 Rule & Subordinate Clause Kicker)',
      'Four Cases (Nominative, Accusative, Dative, Genitive) Mastery',
      'Two-Way Prepositions (Wechselpräpositionen) & Direction vs. Location',
      'Conversational Fluency, Cadence & Modal Particles (Doch, Mal, Ja)',
      'Compound Noun Decryption & High-Frequency Idioms',
      'Professional Business & Technical German Communication',
    ],
  },
  english: {
    keywords: ['english', 'esl', 'spoken english', 'learn english', 'english fluency'],
    subgenres: [
      'Spoken Fluency, Reduced Forms & Connected Speech Flow',
      'Advanced Idioms, Phrasal Verbs & Nuanced Vocabulary',
      'Professional Presentation, Debate & Workplace Communication',
      'Accent Neutralization, Intonation Contours & Stress Timing',
      'Clear Analytical & Business Email Writing Structure',
      'Listening Comprehension Across Diverse Native & Global Accents',
    ],
  },

  // 3. Fine Arts & Creative Media
  drawing: {
    keywords: ['drawing', 'draw', 'sketching', 'sketch', 'illustration', 'figure drawing'],
    subgenres: [
      'Dynamic Figure Drawing, Gesture & Proportion Landmarks',
      'Linear Perspective (1, 2, and 3-Point) & Spatial Depth',
      'Value Studies, Volumetric Shading & Form Lighting (Chiaroscuro)',
      'Anatomy for Artists: Skeletal Form & Muscle Mechanics',
      'Color Theory, Lighting Moods & Digital/Traditional Painting',
      'Expressive Inking, Line Weight Variation & Cross-Hatching',
    ],
  },
  photography: {
    keywords: ['photography', 'camera', 'photo', 'photographer', 'portrait photography'],
    subgenres: [
      'Manual Exposure Triangle (Aperture, Shutter Speed, ISO) Mastery',
      'Cinematic Composition, Focal Lengths & Spatial Framing',
      'Lighting Architecture: Natural Light Modifiers & Strobe Setups',
      'Portrait Posing, Expression Directing & Depth-of-Field Control',
      'RAW Processing, Color Grading & Tonal Curve Editing',
      'Street & Documentary Storytelling under Dynamic Light',
    ],
  },
  filmmaking: {
    keywords: ['filmmaking', 'videography', 'video production', 'cinematography', 'video editing'],
    subgenres: [
      'Cinematic Lighting (Three-Point, Diffusion & Practical Lights)',
      'Camera Movement: Gimbals, Tracking Shots & Kinetic Pacing',
      'Microphone Selection, Boom/Lavalier Audio & Clean Sound Capture',
      'Visual Storyboarding, Shot Lists & Narrative Continuity',
      'Color Grading with LOG Curves, LUTs & Waveform Scopes',
      'Dynamic Editing, Sound Design & Rhythm in Premiere/DaVinci',
    ],
  },

  // 4. Music & Performance
  guitar: {
    keywords: ['guitar', 'acoustic guitar', 'electric guitar', 'classical guitar'],
    subgenres: [
      'Fingerstyle Picking Independence & Arpeggio Velocity',
      'Clean Open & Barre Chord Transitions with Proper Hand Arch',
      'Pentatonic & Major Scale Fretboard Mapping & Improvisation',
      'Rhythm Strumming, Syncopated Grooves & Dynamic Accenting',
      'Guitar Theory: Interval Recognition, Triad Inversions & CAGED',
      'Expressive Lead Techniques (String Bends, Vibrato & Slides)',
    ],
  },
  piano: {
    keywords: ['piano', 'keyboard', 'pianist', 'piano playing'],
    subgenres: [
      'Two-Hand Independence, Polyrhythms & Finger Dexterity',
      'Major & Minor Scale Velocities, Hand Crossings & Arpeggios',
      'Chord Voicings, Rootless Jazz Harmonies & Inversion Movement',
      'Sheet Music Sight-Reading & Dynamic Sustain Pedal Articulation',
      'Classical Repertoire Phrasing, Touch & Emotional Dynamics',
      'Blues & Pop Comping: Walking Basslines & Lead Embellishments',
    ],
  },
  singing: {
    keywords: ['singing', 'vocal', 'vocals', 'voice training', 'sing'],
    subgenres: [
      'Diaphragmatic Breath Support & Inhalation Posture Mechanics',
      'Vocal Resonance Placement & Chest-to-Head Mix Voice Smoothing',
      'Pitch Accuracy, Ear Training & Microtonal Control',
      'Vowel Modification (Formant Tuning) for Effortless High Notes',
      'Vibrato Development, Vocal Agility Runs & Melismatic Ornamentation',
      'Performance Phrasing, Micro-Dynamics & Emotional Delivery',
    ],
  },

  // 5. Mathematics & Logic
  math: {
    keywords: ['math', 'maths', 'mathematics', 'calculus', 'algebra'],
    subgenres: [
      'Linear Algebra: Vector Spaces, Eigenvalues & Matrix Factorizations',
      'Multivariable Calculus: Gradients, Directional Derivatives & Vector Fields',
      'Probability, Combinatorics & Bayesian Inference',
      'Discrete Mathematics, Graph Theory & Formal Proof Architectures',
      'Differential Equations & Continuous Dynamical Systems Modeling',
      'Real Analysis, Rigorous Limits & Epsilon-Delta Proof Crafting',
    ],
  },

  // 6. Programming & Software Engineering
  coding: {
    keywords: ['coding', 'programming', 'software engineering', 'web development', 'python', 'javascript', 'typescript'],
    subgenres: [
      'Modern Full-Stack Web Architecture (Next.js, TypeScript & REST/GraphQL)',
      'Algorithmic Problem Solving, Dynamic Programming & Complexity Optimization',
      'Distributed Systems, Message Queues & Event-Driven Microservices',
      'Database Schema Engineering, Indexing Strategies & Query Optimization',
      'Cloud Native Infrastructure, Docker Containers & Automated CI/CD Pipelines',
      'API Hardening, Zero-Trust Authentication & Security Defenses',
    ],
  },

  // 7. Finance & Investing
  finance: {
    keywords: ['finance', 'investing', 'personal finance', 'stocks', 'stock market', 'financial literacy'],
    subgenres: [
      'Index Fund Investing, Asset Allocation & Modern Portfolio Theory',
      'Fundamental Equity Valuation: Discounted Cash Flows & Financial Statement Analysis',
      'Tax-Advantaged Wealth Architecture (401k, IRA & Capital Gains Planning)',
      'Debt Elimination Protocols, High-Yield Cash Flow & Emergency Reserves',
      'Real Estate Investment Analysis: Cap Rates, Cash-on-Cash & Leverage',
      'Behavioral Economics, Cognitive Biases & Systematic Risk Mitigation',
    ],
  },

  // 8. Public Speaking & Communication
  publicspeaking: {
    keywords: ['public speaking', 'presentation', 'speech', 'communication skills', 'storytelling', 'oratory'],
    subgenres: [
      'Narrative Architecture, Emotional Story Hooks & Key Takeaway Framing',
      'Vocal Projection, Dynamic Cadence & Strategic Pausing Techniques',
      'Open Body Language, Stage Movement & Spatial Anchor Anchoring',
      'Impromptu Speaking & Framework-Driven Rapid Thinking (PREP/STAR)',
      'Audience Engagement, Q&A Defusing & Objection Handling',
      'High-Stakes Keynote Presentation Design & Visual Slide Synergy',
    ],
  },

  // 9. Chess & Strategic Games
  chess: {
    keywords: ['chess', 'chess strategy', 'chess tactics'],
    subgenres: [
      'Tactical Pattern Recognition: Pins, Forks, Skewers & Deflection',
      'Opening Principles, King Safety & Rapid Minor Piece Development',
      'Positional Strategy, Outpost Control & Weak Square Exploitation',
      'Pawn Structure Dynamics (Isolani, Hanging Pawns & Pawn Chains)',
      'Essential Endgame Conversion: Lucena, Philidor & Opposition',
      'Calculation Discipline, Candidate Moves & Blunder Prevention',
    ],
  },
};

/**
 * Universal Instant Lookup for Subgenres (< 15ms)
 * Checks both the Universal Cognitive/Creative Taxonomy AND the Sports Taxonomy.
 */
export function getInstantUniversalSubgenres(skillName: string): string[] | null {
  if (!skillName || typeof skillName !== 'string') return null;
  const clean = skillName.trim().toLowerCase();

  // 1. Check Universal Skills Taxonomy
  for (const entry of Object.values(UNIVERSAL_SKILLS_TAXONOMY)) {
    for (const kw of entry.keywords) {
      if (
        clean === kw ||
        clean.startsWith(kw + ' ') ||
        clean.endsWith(' ' + kw) ||
        clean.includes(kw)
      ) {
        return entry.subgenres;
      }
    }
  }

  // 2. Check Athletic/Sports Taxonomy
  for (const entry of Object.values(SPORTS_TAXONOMY)) {
    for (const kw of entry.keywords) {
      if (
        clean === kw ||
        clean.startsWith(kw + ' ') ||
        clean.endsWith(' ' + kw) ||
        clean.includes(kw)
      ) {
        return entry.subgenres;
      }
    }
  }

  return null;
}
