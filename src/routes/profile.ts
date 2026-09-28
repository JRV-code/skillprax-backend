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
  async function getOrCreateProfile() {
    let profile = await (prisma as any).userProfile.findUnique({
      where: { id: "default-profile" },
    });
    if (!profile) {
      profile = await (prisma as any).userProfile.create({
        data: {
          id: "default-profile",
          name: "Skillprax Learner",
          age: 18,
          profession: "Full-Stack Builder",
          targetDailyMinutes: 60,
          reminderTime: "20:00",
        },
      });
    }
    return profile;
  }

  // ─── GET /api/profile ──────────────────────────────────────────────────────
  fastify.get("/api/profile", async (_req, reply) => {
    try {
      const profile = await getOrCreateProfile();
      const today = getTodayString();

      // Fetch last 7 days of activity logs
      const rawLogs = await (prisma as any).dailyActivityLog.findMany({
        where: { userProfileId: "default-profile" },
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
        const totalSteps = Math.max(steps.length, 1);
        const passedCount = steps.filter((s: any) => s.status === "PASSED").length;
        const progress = Math.round((passedCount / totalSteps) * 100);
        const isMastered = steps.length > 0 && passedCount === steps.length;

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
          currentStep: ws.currentStep || (passedCount < totalSteps ? passedCount + 1 : totalSteps),
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

      return reply.status(200).send({
        profile: {
          name: profile.name,
          age: profile.age,
          profession: profile.profession,
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
          targetDailyMinutes: profile.targetDailyMinutes,
          targetDailyHours: Number((profile.targetDailyMinutes / 60).toFixed(1)),
          goalCompleted: todayMinutes >= profile.targetDailyMinutes,
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
  fastify.post("/api/activity/heartbeat", async (_req, reply) => {
    try {
      const today = getTodayString();
      const yesterday = getYesterdayString();
      const twoDaysAgo = getTwoDaysAgoString();

      const profile = await getOrCreateProfile();

      // Upsert today's log (+1 minute per ping)
      const updatedLog = await (prisma as any).dailyActivityLog.upsert({
        where: {
          userProfileId_date: {
            userProfileId: "default-profile",
            date: today,
          },
        },
        create: {
          userProfileId: "default-profile",
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

        await (prisma as any).userProfile.update({
          where: { id: "default-profile" },
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
        name?: string;
        age?: number;
        profession?: string;
        targetDailyMinutes?: number;
        reminderTime?: string;
      };

      const dataToUpdate: any = {};
      if (typeof body.name === "string" && body.name.trim()) dataToUpdate.name = body.name.trim();
      if (body.age !== undefined && !isNaN(Number(body.age))) dataToUpdate.age = Number(body.age);
      if (typeof body.profession === "string" && body.profession.trim()) dataToUpdate.profession = body.profession.trim();
      if (body.targetDailyMinutes !== undefined && !isNaN(Number(body.targetDailyMinutes))) {
        dataToUpdate.targetDailyMinutes = Math.max(15, Number(body.targetDailyMinutes));
      }
      if (typeof body.reminderTime === "string") dataToUpdate.reminderTime = body.reminderTime;

      const updated = await (prisma as any).userProfile.upsert({
        where: { id: "default-profile" },
        create: {
          id: "default-profile",
          name: dataToUpdate.name || "Learner",
          age: dataToUpdate.age || 18,
          profession: dataToUpdate.profession || "Engineer",
          targetDailyMinutes: dataToUpdate.targetDailyMinutes || 60,
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
