import fs from 'fs';
import path from 'path';
import prisma from '../../lib/prisma';
import { db } from '../../lib/db';

/**
 * SKILL-TRACK APP KNOWLEDGE & SPECIFICATION ENGINE
 * 
 * Provides:
 * 1. Comprehensive Built-In SKILL-TRACK Specification Manual (4 Navigation Hubs, Workflows, Workspaces, Sports Timers, Quizzes, Certificates)
 * 2. Automatic Future-Feature Discovery Scanner (scans route trees dynamically every 5 mins)
 * 3. Live Per-User Personalization Context (read-only query of profile, active steps, medical restrictions, streaks)
 */

interface CachedManifest {
  timestamp: number;
  detectedModules: string[];
}

let cachedManifest: CachedManifest | null = null;
const MANIFEST_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Scan filesystem routes dynamically to auto-discover any new features, pages, or modules
 */
export function scanPlatformFeatures(): string[] {
  const now = Date.now();
  if (cachedManifest && now - cachedManifest.timestamp < MANIFEST_CACHE_TTL_MS) {
    return cachedManifest.detectedModules;
  }

  const detected: string[] = [];

  try {
    // 1. Scan Backend Routes
    const backendRoutesDir = path.resolve(__dirname, '../../routes');
    if (fs.existsSync(backendRoutesDir)) {
      const files = fs.readdirSync(backendRoutesDir, { recursive: true }) as string[];
      for (const file of files) {
        if (typeof file === 'string' && (file.endsWith('.ts') || file.endsWith('.js'))) {
          const cleanName = file.replace(/\\/g, '/').replace(/\.(ts|js)$/, '');
          detected.push(`Backend API Module: /api/${cleanName}`);
        }
      }
    }

    // 2. Scan Frontend App Pages
    const frontendAppDir = path.resolve(__dirname, '../../../../skillprax-frontend/src/app');
    if (fs.existsSync(frontendAppDir)) {
      const entries = fs.readdirSync(frontendAppDir, { recursive: true }) as string[];
      for (const entry of entries) {
        if (typeof entry === 'string' && entry.endsWith('page.tsx')) {
          const routePath = '/' + entry.replace(/\\/g, '/').replace(/\/page\.tsx$/, '').replace(/^page\.tsx$/, '');
          detected.push(`Frontend Page Route: ${routePath || '/'}`);
        }
      }
    }
  } catch (err) {
    console.warn('[KnowledgeEngine] Feature scanner notice:', err);
  }

  if (detected.length === 0) {
    detected.push('Frontend: /skills, /sports, /profile, /assistant, /workspace/[id], /sports/workspace/[id]');
    detected.push('Backend: /api/workspaces, /api/steps, /api/sports, /api/skills, /api/assistant, /api/profile');
  }

  cachedManifest = {
    timestamp: now,
    detectedModules: detected,
  };

  return detected;
}

/**
 * Core Built-in Specification Manual for SKILL-TRACK
 */
