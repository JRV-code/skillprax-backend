import prisma from '../../lib/prisma';
import {
  LEARNING_CONFIG,
  DIFFICULTY_TIERS,
  MASTERY_END_TIER,
  EXPERIENCE_START_TIER,
  tierForStepRange,
  stepRangeHint,
  calculatePersonalizedStepBounds,
} from '../../config/learning';
import { callGroqJson, assertNoUrls } from './foundation';

export interface TrajectoryInput {
  section: 'SKILLS' | 'SPORTS';
  domain: string;
  skill: string;
  subGenre: string;
  desiredLevel: string;
  currentExperience: string;
  dailyMinutes: number;
  profileId?: string;
}

export interface TrajectoryStep {
  title: string;
}

export interface TrajectoryOutput {
  stepCount: number;
  stepCountReason: string;
  steps: TrajectoryStep[];
}

export async function generateMasteryTrajectory(input: TrajectoryInput) {
  const {
    section,
    domain,
    skill,
    subGenre,
    desiredLevel,
    currentExperience,
    dailyMinutes,
    profileId = 'default-profile',
  } = input;

  const startIdx = EXPERIENCE_START_TIER[currentExperience] ?? 0;
  const endIdx = MASTERY_END_TIER[desiredLevel] ?? 2;
  const gap = Math.max(0, endIdx - startIdx);
  const { minSteps, maxSteps, recommendedTarget } = calculatePersonalizedStepBounds({
    skillName: skill,
    subGenre,
    domain,
    startTierIdx: startIdx,
    endTierIdx: endIdx,
    dailyMinutes,
  });
  const hint = [minSteps, maxSteps] as [number, number];
  const startTier = DIFFICULTY_TIERS[startIdx];
  const endTier = DIFFICULTY_TIERS[endIdx];

  const systemPrompt = `You are the Curriculum Architect for SKILL-TRACK. You design one learner's mastery trajectory as an ordered list of milestone TITLES only.
CRITICAL MILESTONE COUNT MANDATE:
For this specific learner and skill ("${skill}" - "${subGenre}"), you MUST generate EXACTLY ${recommendedTarget} progressive milestones (stepIndex 1 through ${recommendedTarget}) in the "steps" array and set "stepCount": ${recommendedTarget}.
DO NOT default to 4 steps unless ${recommendedTarget} === 4!
Based on the intrinsic depth of '${skill}' (${subGenre}), the learner's progression from '${currentExperience}' to '${desiredLevel}', and their ${dailyMinutes} min/day schedule, exactly ${recommendedTarget} milestones are required.
Rules:
- The count must be EXACTLY ${recommendedTarget} steps.
- The FIRST milestone starts at the learner's current level (never re-teach what they already know).
- The LAST reaches the desired mastery level.
- Each title is specific, 4-80 characters, names a concrete capability or concept (never 'Introduction', 'Overview', 'Basics', 'Advanced Topics', 'Conclusion'), contains no numbering and no 'Step N'.
- Titles must not overlap each other and must form a clear progression where each builds on the previous.
- For physical activities (section SPORTS) include safety and conditioning where relevant.
Return ONLY JSON:
{ "stepCount": ${recommendedTarget}, "stepCountReason": "<=160 chars explaining why exactly ${recommendedTarget} milestones are calibrated", "steps": [ { "title": "..." } ] }`;

  const userPayload = {
    section,
    domain,
    skill,
    subGenre,
    desiredLevel,
    currentExperience,
    dailyMinutes,
    startTier,
    endTier,
    recommendedStepCount: recommendedTarget,
    stepRangeBounds: [minSteps, maxSteps],
    suggestedStepRange: [minSteps, maxSteps],
  };

  // Redacted log verifying all six enrollment inputs reach Groq (Test T1)
  console.log('[Trajectory:GroqPrompt] Input variables verified:', {
    domain,
    skill: skill.slice(0, 3) + '***',
    subGenre: subGenre.slice(0, 3) + '***',
    desiredLevel,
    currentExperience,
    dailyMinutes,
    gap,
    hint,
    recommendedTarget,
  });

  let trajectory: TrajectoryOutput;
  try {
    trajectory = await callGroqJson<TrajectoryOutput>(
      systemPrompt,
      JSON.stringify(userPayload),
      {
        validate: (data: any) => {
          assertNoUrls(data, 'Trajectory Generation');

          if (typeof data?.stepCount !== 'number') {
            throw new Error('stepCount must be a number');
          }
          if (!Array.isArray(data?.steps)) {
            throw new Error('steps must be an array');
          }
          if (data.stepCount !== data.steps.length) {
            throw new Error(`stepCount (${data.stepCount}) does not match steps array length (${data.steps.length})`);
          }
          if (
            data.stepCount < LEARNING_CONFIG.STEPS_MIN ||
            data.stepCount > LEARNING_CONFIG.STEPS_MAX
          ) {
            throw new Error(
              `stepCount must be between ${LEARNING_CONFIG.STEPS_MIN} and ${LEARNING_CONFIG.STEPS_MAX}`
            );
          }

          const seenTitles = new Set<string>();
          const forbiddenPattern = /^(introduction|overview|basics?|advanced topics?|conclusion)$/i;

          for (let i = 0; i < data.steps.length; i++) {
            const s = data.steps[i];
            if (!s || typeof s.title !== 'string') {
              throw new Error(`Step ${i + 1} title must be a string`);
            }
            const cleanTitle = s.title.trim().replace(/^Step \d+:\s*/i, '');
            if (cleanTitle.length < 4 || cleanTitle.length > 80) {
              throw new Error(`Step title "${cleanTitle}" length must be between 4 and 80 characters`);
            }
            if (forbiddenPattern.test(cleanTitle)) {
              throw new Error(`Step title "${cleanTitle}" is too generic. Must be a concrete milestone.`);
            }
            const lower = cleanTitle.toLowerCase();
            if (seenTitles.has(lower)) {
              throw new Error(`Duplicate step title detected: "${cleanTitle}"`);
            }
            seenTitles.add(lower);
            s.title = cleanTitle;
          }

          return {
            stepCount: data.stepCount,
            stepCountReason: String(data.stepCountReason || `${data.stepCount} progressive milestones to reach ${desiredLevel}`).slice(0, 160),
            steps: data.steps.map((s: any) => ({ title: s.title.trim() })),
          };
        },
        temperature: 0.3,
        maxTokens: 600,
      }
    );
  } catch (groqErr) {
    console.warn('[Trajectory:GroqPrompt] Groq call failed, utilizing calibrated fallback:', groqErr);
    const fallbackTemplates = [
      `Foundational Core Invariants & Mental Models for ${skill}`,
      `Isolated Execution Mechanics & Basic Drills in ${subGenre}`,
      `Dynamic Rhythm, Fluidity, & Procedural Synthesis in ${skill}`,
      `Error Diagnostics, Misconceptions, & Situational Recovery`,
      `Advanced Integrated Execution & High-Complexity Workflows`,
      `Elite Nuance Optimization & Autonomous Mastery in ${skill}`,
    ];
    const chosenSteps = fallbackTemplates.slice(0, recommendedTarget).map((title) => ({ title }));
    trajectory = {
      stepCount: chosenSteps.length,
      stepCountReason: `Calibrated ${chosenSteps.length}-milestone trajectory for ${desiredLevel} in ${subGenre}`,
      steps: chosenSteps,
    };
  }

  // Persist in ONE transaction: Workspace and Steps (Milestone titles ONLY)
  // NO ACUs, resources, or quizzes created now.
  const result = await prisma.$transaction(async (tx) => {
    const ws = await tx.workspace.create({
      data: {
        title: skill,
        skillName: skill,
        subTitle: `${subGenre} Mastery Trajectory`,
        domain,
        domainCategory: domain,
        subGenre,
        level: desiredLevel.toLowerCase(),
        desiredLevel,
        targetGoal: `${desiredLevel} in ${subGenre}`,
        dailyMinutes,
        experienceLevel: currentExperience,
        stepCountReason: trajectory.stepCountReason,
        totalPlannedSteps: trajectory.stepCount,
        currentStep: 1,
        progress: 0,
        userProfileId: profileId,
        isGenerating: false,
      },
    });

    const stepRows = await Promise.all(
      trajectory.steps.map((st, idx) => {
        const stepNum = idx + 1;
        const tier = tierForStepRange(stepNum, trajectory.stepCount, startIdx, endIdx);
        return tx.skillStep.create({
          data: {
            workspaceId: ws.id,
            stepIndex: stepNum,
            title: st.title,
            description: `Milestone ${stepNum} of ${trajectory.stepCount}`,
            difficultyTier: tier,
            status: stepNum === 1 ? 'NOT_BUILT' : 'LOCKED',
            packStatus: 'NOT_BUILT',
            quizStatus: 'NOT_BUILT',
            assessableUnits: [] as any,
            resources: [] as any,
            quizBlueprint: [] as any,
          },
        });
      })
    );

    return { workspace: ws, steps: stepRows };
  }, { maxWait: 15000, timeout: 60000 });

  return {
    workspaceId: result.workspace.id,
    workspace: result.workspace,
    steps: result.steps,
    stepCount: trajectory.stepCount,
    stepCountReason: trajectory.stepCountReason,
  };
}
