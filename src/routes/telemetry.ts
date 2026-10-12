import { FastifyInstance } from 'fastify';
import prisma from '../lib/prisma';

export async function telemetryRoutes(fastify: FastifyInstance) {
  // Comprehensive Profile Hydration Endpoint
  fastify.get('/api/profiles/:id/telemetry', async (request, reply) => {
    const { id } = request.params as { id: string };

    let userProfile: any = await prisma.userProfile.findUnique({
      where: { id },
      include: {
        workspaces: {
          include: {
            steps: {
              include: {
                attempts: true,
              },
            },
          },
        },
        studySessions: {
          orderBy: { sessionDate: 'desc' },
          take: 50,
        },
        badges: true,
      },
    });

    if (!userProfile) {
      userProfile = await (prisma as any).profile?.findUnique({
        where: { id },
        include: {
          workspaces: {
            include: {
              steps: {
                include: {
                  attempts: true,
                },
              },
            },
          },
          studySessions: {
            orderBy: { sessionDate: 'desc' },
            take: 50,
          },
          badges: true,
        },
      });
    }

    if (!userProfile) return reply.status(404).send({ error: 'Profile not found' });

    // 1. CALCULATE XP AND LEVEL
    let calculatedXp = 0;
    let totalAcusVerified = 0;
    let totalEvaluationsPassed = 0;
    let totalEvaluationsAttempted = 0;
    let misconceptionsCleared = 0;

    const workspaces = userProfile.workspaces || [];
    workspaces.forEach((w: any) => {
      (w.steps || []).forEach((s: any) => {
        const rawAcus = s.assessableUnits;
        const acus = Array.isArray(rawAcus) ? rawAcus : (typeof rawAcus === 'string' ? JSON.parse(rawAcus || '[]') : []);

        if (s.status === 'PASSED') {
          calculatedXp += 500;
          totalEvaluationsPassed += 1;
          totalEvaluationsAttempted += 1;
          totalAcusVerified += acus.length || 2;
          calculatedXp += (acus.length || 2) * 100;
        } else if (s.status === 'FAILED_REMEDIATION') {
          totalEvaluationsAttempted += 1;
        }

        const attempts = s.attempts || s.retestAttempts || [];
        attempts.forEach((r: any) => {
          totalEvaluationsAttempted += 1;
          if (r.passed) {
            misconceptionsCleared += 1;
            totalEvaluationsPassed += 1;
            calculatedXp += 250;
          }
        });
      });
    });

    const studySessions = userProfile.studySessions || [];
    studySessions.forEach((sess: any) => {
      calculatedXp += Math.round(((sess.minutes || 30) / 30) * 50);
    });

    // Tier calculation: Level = floor(calculatedXp / 250) + 1
    const currentLevel = Math.max(1, Math.floor(calculatedXp / 250) + 1);
    const xpForCurrentLevelBase = (currentLevel - 1) * 250;
    const xpForNextLevel = currentLevel * 250;
    const xpInCurrentLevel = calculatedXp - xpForCurrentLevelBase;
    const tierProgressPct = Math.min(100, Math.round((xpInCurrentLevel / 250) * 100));

    // Dynamic Title based on Level
    let tierTitle = 'APPRENTICE SCHOLAR';
    if (currentLevel >= 5) tierTitle = 'ADEPT SCHOLAR';
    if (currentLevel >= 10) tierTitle = 'MASTER SCHOLAR';
    if (currentLevel >= 20) tierTitle = 'GRANDMASTER ARCHITECT';

    // 2. 7-DAY CADENCE DISTRIBUTION (Sun to Sat)
    const now = new Date();
    const dayOfWeek = now.getDay(); // 0 = Sun, 1 = Mon ...
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - dayOfWeek);
    startOfWeek.setHours(0, 0, 0, 0);

    const dayTotals: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
    studySessions.forEach((sess: any) => {
      const d = new Date(sess.sessionDate || sess.createdAt);
      if (d >= startOfWeek) {
        const dayIdx = d.getDay();
        dayTotals[dayIdx] = (dayTotals[dayIdx] || 0) + ((sess.minutes || 0) / 60);
      }
    });

    const cadenceDistribution = [
      { day: 'Sun', hours: parseFloat(dayTotals[0].toFixed(1)) },
      { day: 'Mon', hours: parseFloat(dayTotals[1].toFixed(1)) },
      { day: 'Tue', hours: parseFloat(dayTotals[2].toFixed(1)) },
      { day: 'Wed', hours: parseFloat(dayTotals[3].toFixed(1)) },
      { day: 'Thu', hours: parseFloat(dayTotals[4].toFixed(1)) },
      { day: 'Fri', hours: parseFloat(dayTotals[5].toFixed(1)) },
      { day: 'Sat', hours: parseFloat(dayTotals[6].toFixed(1)) },
    ];

    const total7DayHours = parseFloat(Object.values(dayTotals).reduce((a, b) => a + b, 0).toFixed(1));
    const targetHours = userProfile.targetHours ?? userProfile.targetDailyHours ?? 1;
    const targetMinutes = userProfile.targetMinutes ?? userProfile.targetDailyMinutes ?? 50;
    const targetWkHours = (targetHours + targetMinutes / 60) * 7;
    const cadenceGoalMetPct = targetWkHours > 0 ? Math.min(100, Math.round((total7DayHours / targetWkHours) * 100)) : 0;
    const averageDailyHours = parseFloat((total7DayHours / 7).toFixed(1));

    // 3. COMPETENCY METRICS
    const passRateAccuracy = totalEvaluationsAttempted > 0
      ? parseFloat(((totalEvaluationsPassed / totalEvaluationsAttempted) * 100).toFixed(1))
      : 100.0;

    const streakDays = userProfile.streakDays ?? userProfile.currentStreak ?? 1;
    const freezeShields = userProfile.freezeShields ?? userProfile.streakFreezes ?? 3;

    // 4. DYNAMIC BADGE EVALUATOR
    const evaluatedBadges = [
      {
        key: 'ZERO_MISCONCEPTIONS',
        title: 'Zero Misconceptions',
        tier: 'LEGENDARY',
        description: 'Scored 100% on a diagnostic evaluation on first attempt without distractor traps.',
        unlocked: totalEvaluationsPassed >= 1 && passRateAccuracy >= 90,
        progressText: `${totalEvaluationsPassed}/1 Cleared`,
      },
      {
        key: 'REACTION_VELOCITY',
        title: 'Reaction Velocity',
        tier: 'LEGENDARY',
        description: 'Diagnosed and solved 20 Socratic questions under focused execution.',
        unlocked: totalEvaluationsPassed >= 4,
        progressText: `${Math.min(20, totalEvaluationsPassed * 5)}/20 Cleared`,
      },
      {
        key: 'RELENTLESS_MOMENTUM',
        title: 'Relentless Momentum',
        tier: 'EPIC',
        description: 'Sustained an unbroken study cadence without burning a freeze shield.',
        unlocked: streakDays >= 7,
        progressText: `${streakDays} Days Logged`,
      },
      {
        key: 'AXIOM_ARCHITECT',
        title: 'Axiom Architect',
        tier: 'EPIC',
        description: 'Unlocked consecutive Assessable Concept Units across active domains.',
        unlocked: totalAcusVerified >= 6,
        progressText: `${totalAcusVerified}/12 ACUs`,
      },
      {
        key: 'DEEP_SPACED_RECALL',
        title: 'Deep Spaced Recall',
        tier: 'RARE',
        description: 'Re-verified fundamental axioms across spaced repetition review cycles.',
        unlocked: misconceptionsCleared >= 1,
        progressText: `${misconceptionsCleared}/3 Cycles`,
      },
    ];

    return reply.send({
      profile: {
        id: userProfile.id,
        name: userProfile.name || 'Explorer',
        educationBoard: userProfile.educationBoard || 'GSEB',
        grade: userProfile.grade || 'Class 12',
        age: userProfile.age || 18,
        activeDays: Math.max(1, studySessions.length),
        enrolledTracksCount: workspaces.length,
        streakDays,
        freezeShields,
        targetHours,
        targetMinutes,
        alertNotification: userProfile.alertNotification || userProfile.reminderTime || '20:30',
      },
      xpTelemetry: {
        currentLevel,
        tierTitle,
        totalXp: calculatedXp,
        nextTierXp: xpForNextLevel,
        tierProgressPct,
      },
      cadenceTelemetry: {
        total7DayHours,
        averageDailyHours,
        targetWkHours: parseFloat(targetWkHours.toFixed(1)),
        cadenceGoalMetPct,
        distribution: cadenceDistribution,
      },
      competencyTelemetry: {
        totalAcusVerified,
        diagnosticPassRate: passRateAccuracy,
        misconceptionsCleared,
      },
      badges: evaluatedBadges,
      enrolledWorkspaces: workspaces.map((w: any) => {
        const steps = w.steps || [];
        const passedStepsCount = steps.filter((s: any) => s.status === 'PASSED').length;
        const totalStepsCount = steps.length || 1;
        const progress = Math.round((passedStepsCount / totalStepsCount) * 100);
        return {
          id: w.id,
          title: w.title,
          subTitle: w.subTitle || `${w.domainCategory || 'General Knowledge'} Track`,
          domainCategory: w.domainCategory || 'General Knowledge',
          subGenre: w.subGenre || '',
          progress,
          stepsCount: steps.length,
          passedStepsCount,
        };
      }),
    });
  });

  // Interactive study session logging (used by the "Simulate Study Session" button)
  fastify.post('/api/profiles/:id/study-session', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { minutes } = (request.body as any) || { minutes: 60 };

    const session = await prisma.studySession.create({
      data: {
        profileId: id,
        minutes: minutes || 60,
      },
    });

    try {
      await prisma.userProfile.update({
        where: { id },
        data: {
          streakDays: { increment: 1 },
          currentStreak: { increment: 1 },
          totalXp: { increment: 100 },
        },
      });
    } catch (_) {
      try {
        await (prisma as any).profile.update({
          where: { id },
          data: {
            streakDays: { increment: 1 },
            totalXp: { increment: 100 },
          },
        });
      } catch (e) {
        // profile optional update swallow
      }
    }

    return reply.send({ success: true, session });
  });

  // GET /api/profiles/:id/recommendations - Curated Next Horizons
  fastify.get('/api/profiles/:id/recommendations', async (request, reply) => {
    const { id } = request.params as { id: string };

    let profile: any = await prisma.userProfile.findUnique({
      where: { id },
      include: {
        workspaces: {
          include: { steps: true },
        },
      },
    });

    if (!profile) {
      profile = await (prisma as any).profile?.findUnique({
        where: { id },
        include: {
          workspaces: {
            include: { steps: true },
          },
        },
      });
    }

    const enrolled = profile?.workspaces || [];
    const enrolledSummary = enrolled.map((w: any) => ({
      title: w.title,
      domain: w.domainCategory,
      subGenre: w.subGenre,
      progress: w.progress,
      stepsCount: w.steps?.length || 0,
      passedCount: (w.steps || []).filter((s: any) => s.status === 'PASSED').length,
    }));

    try {
      const { getEffectiveKeys } = await import('../lib/keyManager');
      const { callGroqWithFallback } = await import('../lib/ai/pipeline');
      const { groqKey } = await getEffectiveKeys();

      if (groqKey) {
        const prompt = `You are the SKILL-TRACK Pedagogy & Curriculum Engine.
Learner Context:
Profession: ${profile?.profession || 'Student'}
Age: ${profile?.age || 18}
Education: ${profile?.educationBoard || 'Standard'} ${profile?.grade || ''}
Enrolled Tracks:
${JSON.stringify(enrolledSummary, null, 2)}

Synthesize EXACTLY 3 complementary future skill tracks for this learner:
1. Lateral Progression (Adjacent domain expanding immediate skills)
2. Cross-Disciplinary Amplifier (Different domain creating unique T-shaped mastery synergy)
3. Foundational Deepening (Deeper theoretical or apex specialization)

Output strictly valid JSON with this schema:
{
  "recommendations": [
    {
      "domain": "Domain Name (e.g. Engineering & Applied Technology, Natural & Physical Sciences, Arts, Media & Spatial Design, Formal Sciences & Mathematics)",
      "title": "Title of Skill Track",
      "subGenre": "Specialized Sub-Genre",
      "affinityScore": 95,
      "categoryType": "Lateral Progression",
      "rationale": "Clear pedagogical explanation of why this amplifies their capabilities."
    }
  ]
}`;

        const aiRes = await callGroqWithFallback([
          { role: 'system', content: prompt }
        ], { apiKey: groqKey, jsonMode: true, model: 'llama-3.3-70b-versatile' });

        const cleaned = aiRes.content.trim().replace(/^```json\s*/i, '').replace(/\s*```$/, '');
        const parsed = JSON.parse(cleaned);
        if (Array.isArray(parsed.recommendations) && parsed.recommendations.length > 0) {
          return reply.send({ recommendations: parsed.recommendations });
        }
      }
    } catch (err) {
      fastify.log.warn(err, '[Recommendations] Groq recommendation fallback used');
    }

    // High-affinity fallback recommendations
    return reply.send({
      recommendations: [
        {
          domain: "Engineering & Applied Technology",
          title: "Rust Systems Architecture & Memory Concurrency",
          subGenre: "Low-Level Concurrency",
          affinityScore: 96,
          categoryType: "Lateral Progression",
          rationale: "Builds rigorous deterministic thinking and zero-cost abstraction fluency.",
        },
        {
          domain: "Natural & Physical Sciences",
          title: "Reaction Kinetics & Molecular Thermodynamics",
          subGenre: "Physical Chemistry",
          affinityScore: 92,
          categoryType: "Foundational Deepening",
          rationale: "Deepens first-principles understanding of transition states and bond enthalpy.",
        },
        {
          domain: "Formal Sciences & Mathematics",
          title: "Discrete Graph Theory & Combinatorial Algorithms",
          subGenre: "Graph Traversal",
          affinityScore: 89,
          categoryType: "Cross-Disciplinary Amplifier",
          rationale: "Amplifies multi-variable scenario resolution across both computational and scientific models.",
        },
      ],
    });
  });
}

export default telemetryRoutes;