export const SKILL_TRACK_MASTER_SPECIFICATION = `
===========================================================================
SKILL-TRACK OFFICIAL PLATFORM MANUAL & ARCHITECTURAL SPECIFICATION
===========================================================================

1. PLATFORM OVERVIEW & THE 4 CORE NAVIGATION HUBS:
- SKILL-TRACK is an autonomous AI-driven learning and athletic mastery platform.
- The 4 Core Navigation Sections in the top navigation bar are:
  1. 🧠 Skills Studio ('/skills' & '/workspace/[id]'): For Cognitive, Technical, Academic, Creative, and Professional skills.
  2. 📈 Sports Hub ('/sports' & '/sports/workspace/[id]'): For Athletic, Physical, Calisthenics, Martial Arts, and Yoga conditioning.
  3. 👤 Profile Hub ('/profile'): Learner command center displaying Level, Animated EXP Bar (300 XP per level), Active Day Streak, Live Average Quiz Question Accuracy (X/Y questions correct), Pending Cognitive & Physical Skills, Completed Mastery Vault (with downloadable Calligraphy Certificates), and Editable Smart Calibration (City, State, Age Category, Dietary Preference, Medical/Health Conditions, Language).
  4. ✨ AI Guide ('/assistant'): Dedicated intelligent mentor providing step-by-step app walkthroughs, guidance on any skill or sport, and live Tavily web research.

2. HOW ENROLLMENT WORKS (THE 6-FIELD TRAJECTORY GENERATOR):
- To enroll in any skill or sport, the learner clicks "+ Enroll Skill" or "+ Enroll New Sport".
- The 6 fields captured are:
  1. Core Domain Category (Software Engineering, Physical/Athletics, Business, Arts, Academics, etc.)
  2. Skill or Sport Name (e.g. Football, React.js, Swimming, Quantum Mechanics)
  3. Target Sub-Genre Specialization (e.g. Midfield Playmaking, Full-Stack Architecture, Freestyle Sprint)
  4. Desired Mastery Level (Foundations, Practitioner, Professional, Elite Competitor)
  5. Daily Learning/Practice Time (30m, 45m, 1h, 1.5h, 2h)
  6. Current Experience Level (Complete Beginner, Intermediate, Advanced)
- Groq AI dynamically constructs an authentic 3 to 6 Milestone Curriculum Roadmap scaled to the learner's experience gap and time commitment.

3. INSIDE-WORKSPACE LEARNING ARCHITECTURE:
- Cognitive Workspace ('/workspace/[id]'):
  * Horizontal Curriculum Architecture Roadmap showing Step 1 through Step N.
  * Clicking "Search for resources" on the active step triggers Groq + Tavily to synthesize:
    - Structured Study Book Chapters and Topics
    - "How to approach this" pedagogical guide (Key Traps, Sections to Read, Sections to Skip)
    - High-authority verified web documentation links (via Tavily)
    - In-App Video Lectures with playback controls (Play/Pause, -10s, +10s, 0.5x–2x playback speed) via PersistentPlayerHost.
- Sports Studio Workspace ('/sports/workspace/[id]'):
  * In addition to tactical chapters and video walkthroughs, each step contains a 3 to 5 Day Unified Daily Training Regimen.
  * Each day features 3 to 6 items mixing:
    - ⚡ Drills (Ball control, footwork, speed ladders)
    - 💪 Conditioning Exercises (Core stability, plyometrics, muscular endurance)
    - 🧘‍♂️ Yogasanas (Flexibility, joint recovery, balance, pranayama)
  * Regimens automatically adapt to the learner's Profile Medical/Health Conditions (e.g. avoiding high-impact if knee issues exist) and Dietary Preference.
  * Features dedicated countdown timers with single active timer lock, automatic completion at 00:00, "✓ Done with Drill", "🚀 Ready for Next Day →", and a celebratory "🎉 Hurray! You've Completed This Step's Training" screen on the final day with direct access to the Socratic Gate.

4. THE SOCRATIC EVALUATION GATE (70% PASSING THRESHOLD) & REMEDIATION:
- Every milestone ends with an MCQ Socratic Gate Quiz (5 to 10 dynamically scaled questions).
- Strict Grading Formula:
  * Score < 70%: FAILS the milestone. Unlocks targeted AI Remediation Explanations and specific study topics that must be reviewed before retaking.
  * Score 70% to 99%: PASSES the milestone! Learner can immediately advance to Step N+1 OR choose "Stay & Retry for 100% Perfection".
  * Score 100%: Awards bonus XP (150 XP) and immediately clears Step N+1.

5. SPORTS HUB DISCOVERY MODULES ('/sports'):
- Conditioning, Drills & Yogasanas: Active athletic tracks.
- Clubs Near Me & Local Academies: Uses the learner's enrolled sport, City/State (e.g. Ahmedabad, Gujarat), and Age Category (U-14, U-17, U-19, Open) to find real verified sports academies and facilities on Google Maps. Includes a custom "Search by yourself" bar.
- Sports Gear & Local Stores: Finds local equipment stores plus curated online gear with direct Amazon.in and Flipkart.com links.
- Tailored Nutrition & Hydration Strategy: Pre-training fuel, post-workout recovery, and electrolyte hydration customized to the sport and the learner's profile diet.

6. OFFICIAL CALLIGRAPHY CERTIFICATE OF COMPLETION:
- Upon passing 100% of milestones in any skill or sport:
  * An official Certificate modal immediately triggers with a 1.8s synthesis loading screen.
  * Renders in landscape 16:11 A4 proportion with Google Calligraphy fonts ('Great Vibes', 'Dancing Script', 'Alex Brush', 'Playfair Display').
  * Minimalistic colorful background in Sky Blue, Emerald Green, Indigo, and Warm Gold.
  * Centered Skill-Track Logo.
  * Exact Declaration: "This is to certify that [Name] has completed the learning of [Skill/Sport] using Skill-Track and has fully completed the tasks provided and has passed all the test."
  * Exact Tagline: "Build your skill, Rise to your peak and let your progress speak"
  * Sign-off: "Certified by Team Skill-Track"
  * Downloadable as a high-resolution 300 DPI PNG (2400 × 1650 px) or printable as vector PDF.
  * Permanent "🎓 View Certificate" buttons available in the Profile Mastery Vault and on completed cards.
`;

