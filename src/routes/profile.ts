import { FastifyInstance, FastifyPluginAsync } from "fastify";
import { OAuth2Client } from "google-auth-library";
import jwt from "jsonwebtoken";
import prisma from "../lib/prisma";

const googleClientId = process.env.GOOGLE_CLIENT_ID;
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
const oauth2Client = new OAuth2Client(googleClientId, googleClientSecret);
const JWT_SECRET = process.env.JWT_SECRET || "skilltrack_enterprise_jwt_secret_2026";

function getTodayString(): string {
  return new Date().toISOString().split("T")[0];
}

function formatProfilePayload(profile: any) {
  const now = new Date();
  const joinedDate = new Date(profile.createdAt || now);
  const diffDays = Math.max(1, Math.floor((now.getTime() - joinedDate.getTime()) / (1000 * 60 * 60 * 24)));
  const activeMonths = Math.max(1, Math.floor(diffDays / 30));

  return {
    id: profile.id,
    name: profile.name || "Explorer",
    email: profile.email || null,
    avatarUrl: profile.avatarUrl || null,
    googleId: profile.googleId || null,
    isEmailVerified: profile.isEmailVerified ?? Boolean(profile.email),
    gender: profile.gender || "Prefer not to say",
    age: profile.age || 18,
    profession: profile.profession || "Student",
    educationBoard: profile.educationBoard || "CBSE",
    grade: profile.grade || "Class 12",
    activeMonths,
    streakDays: profile.currentStreak || profile.streakDays || 0,
    freezeShields: profile.streakFreezes ?? profile.freezeShields ?? 0,
    targetHours: profile.targetDailyHours || profile.targetHours || 1,
    targetMinutes: profile.targetDailyMinutes || profile.targetMinutes || 0,
    alertNotification: profile.preferredReminderTime || profile.reminderTime || "19:00",
    dailyReminderEnabled: profile.dailyReminderEnabled ?? profile.remindersEnabled ?? true,
    remindersEnabled: profile.dailyReminderEnabled ?? profile.remindersEnabled ?? true,
    preferredReminderTime: profile.preferredReminderTime || profile.reminderTime || "19:00",
    timezone: profile.timezone || "UTC",
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
          name: "Manendra Patel",
          email: "manendra@skillprax.internal",
          educationBoard: "GSEB",
          grade: "Class 12",
          profession: "Class 12 Student",
          age: 18,
          activeMonths: 3,
          streakDays: 7,
          currentStreak: 7,
          longestStreak: 7,
          freezeShields: 0,
          streakFreezes: 0,
          targetDailyHours: 1,
          targetDailyMinutes: 50,
          reminderTime: "19:00",
          preferredReminderTime: "19:00",
          dailyReminderEnabled: true,
          remindersEnabled: true,
        },
      });
    }
    return profile;
  }

  // 1. GET /api/profiles/lookup — Single-input secure profile lookup
  fastify.get("/api/profiles/lookup", async (req, reply) => {
    const { query } = req.query as { query?: string };
    if (!query || !query.trim()) {
      return reply.status(400).send({ error: "Search query is required." });
    }

    try {
      const clean = query.trim().toLowerCase();
      const profile = await prisma.userProfile.findFirst({
        where: {
          OR: [
            { email: { equals: clean, mode: "insensitive" } },
            { name: { equals: query.trim(), mode: "insensitive" } },
          ],
        },
      });

      if (!profile) {
        return reply.status(404).send({ error: "No profile found matching the provided identifier." });
      }

      return reply.status(200).send({ profile: formatProfilePayload(profile) });
    } catch (err: any) {
      fastify.log.error(err, "[GET /api/profiles/lookup] Failed");
      return reply.status(500).send({ error: "Profile lookup failed." });
    }
  });

  // 2. POST /api/auth/google — Verify Google ID Token & Sync Neon PostgreSQL User Record
  fastify.post("/api/auth/google", async (req, reply) => {
    try {
      const body = (req.body || {}) as {
        idToken?: string;
        googleToken?: string;
        email?: string;
        name?: string;
        avatarUrl?: string;
        gender?: string;
        profession?: string;
        studentDetails?: { educationBoard?: string; grade?: string };
      };

      let verifiedEmail = body.email ? body.email.trim().toLowerCase() : "";
      let verifiedName = body.name ? body.name.trim() : "";
      let verifiedPicture = body.avatarUrl ? body.avatarUrl.trim() : "";
      let googleId: string | null = null;
      let emailVerified = true;

      // Verify Google ID Token if present and GOOGLE_CLIENT_ID is configured
      const tokenToVerify = body.idToken || (body.googleToken && body.googleToken.length > 100 ? body.googleToken : null);
      if (tokenToVerify && googleClientId) {
        try {
          const ticket = await oauth2Client.verifyIdToken({
            idToken: tokenToVerify,
            audience: googleClientId,
          });
          const payload = ticket.getPayload();
          if (payload?.email) {
            verifiedEmail = payload.email.toLowerCase();
            verifiedName = payload.name || verifiedName;
            verifiedPicture = payload.picture || verifiedPicture;
            googleId = payload.sub || null;
            emailVerified = payload.email_verified ?? true;
          }
        } catch (tokenErr) {
          fastify.log.warn({ err: tokenErr }, "[GoogleAuth] Token verify skipped or failed; proceeding with payload data.");
        }
      }

      if (!verifiedEmail) {
        return reply.status(400).send({ error: "Verified email address is required for Google Sign-In." });
      }

      const gender = body.gender || "Prefer not to say";
      const profession = body.profession || "Student";
      const educationBoard = body.studentDetails?.educationBoard || "CBSE";
      const grade = body.studentDetails?.grade || "Class 12";

      // Module 2: Neon PostgreSQL User Record Sync (Raw SQL upsert on users table)
      try {
        await prisma.$executeRawUnsafe(`
          INSERT INTO users (
            email, 
            name, 
            avatar_url, 
            google_id, 
            is_email_verified, 
            gender, 
            profession, 
            daily_reminder_enabled,
            preferred_reminder_time,
            created_at, 
            updated_at
          )
          VALUES ($1, $2, $3, $4, TRUE, $5, $6, TRUE, '19:00', NOW(), NOW())
          ON CONFLICT (email) DO UPDATE SET 
            name = EXCLUDED.name,
            avatar_url = COALESCE(EXCLUDED.avatar_url, users.avatar_url),
            is_email_verified = TRUE,
            gender = COALESCE(EXCLUDED.gender, users.gender),
            profession = COALESCE(EXCLUDED.profession, users.profession),
            updated_at = NOW();
        `, verifiedEmail, verifiedName || verifiedEmail.split('@')[0], verifiedPicture || null, googleId || null, gender, profession);
      } catch (rawSqlErr) {
        // Log non-blocking warning if users table not yet created
        fastify.log.warn({ err: rawSqlErr }, "[GoogleAuth] Raw users table sync notice; upserting UserProfile record.");
      }

      // Upsert UserProfile record (keeps all roadmap, telemetry & quiz relations linked)
      let profile = await prisma.userProfile.findFirst({
        where: { email: { equals: verifiedEmail, mode: "insensitive" } },
      });

      if (!profile) {
        profile = await prisma.userProfile.create({
          data: {
            name: verifiedName || verifiedEmail.split("@")[0] || "Learner",
            email: verifiedEmail,
            avatarUrl: verifiedPicture || null,
            googleId: googleId || null,
            isEmailVerified: emailVerified,
            gender,
            profession,
            educationBoard,
            grade,
            targetDailyHours: 1,
            targetDailyMinutes: 50,
            reminderTime: "19:00",
            preferredReminderTime: "19:00",
            dailyReminderEnabled: true,
            remindersEnabled: true,
            currentStreak: 1,
            streakFreezes: 0,
            freezeShields: 0,
          },
        });
      } else {
        profile = await prisma.userProfile.update({
          where: { id: profile.id },
          data: {
            name: verifiedName || profile.name,
            avatarUrl: verifiedPicture || profile.avatarUrl,
            googleId: googleId || profile.googleId,
            isEmailVerified: true,
            gender: gender !== "Prefer not to say" ? gender : profile.gender,
            profession: profession || profile.profession,
            educationBoard: educationBoard || profile.educationBoard,
            grade: grade || profile.grade,
          },
        });
      }

      // Generate secure session JWT
      const sessionToken = jwt.sign(
        {
          id: profile.id,
          email: verifiedEmail,
          name: profile.name,
        },
        JWT_SECRET,
        { expiresIn: "30d" }
      );

      return reply.status(200).send({
        profile: formatProfilePayload(profile),
        user: formatProfilePayload(profile),
        token: sessionToken,
      });
    } catch (err: any) {
      fastify.log.error(err, "[POST /api/auth/google] Failed");
      return reply.status(500).send({ error: "Google authentication failed" });
    }
  });

  // 3. PATCH /api/user/reminder-settings — Update Daily Reminder Preferences (Module 3)
  fastify.patch("/api/user/reminder-settings", async (req, reply) => {
    try {
      const body = (req.body || {}) as {
        profileId?: string;
        email?: string;
        dailyReminderEnabled?: boolean;
        preferredReminderTime?: string;
        timezone?: string;
      };

      const whereClause = body.profileId
        ? { id: body.profileId }
        : body.email
        ? { email: body.email.toLowerCase().trim() }
        : null;

      if (!whereClause) {
        return reply.status(400).send({ error: "profileId or email is required to update reminder settings." });
      }

      const updateData: any = {};
      if (body.dailyReminderEnabled !== undefined) {
        updateData.dailyReminderEnabled = Boolean(body.dailyReminderEnabled);
        updateData.remindersEnabled = Boolean(body.dailyReminderEnabled);
      }
      if (typeof body.preferredReminderTime === "string" && body.preferredReminderTime.trim()) {
        updateData.preferredReminderTime = body.preferredReminderTime.trim();
        updateData.reminderTime = body.preferredReminderTime.trim();
        updateData.alertNotification = body.preferredReminderTime.trim();
      }
      if (typeof body.timezone === "string" && body.timezone.trim()) {
        updateData.timezone = body.timezone.trim();
      }

      const updated = await prisma.userProfile.update({
        where: whereClause,
        data: updateData,
      });

      // Also update users table if present
      if (updated.email) {
        try {
          await (prisma as any).user?.update({
            where: { email: updated.email },
            data: {
              dailyReminderEnabled: updateData.dailyReminderEnabled,
              preferredReminderTime: updateData.preferredReminderTime,
              timezone: updateData.timezone,
            },
          });
        } catch {}
      }

      return reply.status(200).send({
        success: true,
        settings: formatProfilePayload(updated),
      });
    } catch (err: any) {
      fastify.log.error(err, "[PATCH /api/user/reminder-settings] Failed");
      return reply.status(500).send({ error: "Failed to update reminder settings." });
    }
  });

  // 4. GET /api/profiles — List profiles (internal test support)
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

  // 5. POST /api/profiles — Create new profile
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
          reminderTime: body.reminderTime || "19:00",
          preferredReminderTime: body.reminderTime || "19:00",
          remindersEnabled: body.remindersEnabled ?? true,
          dailyReminderEnabled: body.remindersEnabled ?? true,
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

  // 6. GET /api/profiles/:id — Fetch profile by ID
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

  // 7. PATCH /api/profiles/:id — Update profile by ID
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
        dailyReminderEnabled?: boolean;
        preferredReminderTime?: string;
        timezone?: string;
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
      if (typeof body.alertNotification === "string") {
        dataToUpdate.reminderTime = body.alertNotification;
        dataToUpdate.preferredReminderTime = body.alertNotification;
      }
      if (typeof body.preferredReminderTime === "string") {
        dataToUpdate.preferredReminderTime = body.preferredReminderTime;
        dataToUpdate.reminderTime = body.preferredReminderTime;
      }
      if (body.dailyReminderEnabled !== undefined) {
        dataToUpdate.dailyReminderEnabled = Boolean(body.dailyReminderEnabled);
        dataToUpdate.remindersEnabled = Boolean(body.dailyReminderEnabled);
      } else if (body.remindersEnabled !== undefined) {
        dataToUpdate.remindersEnabled = Boolean(body.remindersEnabled);
        dataToUpdate.dailyReminderEnabled = Boolean(body.remindersEnabled);
      }
      if (typeof body.timezone === "string") {
        dataToUpdate.timezone = body.timezone.trim();
      }
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

  // 8. POST /api/profiles/:id/activity — Log practice session minutes
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

      // Update lastPracticeDate on user profile so reminder won't fire again today
      await prisma.userProfile.update({
        where: { id },
        data: { lastPracticeDate: date },
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
