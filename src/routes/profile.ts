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

function formatProfilePayload(profile: any) {
  const now = new Date();
  const joinedDate = new Date(profile.createdAt);
  const diffDays = Math.max(1, Math.floor((now.getTime() - joinedDate.getTime()) / (1000 * 60 * 60 * 24)));
  const activeMonths = Math.max(1, Math.floor(diffDays / 30));

  return {
    id: profile.id,
    name: profile.name || "Explorer",
    email: profile.email || null,
    gender: profile.gender || "Prefer not to say",
    age: profile.age || 18,
    profession: profile.profession || "Student",
    educationBoard: profile.educationBoard || "CBSE",
    grade: profile.grade || "Class 12",
    activeMonths,
    streakDays: profile.currentStreak || 0,
    freezeShields: profile.streakFreezes ?? profile.freezeShields ?? 0,
    targetHours: profile.targetDailyHours || 1,
    targetMinutes: profile.targetDailyMinutes || 0,
    alertNotification: profile.reminderTime || "20:30 PM",
    remindersEnabled: profile.remindersEnabled ?? true,
    createdAt: profile.createdAt ? profile.createdAt.toISOString() : new Date().toISOString(),
    updatedAt: profile.updatedAt ? profile.updatedAt.toISOString() : new Date().toISOString(),
  };
}