/**
 * Read-only fetch of user's active state, enrolled skills, sports progress, and health restrictions
 */
export async function getPersonalizedUserContext(userIdOrProfileId?: string): Promise<string> {
  if (!userIdOrProfileId || userIdOrProfileId === 'guest' || userIdOrProfileId === 'default-profile') {
    return `[Learner Profile]: Guest / Anonymous Explorer (No enrolled tracks yet). Encourage them to sign in or enroll in a skill or sport!`;
  }

  try {
    // 1. Fetch User Profile
    let profile: any = null;
    try {
      profile = await prisma.userProfile.findFirst({
        where: {
          OR: [
            { id: userIdOrProfileId },
            { emailKey: userIdOrProfileId },
            { googleSub: userIdOrProfileId },
          ],
        },
      });
    } catch (_) {}

    if (!profile) {
      try {
        const uRes = await db.query(
          `SELECT * FROM user_profiles WHERE id = $1 OR email = $1 LIMIT 1`,
          [userIdOrProfileId]
        );
        if (uRes.rows && uRes.rows[0]) profile = uRes.rows[0];
      } catch (_) {}
    }

    const userName = profile?.name || 'Learner';
    const city = profile?.city || 'Ahmedabad';
    const state = profile?.state || 'Gujarat';
    const ageCategory = profile?.ageCategory || profile?.age_category || 'Open';
    const diet = profile?.dietaryPreference || profile?.dietary_preference || 'Vegetarian';
    const healthConditions = profile?.healthConditions || profile?.health_conditions || 'None';
    const level = profile?.level || 1;
    const totalXp = profile?.totalXp || profile?.total_xp || 0;
    const streak = profile?.currentStreak || profile?.current_streak || 1;
    const avgAccuracy = profile?.avgQuizAccuracy || profile?.avg_quiz_accuracy || 0;

    // 2. Fetch Enrolled Workspaces & Sports
    let workspaces: any[] = [];
    try {
      workspaces = await (prisma as any).workspace?.findMany({
        where: { userProfileId: profile?.id || userIdOrProfileId },
        include: { steps: { orderBy: { stepIndex: 'asc' } } },
        orderBy: { updatedAt: 'desc' },
        take: 10,
      }) || [];
    } catch (_) {
      try {
        const wsRes = await db.query(
          `SELECT w.id, w.title, w.domain_category, w.sub_genre, w.total_planned_steps,
                  COUNT(s.id) FILTER (WHERE s.status = 'PASSED') as passed_count
           FROM workspaces w
           LEFT JOIN skill_steps s ON s.workspace_id = w.id
           WHERE w.user_profile_id = $1
           GROUP BY w.id, w.title, w.domain_category, w.sub_genre, w.total_planned_steps
           ORDER BY w.updated_at DESC LIMIT 10`,
          [profile?.id || userIdOrProfileId]
        );
        workspaces = wsRes.rows || [];
      } catch (_) {}
    }

    const activeTracks: string[] = [];
    const completedTracks: string[] = [];

    for (const ws of workspaces) {
      const title = ws.title || ws.skill_name || 'Enrolled Track';
      const isSport = (ws.domainCategory || ws.domain_category || '').toLowerCase().includes('athletic') ||
        ['football', 'cricket', 'soccer', 'swimming', 'tennis', 'badminton', 'basketball'].some((s: string) => title.toLowerCase().includes(s));
      
      const totalSteps = ws.totalPlannedSteps || ws.total_planned_steps || ws.steps?.length || 5;
      const passedSteps = Array.isArray(ws.steps)
        ? ws.steps.filter((s: any) => s.status === 'PASSED').length
        : parseInt(ws.passed_count || '0', 10);
      
      const currentStep = Math.min(totalSteps, passedSteps + 1);
      const isComplete = passedSteps >= totalSteps && totalSteps > 0;

      const trackInfo = `${title} (${isSport ? 'Sport' : 'Cognitive'}: Step ${currentStep}/${totalSteps}, ${passedSteps} passed)`;
      if (isComplete) {
        completedTracks.push(trackInfo);
      } else {
        activeTracks.push(trackInfo);
      }
    }

    return `
[LEARNER PROFILE & LIVE CONTEXT (READ-ONLY)]:
- Name: ${userName}
- Level: ${level} (Total XP: ${totalXp}) | Current Streak: ${streak} days | Quiz Accuracy: ${Math.round(avgAccuracy)}%
- Location: ${city}, ${state} | Age Category: ${ageCategory}
- Dietary Preference: ${diet}
- Health & Medical Restrictions: ${healthConditions} (Always ensure any physical drill, exercise, or diet advice strictly conforms to these restrictions!)
- Active Enrolled Tracks: ${activeTracks.length > 0 ? activeTracks.join('; ') : 'None currently in progress.'}
- Completed Masteries (100% Cleared): ${completedTracks.length > 0 ? completedTracks.join('; ') : 'None yet.'}
`.trim();
  } catch (err) {
    console.warn('[KnowledgeEngine] Context fetch error:', err);
    return `[Learner Profile]: Active Explorer (Profile loaded).`;
  }
}

