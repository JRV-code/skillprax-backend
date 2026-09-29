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
    age: profile.age || 18,
    profession: profile.profession || "Class 12 Student",
    educationBoard: profile.educationBoard || "CBSE",
    grade: profile.grade || "Class 12",
    activeMonths,
    streakDays: profile.currentStreak || 0,
    freezeShields: profile.streakFreezes || 0,
    targetHours: profile.targetDailyHours || 1,
    targetMinutes: profile.targetDailyMinutes || 0,
    alertNotification: profile.reminderTime || "20:30 PM",
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
          age: 18,
          profession: "Class 12 Student",
          educationBoard: "CBSE",
          grade: "Class 12",
          targetDailyHours: 1,
          targetDailyMinutes: 50,
          reminderTime: "20:30",
          currentStreak: 7,
          streakFreezes: 1,
        },
      });
    }
    return profile;
  }

  // 1. GET /api/profiles — List all profiles in DB
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

  // 2. POST /api/profiles — Create new profile
  fastify.post("/api/profiles", async (req, reply) => {
    try {
      const body = (req.body || {}) as {
        name?: string;
        educationBoard?: string;
        grade?: string;
        targetDailyHours?: number;
        targetDailyMinutes?: number;
      };

      const newProfile = await prisma.userProfile.create({
        data: {
          name: (body.name || "Explorer").trim(),
          educationBoard: (body.educationBoard || "CBSE").trim(),
          grade: (body.grade || "Class 12").trim(),
          profession: `${body.educationBoard || "CBSE"} Student`,
          targetDailyHours: body.targetDailyHours ?? 1,
          targetDailyMinutes: body.targetDailyMinutes ?? 50,
          reminderTime: "20:30",
          currentStreak: 1,
          streakFreezes: 1,
        },
      });

      return reply.status(201).send({ profile: formatProfilePayload(newProfile) });
    } catch (err: any) {
      fastify.log.error(err, "[POST /api/profiles] Failed");
      return reply.status(500).send({ error: "Failed to create profile" });
    }
  });

  // 3. GET /api/profiles/:id — Fetch profile by ID
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

  // 4. PATCH /api/profiles/:id — Update profile by ID
  fastify.patch("/api/profiles/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const body = (req.body || {}) as {
        name?: string;
        educationBoard?: string;
        grade?: string;
        targetHours?: number;
        targetMinutes?: number;
        alertNotification?: string;
        streakDays?: number;
        freezeShields?: number;
      };

      const dataToUpdate: any = {};
      if (typeof body.name === "string" && body.name.trim()) dataToUpdate.name = body.name.trim();
      if (typeof body.educationBoard === "string" && body.educationBoard.trim()) dataToUpdate.educationBoard = body.educationBoard.trim();
      if (typeof body.grade === "string" && body.grade.trim()) dataToUpdate.grade = body.grade.trim();
      if (body.targetHours !== undefined && !isNaN(Number(body.targetHours))) {
        dataToUpdate.targetDailyHours = Math.max(0, Number(body.targetHours));
      }
      if (body.targetMinutes !== undefined && !isNaN(Number(body.targetMinutes))) {
        dataToUpdate.targetDailyMinutes = Math.max(0, Number(body.targetMinutes));
      }
      if (typeof body.alertNotification === "string") dataToUpdate.reminderTime = body.alertNotification;
      if (body.streakDays !== undefined && !isNaN(Number(body.streakDays))) {
        dataToUpdate.currentStreak = Number(body.streakDays);
      }
      if (body.freezeShields !== undefined && !isNaN(Number(body.freezeShields))) {
        dataToUpdate.streakFreezes = Number(body.freezeShields);
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
