import { FastifyInstance, FastifyPluginAsync } from "fastify";
import prisma from "../lib/prisma";

function getTodayString(): string {
  return new Date().toISOString().split("T")[0];
}

function getYesterdayString(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split("T")[0];
}

function getTwoDaysAgoString(): string {
  const d = new Date();
  d.setDate(d.getDate() - 2);
  return d.toISOString().split("T")[0];
}

export const profileRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // ─── Helper ────────────────────────────────────────────────────────────────
  async function getOrCreateProfile(profileId: string) {
    let profile = await prisma.userProfile.findUnique({
      where: { id: profileId },
    });
    if (!profile) {
      profile = await prisma.userProfile.create({
        data: {
          id: profileId,
          name: "Skillprax Learner",
          age: 18,
          profession: "Full-Stack Builder",
          targetDailyHours: 1,
          targetDailyMinutes: 0,
          reminderTime: "20:00",
        },
      });
    }
    return profile;
  }

  // ─── GET /api/profile ──────────────────────────────────────────────────────
  fastify.get("/api/profile", async (req, reply) => {
    const { profileId = "default-profile" } = req.query as { profileId?: string };
    try {
      const profile = await getOrCreateProfile(profileId);
      const today = getTodayString();

      // Fetch last 7 days of activity logs
      const rawLogs = await prisma.dailyActivityLog.findMany({
        where: { userProfileId: profileId },
        orderBy: { date: "desc" },
        take: 7,
      });

      // Build continuous 7-day window
      const history: Array<{
        date: string;
        day: string;
        minutes: number;
        hours: number;
      }> = [];

      for (let i = 6; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const dateStr = d.toISOString().split("T")[0];
        const dayName = d.toLocaleDateString("en-US", { weekday: "short" });
        const existing = rawLogs.find((l: any) => l.date === dateStr);
        const mins = existing ? existing.minutesSpent : 0;
        history.push({
          date: dateStr,
          day: dayName,
          minutes: mins,
          hours: Number((mins / 60).toFixed(1)),
        });
      }

      const todayLog = history.find((h) => h.date === today);
      const todayMinutes = todayLog ? todayLog.minutes : 0;

      // Workspace mastery summary
      const workspaces = await prisma.workspace.findMany({
        where: { userProfileId: profileId },
        orderBy: { updatedAt: "desc" },
        include: {
          steps: {
            select: { id: true, stepIndex: true, status: true, title: true },
            orderBy: { stepIndex: "asc" },
          },
        },
      });

      let totalMilestonesPassed = 0;
      let skillsMastered = 0;
      let skillsInProgress = 0;

      const skillCards = workspaces.map((ws: any) => {
        const steps = ws.steps || [];
        const totalSteps = ws.totalPlannedSteps || 5;
        const passedCount = steps.filter((s: any) => s.status === "PASSED").length;
        const progress = Math.round((passedCount / totalSteps) * 100);
        const currentStep = passedCount < totalSteps ? passedCount + 1 : totalSteps;
        const isMastered = passedCount === totalSteps;

        totalMilestonesPassed += passedCount;
        if (isMastered) skillsMastered++;
        else skillsInProgress++;

        return {
          id: ws.id,
          title: ws.title,
          domainCategory: ws.domainCategory,
          targetGoal: ws.targetGoal,
          level: ws.level,
          totalSteps,
          completedSteps: passedCount,
          currentStep,
          progress,
          isMastered,
        };
      });

      // App tenure
      const now = new Date();
      const joinedDate = new Date(profile.createdAt);
      const diffDays = Math.floor((now.getTime() - joinedDate.getTime()) / (1000 * 60 * 60 * 24));
      const diffMonths = Math.floor(diffDays / 30);
      let tenureText = `${diffDays} days active`;
      if (diffMonths >= 1) tenureText = `${diffMonths} month${diffMonths > 1 ? "s" : ""} active`;
      else if (diffDays === 0) tenureText = "Joined today";

      const dailyGoalTotalMinutes = (profile.targetDailyHours * 60) + profile.targetDailyMinutes;

      return reply.status(200).send({
        profile: {
          id: profile.id,
          name: profile.name,
          age: profile.age,
          profession: profile.profession,
          targetDailyHours: profile.targetDailyHours,
          targetDailyMinutes: profile.targetDailyMinutes,
          reminderTime: profile.reminderTime || "20:00",
          tenureText,
        },
        streak: {
          currentStreak: profile.currentStreak,
          longestStreak: profile.longestStreak,
          streakFreezes: profile.streakFreezes,
          isFreezeActive: profile.streakFreezes > 0,
        },
        telemetry: {
          todayMinutes,
          todayHours: Number((todayMinutes / 60).toFixed(1)),
          targetDailyMinutes: dailyGoalTotalMinutes,
          targetDailyHours: Number((dailyGoalTotalMinutes / 60).toFixed(1)),
          goalCompleted: todayMinutes >= dailyGoalTotalMinutes,
          history,
        },
        stats: {
          totalSkills: workspaces.length,
          skillsInProgress,
          skillsMastered,
          totalMilestonesPassed,
        },
        skillCards,
      });
    } catch (err: any) {
      fastify.log.error(err, "[GET /api/profile] Failed");
      return reply.status(500).send({ error: "Failed to retrieve profile data" });
    }
  });

  // ─── POST /api/activity/heartbeat ─────────────────────────────────────────
  fastify.post("/api/activity/heartbeat", async (req, reply) => {
    const { profileId = "default-profile" } = (req.body || {}) as { profileId?: string };
    try {
      const today = getTodayString();
      const yesterday = getYesterdayString();
      const twoDaysAgo = getTwoDaysAgoString();

      const profile = await getOrCreateProfile(profileId);

      // Upsert today's log (+1 minute per ping)
      const updatedLog = await prisma.dailyActivityLog.upsert({
        where: {
          userProfileId_date: {
            userProfileId: profileId,
            date: today,
          },
        },
        create: {
          userProfileId: profileId,
          date: today,
          minutesSpent: 1,
        },
        update: {
          minutesSpent: { increment: 1 },
        },
      });

      // Recalculate streak only if today is a newly initiated active day
      if (profile.lastActiveDate !== today) {
        let newStreak: number = profile.currentStreak;
        let newFreezes: number = profile.streakFreezes;

        if (!profile.lastActiveDate) {
          newStreak = 1;
        } else if (profile.lastActiveDate === yesterday) {
          newStreak += 1;
        } else if (profile.lastActiveDate === twoDaysAgo) {
          if (newFreezes > 0) {
            newFreezes -= 1;
            newStreak += 1;
          } else {
            newStreak = 1;
          }
        } else {
          newStreak = 1;
        }

        // Grant 1 freeze shield at every multiple of 7
        if (newStreak >= 7 && newStreak % 7 === 0 && newFreezes === 0) {
          newFreezes = 1;
        }

        const newLongest = Math.max(profile.longestStreak, newStreak);

        await prisma.userProfile.update({
          where: { id: profileId },
          data: {
            currentStreak: newStreak,
            longestStreak: newLongest,
            streakFreezes: newFreezes,
            lastActiveDate: today,
          },
        });
      }

      return reply.status(200).send({ success: true, todayMinutes: updatedLog.minutesSpent });
    } catch (err: any) {
      fastify.log.error(err, "[POST /api/activity/heartbeat] Failed");
      return reply.status(500).send({ error: "Failed to record activity heartbeat" });
    }
  });

  // ─── PATCH /api/profile ────────────────────────────────────────────────────
  fastify.patch("/api/profile", async (req, reply) => {
    try {
      const body = (req.body || {}) as {
        profileId?: string;
        name?: string;
        age?: number;
        profession?: string;
        targetDailyHours?: number;
        targetDailyMinutes?: number;
        reminderTime?: string;
      };

      const profileId = body.profileId || "default-profile";

      const dataToUpdate: any = {};
      if (typeof body.name === "string" && body.name.trim()) dataToUpdate.name = body.name.trim();
      if (body.age !== undefined && !isNaN(Number(body.age))) dataToUpdate.age = Number(body.age);
      if (typeof body.profession === "string" && body.profession.trim()) dataToUpdate.profession = body.profession.trim();
      if (body.targetDailyHours !== undefined && !isNaN(Number(body.targetDailyHours))) {
        dataToUpdate.targetDailyHours = Math.max(0, Number(body.targetDailyHours));
      }
      if (body.targetDailyMinutes !== undefined && !isNaN(Number(body.targetDailyMinutes))) {
        dataToUpdate.targetDailyMinutes = Math.max(0, Number(body.targetDailyMinutes));
      }
      if (typeof body.reminderTime === "string") dataToUpdate.reminderTime = body.reminderTime;

      const updated = await prisma.userProfile.upsert({
        where: { id: profileId },
        create: {
          id: profileId,
          name: dataToUpdate.name || "Learner",
          age: dataToUpdate.age || 18,
          profession: dataToUpdate.profession || "Engineer",
          targetDailyHours: dataToUpdate.targetDailyHours || 1,
          targetDailyMinutes: dataToUpdate.targetDailyMinutes || 0,
          reminderTime: dataToUpdate.reminderTime || "20:00",
        },
        update: dataToUpdate,
      });

      return reply.status(200).send(updated);
    } catch (err: any) {
      fastify.log.error(err, "[PATCH /api/profile] Failed");
      return reply.status(500).send({ error: "Failed to update profile settings" });
    }
  });
};

export default profileRoutes;