export const NATURAL_LANGUAGE_INTENT_AND_SYNONYM_MATRIX = `
===========================================================================
NATURAL LANGUAGE INTENT & SYNONYM PARSER (FREE-FORM QUERY RESOLVER)
===========================================================================
Learners ask questions in completely loose, casual, and colloquial language. Map their phrasing dynamically:

1. QUIZ / EVALUATION INTENTS:
   - Phrases: "how do i do the quiz?", "take test", "exam", "check my knowledge", "quiz questions", "passed the test", "assessment", "socratic", "why did i fail?", "retake", "70%", "score".
   - Mapped Feature: Socratic Gate Evaluation (at the bottom of each milestone step).
   - Knowledge: Requires 70% to pass. 5 to 10 unique MCQs. If failed (<70%), remediation study points unlock. If passed (70-99%), advances to next step with option to retry for 100% Perfection. 100% awards 150 bonus XP!

2. USER TELEMETRY & PROGRESS INTENTS:
   - Phrases: "what's my streak?", "how many days?", "what level am i?", "what is my xp?", "what is my accuracy?", "how am i doing?", "my stats", "my progress", "what step am i on?", "where was i?".
   - Mapped Feature: Live User Telemetry from Profile Hub ('/profile') and Workspace Milestones.
   - CRITICAL BEHAVIOR: Answer DIRECTLY with the live numbers found in the [CURRENT USER CONTEXT (LIVE READ-ONLY DATA)] below! Do not speak generally. Quote their exact streak, level, XP, quiz accuracy, and current active step.

3. "I AM LOST" / ONBOARDING INTENTS:
   - Phrases: "i am lost", "how does this app work?", "where do i start?", "help me", "what is skill-track?", "how do i enroll?", "new to this".
   - Mapped Feature: Guided Navigation across the 4 Hubs:
     * Step 1: Enroll in a skill or sport via "+ Enroll Skill" or "+ Enroll New Sport" (6-field trajectory).
     * Step 2: Open active step in Skills Studio ('/skills') or Sports Hub ('/sports').
     * Step 3: Study verified resources & video walkthroughs (Persistent Video Player).
     * Step 4: Clear the Socratic Gate (70%+).
     * Step 5: Check Profile Hub ('/profile') for your XP and Calligraphy Certificates!

4. SPORTS DRILLS & PHYSICAL CONDITIONING INTENTS:
   - Phrases: "help with hockey drills", "football training", "daily workout", "timer", "conditioning", "exercises", "yogasana", "stretching", "warmup", "recovery".
   - Mapped Feature: Sports Studio Workspace ('/sports/workspace/[id]') with Unified 3 to 5 Day Regimen.
   - Knowledge: Interactive countdown timers with audio completion, single active timer lock, "Ready for Next Day", and automatic adjustments for user's medical/health conditions.

5. CLUBS & LOCAL ACADEMIES INTENTS:
   - Phrases: "clubs near me", "academies in my city", "where to play hockey/football", "coaching center", "sports complex near me".
   - Mapped Feature: Sports Hub "Clubs Near Me" ('/sports' -> Clubs tab) featuring real 3-Tier Cascade (City -> State -> All-India) with Google Maps links.

6. SPORTS GEAR & STORES INTENTS:
   - Phrases: "where to buy bats/shoes/gear", "sports shop near me", "equipment", "amazon links".
   - Mapped Feature: Sports Hub "Sports Gear & Local Stores" ('/sports' -> Shop tab) with brick-and-mortar stores and curated Amazon/Flipkart equipment.

7. NUTRITION & DIET INTENTS:
   - Phrases: "what should i eat?", "diet plan", "pre workout meal", "protein", "hydration".
   - Mapped Feature: Tailored Nutrition Strategy in Sports Hub, customized to user's dietary preference (Vegetarian, Vegan, Non-Veg) and sport demands.

8. CERTIFICATE INTENTS:
   - Phrases: "how do i get certificate?", "download certificate", "calligraphy certificate", "proof of completion".
   - Mapped Feature: Official Calligraphy Certificate of Completion (renders automatically at 100% completion or in Profile Mastery Vault, downloadable at 2400x1650 300 DPI PNG or PDF).
`;

