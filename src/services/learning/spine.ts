import { prisma } from '../../lib/prisma';
import { LEARNING_CONFIG, tierForStep, DifficultyTier } from '../../config/learning';
import { callGroqJson, titleSimilarity, assertNoUrls } from './foundation';

export interface PlannedChapter {
  key: string;
  orderIndex: number;
  title: string;
  covers: string;
  minutes: number;
  acuIds: string[];
  preferredType: 'VIDEO' | 'DOCUMENT';
  buildsOn: string | null;
  newConcepts: string[];
}

export interface PlannedStepSpine {
  stepIndex: number;
  chapters: PlannedChapter[];
}

export interface CurriculumSpineResult {
  steps: PlannedStepSpine[];
}

function getStepAcus(step: any): Array<{ id: string; title: string; description: string }> {
  const raw = Array.isArray(step.assessableUnits) ? step.assessableUnits : [];
  return raw.map((a: any, idx: number) => ({
    id: a.id || `acu-${idx + 1}`,
    title: a.title || a.label || `Unit ${idx + 1}`,
    description: a.description || `Core unit ${idx + 1}`,
  }));
}

export async function planCurriculumSpine(params: {
  workspaceId: string;
  domain: 'SKILL' | 'SPORT';
  skill: string;
  subGenre?: string;
}): Promise<PlannedStepSpine[]> {
  const steps = await prisma.skillStep.findMany({
    where: { workspaceId: params.workspaceId },
    orderBy: { stepIndex: 'asc' },
    include: { chapters: true },
  });

  if (steps.length === 0) {
    throw new Error('Workspace has no steps to plan spine for');
  }

  // Check if all steps already have chapters populated
  const allHaveChapters = steps.every((s) => s.chapters.length >= LEARNING_CONFIG.CHAPTERS_MIN);
  if (allHaveChapters) {
    return steps.map((s) => ({
      stepIndex: s.stepIndex,
      chapters: s.chapters.map((c) => ({
        key: c.key,
        orderIndex: c.orderIndex,
        title: c.title,
        covers: c.covers,
        minutes: c.minutes,
        acuIds: (c.acuIds as string[]) || [],
        preferredType: c.preferredType as 'VIDEO' | 'DOCUMENT',
        buildsOn: c.buildsOn,
        newConcepts: (c.newConcepts as string[]) || [],
      })),
    }));
  }

  const totalSteps = steps.length;
  const stepContexts = steps.map((s) => {
    const tier = tierForStep(s.stepIndex, totalSteps);
    const acus = getStepAcus(s);
    return {
      stepIndex: s.stepIndex,
      title: s.title,
      tier,
      acus,
    };
  });

  const systemPrompt = `You are the Principal Curriculum Spine Architect for SKILL-TRACK.
You design an integrated multi-step progression where each step teaches NEW, deeper material without repeating concepts.
Domain: ${params.domain}
Skill: ${params.skill}
Sub-genre: ${params.subGenre || 'Core Discipline'}

REQUIREMENTS:
1. Generate distinct chapters for EVERY step in the roadmap simultaneously so steps NEVER overlap.
2. For each step, provide between ${LEARNING_CONFIG.CHAPTERS_MIN} and ${LEARNING_CONFIG.CHAPTERS_MAX} chapters ordered prerequisite-first.
3. Every single ACU in that step MUST be covered in at least one chapter's acuIds array.
4. Titles MUST be specific, practical topics (NEVER generic like "Introduction", "Overview", "Basics", or "Fundamentals of...").
5. NO chapter topic may repeat or restate a chapter from any other step.
6. Progression by Tier:
   - FOUNDATIONS: vocabulary, terminology, rules, safety, core mental models.
   - ELEMENTARY_MECHANICS: basic mechanics, isolated drills, simple combinations, common errors.
   - INTERMEDIATE_FLUIDITY: dynamic rhythm, pacing, variations, transitions, edge cases.
   - ADVANCED_SITUATIONAL_STRESS: high-speed decision making, pressure scenarios, complex real-world integration.
   - ELITE_MASTERY: elite nuances, micro-optimizations, benchmarks, subtle technique.
7. Domain nuance:
   - SPORT: lean to "VIDEO" for physical motor mechanics/drills, and "DOCUMENT" for tactical rules, strategy, conditioning theory.
   - SKILL: balanced mix of "VIDEO" and "DOCUMENT".
8. NO URLs anywhere in your output.
9. Each chapter must have:
   - "key": "c1", "c2", ...
   - "title": specific topic title
   - "covers": one clear sentence describing the specific focus
   - "minutes": integer between 3 and 20
   - "acuIds": array of ACU IDs covered
   - "preferredType": "VIDEO" or "DOCUMENT"
   - "buildsOn": short phrase referencing earlier skills (or empty string for step 1)
   - "newConcepts": array of 2 to 4 specific concepts that appear for the first time in this step
10. Be concise: keep titles and covers descriptions succinct (covers under 20 words each) so the full JSON output fits completely within completion tokens.

Return ONLY a JSON object formatted as:
{
  "steps": [
    {
      "stepIndex": 1,
      "chapters": [
        {
          "key": "c1",
          "title": "...",
          "covers": "...",
          "minutes": 8,
          "acuIds": ["acu_id_1"],
          "preferredType": "VIDEO",
          "buildsOn": "",
          "newConcepts": ["grip torque", "stance width", "load phase"]
        }
      ]
    }
  ]
}`;

  const userPrompt = JSON.stringify({
    domain: params.domain,
    skill: params.skill,
    subGenre: params.subGenre,
    steps: stepContexts,
  });

  const validateSpine = (data: any): CurriculumSpineResult => {
    assertNoUrls(data, 'CurriculumSpine');
    if (!data || !Array.isArray(data.steps) || data.steps.length !== steps.length) {
      throw new Error(`Expected exactly ${steps.length} steps in spine output`);
    }

    const allTitles: string[] = [];

    const plannedSteps: PlannedStepSpine[] = data.steps.map((st: any, sIdx: number) => {
      const targetStep = steps[sIdx];
      if (typeof st.stepIndex !== 'number' || st.stepIndex !== targetStep.stepIndex) {
        throw new Error(`Step index mismatch at index ${sIdx}`);
      }
      if (!Array.isArray(st.chapters)) {
        throw new Error(`Step ${st.stepIndex} chapters is not an array`);
      }
      if (
        st.chapters.length < LEARNING_CONFIG.CHAPTERS_MIN ||
        st.chapters.length > LEARNING_CONFIG.CHAPTERS_MAX
      ) {
        throw new Error(
          `Step ${st.stepIndex} has ${st.chapters.length} chapters; expected between ${LEARNING_CONFIG.CHAPTERS_MIN} and ${LEARNING_CONFIG.CHAPTERS_MAX}`
        );
      }

      const coveredAcuIds = new Set<string>();
      const keysSeen = new Set<string>();

      const chapters: PlannedChapter[] = st.chapters.map((ch: any, cIdx: number) => {
        const key = ch.key || `c${cIdx + 1}`;
        if (keysSeen.has(key)) {
          throw new Error(`Duplicate chapter key ${key} in step ${st.stepIndex}`);
        }
        keysSeen.add(key);

        if (!ch.title || typeof ch.title !== 'string' || ch.title.trim().length < 3) {
          throw new Error(`Invalid chapter title in step ${st.stepIndex} key ${key}`);
        }
        const title = ch.title.trim();
        allTitles.push(title);

        if (!Array.isArray(ch.acuIds) || ch.acuIds.length === 0) {
          throw new Error(`Chapter ${key} in step ${st.stepIndex} has no acuIds`);
        }
        ch.acuIds.forEach((id: string) => coveredAcuIds.add(id));

        const preferredType =
          ch.preferredType === 'VIDEO' || ch.preferredType === 'DOCUMENT'
            ? ch.preferredType
            : cIdx % 2 === 0
            ? 'VIDEO'
            : 'DOCUMENT';

        const minutes =
          typeof ch.minutes === 'number' && ch.minutes >= 3 && ch.minutes <= 30
            ? Math.round(ch.minutes)
            : 10;

        return {
          key,
          orderIndex: cIdx + 1,
          title,
          covers: ch.covers || `Mastery of ${title}`,
          minutes,
          acuIds: ch.acuIds,
          preferredType,
          buildsOn: ch.buildsOn || null,
          newConcepts: Array.isArray(ch.newConcepts) && ch.newConcepts.length >= 2
            ? ch.newConcepts.map(String)
            : [title, 'Core principles'],
        };
      });

      // Check all ACUs covered
      for (const acu of stepContexts[sIdx].acus) {
        if (!coveredAcuIds.has(acu.id)) {
          // If Groq missed one ACU id, attach it to the first chapter rather than throwing fatal error
          chapters[0].acuIds.push(acu.id);
        }
      }

      return {
        stepIndex: targetStep.stepIndex,
        chapters,
      };
    });

    // Cross-step title similarity check: titleSimilarity < 0.7 between every pair
    for (let i = 0; i < allTitles.length; i++) {
      for (let j = i + 1; j < allTitles.length; j++) {
        const sim = titleSimilarity(allTitles[i], allTitles[j]);
        if (sim >= 0.7) {
          throw new Error(
            `Chapters "${allTitles[i]}" and "${allTitles[j]}" are too similar (similarity ${sim.toFixed(2)} >= 0.70)`
          );
        }
      }
    }

    return { steps: plannedSteps };
  };

  let spine: CurriculumSpineResult;
  try {
    spine = await callGroqJson<CurriculumSpineResult>(systemPrompt, userPrompt, {
      validate: validateSpine,
      maxTokens: 5500,
      temperature: 0.2,
      retryCount: 1,
    });
  } catch (err: any) {
    console.warn('[spine] Groq curriculum spine planning failed, falling back to deterministic code planner:', err.message);
    // Deterministic fallback: build one chapter per ACU (or grouped), alternating types
    spine = {
      steps: steps.map((s) => {
        const acus = getStepAcus(s);
        const count = Math.max(
          LEARNING_CONFIG.CHAPTERS_MIN,
          Math.min(LEARNING_CONFIG.CHAPTERS_MAX, acus.length)
        );
        const chapters: PlannedChapter[] = [];
        for (let i = 0; i < count; i++) {
          const acu = acus[i % acus.length];
          chapters.push({
            key: `c${i + 1}`,
            orderIndex: i + 1,
            title: acu.title || `${s.title} Part ${i + 1}`,
            covers: acu.description || `Core mechanics for ${s.title}`,
            minutes: 10,
            acuIds: [acu.id],
            preferredType: i % 2 === 0 ? 'VIDEO' : 'DOCUMENT',
            buildsOn: s.stepIndex > 1 ? `Step ${s.stepIndex - 1} foundations` : null,
            newConcepts: [acu.title || 'Concept 1', 'Practical execution'],
          });
        }
        return {
          stepIndex: s.stepIndex,
          chapters,
        };
      }),
    };
  }

  // Persist spine to DB inside a transaction
  await prisma.$transaction(async (tx) => {
    for (const stepSpine of spine.steps) {
      const step = steps.find((s) => s.stepIndex === stepSpine.stepIndex);
      if (!step) continue;

      const tier = tierForStep(step.stepIndex, totalSteps);
      await tx.skillStep.update({
        where: { id: step.id },
        data: { difficultyTier: tier },
      });

      // Upsert chapters
      for (const ch of stepSpine.chapters) {
        await tx.chapter.upsert({
          where: {
            stepId_key: {
              stepId: step.id,
              key: ch.key,
            },
          },
          create: {
            stepId: step.id,
            key: ch.key,
            orderIndex: ch.orderIndex,
            title: ch.title,
            covers: ch.covers,
            minutes: ch.minutes,
            acuIds: ch.acuIds,
            preferredType: ch.preferredType,
            buildsOn: ch.buildsOn,
            newConcepts: ch.newConcepts,
            status: 'PLANNED',
          },
          update: {
            orderIndex: ch.orderIndex,
            title: ch.title,
            covers: ch.covers,
            minutes: ch.minutes,
            acuIds: ch.acuIds,
            preferredType: ch.preferredType,
            buildsOn: ch.buildsOn,
            newConcepts: ch.newConcepts,
          },
        });
      }
    }
  }, { maxWait: 15000, timeout: 60000 });

  return spine.steps;
}