export const profileRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // Helper to ensure default profile exists
  async function getOrCreateProfile(profileId: string = "default-profile") {
    let profile = await prisma.userProfile.findUnique({
      where: { id: profileId },
    });
    if (!profile) {
      profile = await prisma.userProfile.create({
        data: {
          id: profileId,
          name: "Skillprax Learner",
          email: "learner@skillprax.com",
          gender: "Prefer not to say",
          age: 18,
          profession: "Student",
          educationBoard: "CBSE",
          grade: "Class 12",
          targetDailyHours: 1,
          targetDailyMinutes: 50,
          reminderTime: "20:30",
          currentStreak: 1,
          streakFreezes: 0,
          freezeShields: 0,
          remindersEnabled: true,
        },
      });
    }
    return profile;
  }

  // 1. GET /api/profiles/lookup — Secure single lookup by email or name (No dumping)
  fastify.get("/api/profiles/lookup", async (req, reply) => {
    try {
      const { query } = req.query as { query?: string };
      if (!query || !query.trim()) {
        return reply.status(400).send({ error: "Please enter a Profile Name or Email to search." });
      }

      const cleanQuery = query.trim();
      const profile = await prisma.userProfile.findFirst({
        where: {
          OR: [
            { email: { equals: cleanQuery, mode: "insensitive" } },
            { name: { contains: cleanQuery, mode: "insensitive" } },
            { id: { equals: cleanQuery } },
          ],
        },
      });

      if (!profile) {
        return reply.status(404).send({ error: `No profile found matching "${cleanQuery}".` });
      }

      return reply.status(200).send({ profile: formatProfilePayload(profile) });
    } catch (err: any) {
      fastify.log.error(err, "[GET /api/profiles/lookup] Failed");
      return reply.status(500).send({ error: "Profile lookup failed." });
    }
  });

  // 2. POST /api/auth/google — Authenticate / Sync with Google Account
  fastify.post("/api/auth/google", async (req, reply) => {
    try {
      const body = (req.body || {}) as {
        email: string;
        name?: string;
        avatarUrl?: string;
      };

      if (!body.email || !body.email.trim()) {
        return reply.status(400).send({ error: "Google email is required." });
      }

      const cleanEmail = body.email.trim().toLowerCase();
      let profile = await prisma.userProfile.findFirst({
        where: { email: { equals: cleanEmail, mode: "insensitive" } },
      });

      if (!profile) {
        profile = await prisma.userProfile.create({
          data: {
            name: (body.name || cleanEmail.split("@")[0] || "Learner").trim(),
            email: cleanEmail,
            gender: "Prefer not to say",
            profession: "Student",
            educationBoard: "CBSE",
            grade: "Class 12",
            targetDailyHours: 1,
            targetDailyMinutes: 50,
            reminderTime: "20:30",
            currentStreak: 1,
            streakFreezes: 0,
            freezeShields: 0,
            remindersEnabled: true,
          },
        });
      }

      return reply.status(200).send({ profile: formatProfilePayload(profile) });
    } catch (err: any) {
      fastify.log.error(err, "[POST /api/auth/google] Failed");
      return reply.status(500).send({ error: "Google authentication failed" });
    }
  });

  // 3. GET /api/profiles — List profiles (kept for internal tests, single lookup preferred)
  fastify.get("/api/profiles", async (req, reply) => {
    try {
      let profiles = await prisma.userProfile.findMany({
        orderBy: { createdAt: "asc" },
      });

      if (profiles.length === 0) {
        const defaultProf = await getOrCreateProfile("default-profile");
        profiles = [defaultProf];
      }

      const formatted = profiles.map(formatProfilePayload);
      return reply.status(200).send({ profiles: formatted });
    } catch (err: any) {
      fastify.log.error(err, "[GET /api/profiles] Failed");
      return reply.status(500).send({ error: "Failed to retrieve profiles" });
    }
  });

  // 4. POST /api/profiles — Create new profile
  fastify.post("/api/profiles", async (req, reply) => {
    try {
      const body = (req.body || {}) as {
        name?: string;
        email?: string;
        gender?: string;
        profession?: string;
        educationBoard?: string;
        grade?: string;
        targetDailyHours?: number;
        targetDailyMinutes?: number;
        reminderTime?: string;
        remindersEnabled?: boolean;
      };

      const newProfile = await prisma.userProfile.create({
        data: {
          name: (body.name || "Explorer").trim(),
          email: body.email ? body.email.trim().toLowerCase() : undefined,
          gender: body.gender || "Prefer not to say",
          profession: body.profession || "Student",
          educationBoard: (body.educationBoard || "CBSE").trim(),
          grade: (body.grade || "Class 12").trim(),
          targetDailyHours: body.targetDailyHours ?? 1,
          targetDailyMinutes: body.targetDailyMinutes ?? 50,
          reminderTime: body.reminderTime || "20:30",
          remindersEnabled: body.remindersEnabled ?? true,
          currentStreak: 1,
          streakFreezes: 0,
          freezeShields: 0,
        },
      });

      return reply.status(201).send({ profile: formatProfilePayload(newProfile) });
    } catch (err: any) {
      fastify.log.error(err, "[POST /api/profiles] Failed");
      return reply.status(500).send({ error: "Failed to create profile" });
    }
  });

  // 5. GET /api/profiles/:id — Fetch profile by ID
  fastify.get("/api/profiles/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const profile = await getOrCreateProfile(id);
      return reply.status(200).send({ profile: formatProfilePayload(profile) });
    } catch (err: any) {
      fastify.log.error(err, "[GET /api/profiles/:id] Failed");
      return reply.status(500).send({ error: "Failed to retrieve profile" });
    }
  });

  // 6. PATCH /api/profiles/:id — Update profile by ID
  fastify.patch("/api/profiles/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const body = (req.body || {}) as {
        name?: string;
        email?: string;
        gender?: string;
        profession?: string;
        educationBoard?: string;
        grade?: string;
        targetHours?: number;
        targetMinutes?: number;
        alertNotification?: string;
        remindersEnabled?: boolean;
        streakDays?: number;
        freezeShields?: number;
      };

      const dataToUpdate: any = {};
      if (typeof body.name === "string" && body.name.trim()) dataToUpdate.name = body.name.trim();
      if (typeof body.email === "string" && body.email.trim()) dataToUpdate.email = body.email.trim().toLowerCase();
      if (typeof body.gender === "string" && body.gender.trim()) dataToUpdate.gender = body.gender.trim();
      if (typeof body.profession === "string" && body.profession.trim()) dataToUpdate.profession = body.profession.trim();
      if (typeof body.educationBoard === "string" && body.educationBoard.trim()) dataToUpdate.educationBoard = body.educationBoard.trim();
      if (typeof body.grade === "string" && body.grade.trim()) dataToUpdate.grade = body.grade.trim();
      if (body.targetHours !== undefined && !isNaN(Number(body.targetHours))) {
        dataToUpdate.targetDailyHours = Math.max(0, Number(body.targetHours));
      }
      if (body.targetMinutes !== undefined && !isNaN(Number(body.targetMinutes))) {
        dataToUpdate.targetDailyMinutes = Math.max(0, Number(body.targetMinutes));
      }
      if (typeof body.alertNotification === "string") dataToUpdate.reminderTime = body.alertNotification;
      if (body.remindersEnabled !== undefined) dataToUpdate.remindersEnabled = Boolean(body.remindersEnabled);
      if (body.streakDays !== undefined && !isNaN(Number(body.streakDays))) {
        dataToUpdate.currentStreak = Number(body.streakDays);
        dataToUpdate.streakDays = Number(body.streakDays);
      }
      if (body.freezeShields !== undefined && !isNaN(Number(body.freezeShields))) {
        dataToUpdate.streakFreezes = Number(body.freezeShields);
        dataToUpdate.freezeShields = Number(body.freezeShields);
      }

      const updated = await prisma.userProfile.update({
        where: { id },
        data: dataToUpdate,
      });

      return reply.status(200).send({ profile: formatProfilePayload(updated) });
    } catch (err: any) {
      fastify.log.error(err, "[PATCH /api/profiles/:id] Failed");
      return reply.status(500).send({ error: "Failed to update profile" });
    }
  });

  // 7. POST /api/profiles/:id/activity — Log practice session minutes (e.g. from Sports stopwatch)
  fastify.post("/api/profiles/:id/activity", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const { minutes = 15, date = getTodayString() } = (req.body || {}) as { minutes?: number; date?: string };
      const minutesSpent = Math.max(1, Number(minutes));

      const log = await prisma.dailyActivityLog.upsert({
        where: { userProfileId_date: { userProfileId: id, date } },
        create: {
          userProfileId: id,
          date,
          minutesSpent,
        },
        update: {
          minutesSpent: { increment: minutesSpent },
        },
      });

      // Also create a StudySession record for telemetry
      await prisma.studySession.create({
        data: {
          profileId: id,
          minutes: minutesSpent,
        },
      });

      return reply.status(200).send({ success: true, log });
    } catch (err: any) {
      fastify.log.error(err, "[POST /api/profiles/:id/activity] Failed");
      return reply.status(500).send({ error: "Failed to log activity minutes." });
    }
  });

  // Legacy fallback GET /api/profile
  fastify.get("/api/profile", async (req, reply) => {
    const { profileId = "default-profile" } = req.query as { profileId?: string };
    try {
      const profile = await getOrCreateProfile(profileId);
      return reply.status(200).send({ profile: formatProfilePayload(profile) });
    } catch (err: any) {
      fastify.log.error(err, "[GET /api/profile] Failed");
      return reply.status(500).send({ error: "Failed to retrieve profile data" });
    }
  });
};

export default profileRoutes;