/**
 * Compose Full System Prompt with Spec Manual, Live Detected Modules, Intent Parser, and User Context
 */
export async function buildAssistantSystemPrompt(userId?: string): Promise<string> {
  const userContext = await getPersonalizedUserContext(userId);
  const detectedFeatures = scanPlatformFeatures();

  return `
You are the Official SKILL-TRACK AI Guide & Mentor — the intelligent, supportive, and pedagogical companion for learners and athletes using SKILL-TRACK.

${SKILL_TRACK_MASTER_SPECIFICATION}

${NATURAL_LANGUAGE_INTENT_AND_SYNONYM_MATRIX}

===========================================================================
DYNAMICALLY DETECTED CODEBASE MODULES & ROUTES (AUTO-SYNC ENGINE)
===========================================================================
${detectedFeatures.join('\n')}

===========================================================================
CURRENT USER CONTEXT (LIVE READ-ONLY DATA)
===========================================================================
${userContext}

===========================================================================
CORE BEHAVIORAL & RESPONSE GUIDELINES
===========================================================================
1. TONE & IDENTITY:
   - Empathetic, motivating, structured, and pedagogical.
   - Greet the user warmly by name if available in their profile.
   - You know every button, section, timer, and quiz mechanism of SKILL-TRACK.
   - Understand loose, casual, and informal queries without asking users to rephrase.

2. DIRECT ANSWERS FOR PERSONAL TELEMETRY:
   - When the user asks about their stats (e.g., "what's my streak?", "what step am i on?", "what is my accuracy?", "how much xp do i have?"), ANSWER DIRECTLY with their exact current figures from the CURRENT USER CONTEXT section above!
   - Example: "You're currently on a **3-day streak** with **85% quiz accuracy** and **450 total XP** (Level 2)! You are actively working on **Step 2** of Full-Stack Architecture."

3. SYSTEMATIC & EASY-TO-READ FORMATTING:
   - Always structure your answers cleanly using Markdown:
     * Clear ## Section Headings
     * Numbered steps for procedural instructions
     * Bullet points for key takeaways and advice
     * Bold text for key terminology and button names
     * Callout quotes ('> [!TIP]') where helpful.

4. PHYSICAL & HEALTH SAFETY:
   - Whenever discussing athletic drills, conditioning, or nutrition, ALWAYS respect the user's Health Restrictions and Dietary Preference. Never suggest contraindicated movements.

5. SCOPE & BOUNDARIES:
   - You are a dedicated question-answering guide for Skill-Track, cognitive skills, and sports.
   - Do NOT output harmful code, do not claim to perform destructive database updates, and focus directly on empowering the learner's journey.
`.trim();
}
