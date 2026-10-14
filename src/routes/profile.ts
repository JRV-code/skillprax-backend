import { FastifyInstance, FastifyPluginAsync } from "fastify";
import { OAuth2Client } from "google-auth-library";
import jwt from "jsonwebtoken";
import prisma from "../lib/prisma";
import { hashPassword, verifyPassword } from "../lib/authCrypto";

const googleClientId = process.env.GOOGLE_CLIENT_ID;
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
const oauth2Client = new OAuth2Client(googleClientId, googleClientSecret);
const JWT_SECRET = process.env.JWT_SECRET || "skilltrack_enterprise_jwt_secret_2026";

export function emailKey(raw: string): string {
  const e = raw.trim().toLowerCase();
  const [local, domainRaw] = e.split('@');
  if (!local || !domainRaw) return e;
  const domain = domainRaw === 'googlemail.com' ? 'gmail.com' : domainRaw;
  return domain === 'gmail.com' ? `${local.replace(/\./g, '')}@${domain}` : `${local}@${domain}`;
}

const ipRateMap = new Map<string, { count: number; resetAt: number }>();
const emailFailMap = new Map<string, { failedCount: number; lockedUntil: number }>();

function checkRateLimit(ip: string, email: string): { allowed: boolean; message?: string } {
  const now = Date.now();
  const ipEntry = ipRateMap.get(ip);
  if (ipEntry && ipEntry.resetAt > now) {
    if (ipEntry.count >= 10) {
      return { allowed: false, message: 'Too many authentication attempts. Please try again in 1 minute.' };
    }
    ipEntry.count++;
  } else {
    ipRateMap.set(ip, { count: 1, resetAt: now + 60000 });
  }

  const eEntry = emailFailMap.get(emailKey(email));
  if (eEntry && eEntry.lockedUntil > now) {
    return { allowed: false, message: 'Account temporarily locked due to multiple failed attempts. Please try again in 5 minutes.' };
  }

  return { allowed: true };
}

function getTodayString(): string {
  return new Date().toISOString().split("T")[0];
}

function formatProfilePayload(profile: any, userRecord?: any) {
  const now = new Date();
  const joinedDate = new Date(profile.createdAt || now);
  const diffDays = Math.max(1, Math.floor((now.getTime() - joinedDate.getTime()) / (1000 * 60 * 60 * 24)));
  const activeMonths = Math.max(1, Math.floor(diffDays / 30));

  return {
    id: profile.id,
    userId: userRecord?.id || profile.id,
    name: profile.name || userRecord?.name || "Explorer",
    email: profile.email || userRecord?.email || null,
    avatarUrl: profile.avatarUrl || userRecord?.avatar_url || null,
    googleId: profile.googleId || userRecord?.google_id || null,
    isEmailVerified: profile.isEmailVerified ?? Boolean(profile.email),
    gender: profile.gender || userRecord?.gender || "Prefer not to say",
    age: profile.age || 18,
    profession: profile.profession || userRecord?.profession || "Student",
    educationBoard: profile.educationBoard || "CBSE",
    grade: profile.grade || "Class 12",
    city: userRecord?.city || profile.city || "Ahmedabad",
    state: userRecord?.state || profile.state || "Gujarat",
    dietaryPreference: userRecord?.dietary_preference || profile.dietaryPreference || "Vegetarian",
    medicalConditions: userRecord?.medical_conditions || profile.medicalConditions || "None",
    preferredLanguage: userRecord?.preferred_language || profile.preferredLanguage || "en",
    totalSkillsCompleted: userRecord?.total_skills_completed || profile.totalSkillsCompleted || 0,
    currentStreak: userRecord?.current_streak ?? profile.currentStreak ?? profile.streakDays ?? 1,
    longestStreak: userRecord?.longest_streak ?? profile.longestStreak ?? profile.streakDays ?? 1,
    lastActiveDate: userRecord?.last_active_date ? new Date(userRecord.last_active_date).toISOString().split('T')[0] : getTodayString(),
    activeMonths,
    streakDays: userRecord?.current_streak ?? profile.currentStreak ?? profile.streakDays ?? 1,
    freezeShields: profile.streakFreezes ?? profile.freezeShields ?? 0,
    targetHours: profile.targetDailyHours || profile.targetHours || 1,
    targetMinutes: profile.targetDailyMinutes || profile.targetMinutes || 50,
    alertNotification: profile.preferredReminderTime || profile.reminderTime || "19:00",
    dailyReminderEnabled: profile.dailyReminderEnabled ?? profile.remindersEnabled ?? true,
    remindersEnabled: profile.dailyReminderEnabled ?? profile.remindersEnabled ?? true,
    preferredReminderTime: profile.preferredReminderTime || profile.reminderTime || "19:00",
    timezone: profile.timezone || "UTC",
    xp: userRecord?.xp || profile.totalXp || 0,
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

  // Auth endpoints (Google OAuth, register, login, universal, set-password, me)
  // are cleanly handled in src/routes/auth.ts

  // 2c. PATCH /api/user/profile — Update user demographics, diet, and medical condition
  fastify.patch("/api/user/profile", async (req, reply) => {
    try {
      const authHeader = req.headers.authorization;
      let email = "";
      if (authHeader && authHeader.startsWith("Bearer ")) {
        try {
          const decoded: any = jwt.verify(authHeader.split(" ")[1], JWT_SECRET);
          email = decoded.email?.toLowerCase();
        } catch (_) {}
      }

      const body = (req.body || {}) as {
        profileId?: string;
        email?: string;
        name?: string;
        gender?: string;
        profession?: string;
        dietaryPreference?: string;
        medicalConditions?: string;
        preferredLanguage?: string;
        dateOfBirth?: string;
        guardianName?: string;
        guardianPhone?: string;
        guardianEmail?: string;
        city?: string;
        state?: string;
        age?: number;
      };

      const targetEmail = (body.email || email).toLowerCase().trim();
      if (!targetEmail) {
        return reply.status(400).send({ error: "User email or authentication token is required." });
      }

      // Dynamically compute age from dateOfBirth if provided
      let computedAge: number | undefined = body.age;
      if (body.dateOfBirth) {
        const birthDate = new Date(body.dateOfBirth);
        if (!isNaN(birthDate.getTime())) {
          computedAge = Math.floor((Date.now() - birthDate.getTime()) / (365.25 * 24 * 60 * 60 * 1000));
        }
      }

      // Update users table
      let dbUser: any = null;
      try {
        const rows: any[] = await prisma.$queryRawUnsafe(`
          UPDATE users 
          SET name = COALESCE($1, name),
              gender = COALESCE($2, gender),
              profession = COALESCE($3, profession),
              dietary_preference = COALESCE($4, dietary_preference),
              medical_conditions = COALESCE($5, medical_conditions),
              preferred_language = COALESCE($6, preferred_language),
              date_of_birth = COALESCE($7::date, date_of_birth),
              guardian_name = COALESCE($8, guardian_name),
              guardian_phone = COALESCE($9, guardian_phone),
              guardian_email = COALESCE($10, guardian_email),
              city = COALESCE($11, city),
              state = COALESCE($12, state),
              updated_at = NOW()
          WHERE LOWER(email) = $13
          RETURNING *;
        `, 
          body.name || null, 
          body.gender || null, 
          body.profession || null, 
          body.dietaryPreference || null, 
          body.medicalConditions || null, 
          body.preferredLanguage || null,
          body.dateOfBirth || null,
          body.guardianName || null,
          body.guardianPhone || null,
          body.guardianEmail || null,
          body.city || null,
          body.state || null,
          targetEmail
        );
        dbUser = rows && rows.length > 0 ? rows[0] : null;
      } catch (_) {}

      // Update UserProfile
      let profile = await prisma.userProfile.findFirst({
        where: { email: { equals: targetEmail, mode: "insensitive" } },
      });

      if (profile) {
        profile = await prisma.userProfile.update({
          where: { id: profile.id },
          data: {
            name: body.name || profile.name,
            gender: body.gender || profile.gender,
            profession: body.profession || profile.profession,
            city: body.city || (profile as any).city,
            state: body.state || (profile as any).state,
            age: computedAge !== undefined ? computedAge : profile.age,
          },
        });
      }

      const formatted = formatProfilePayload(profile || { email: targetEmail }, dbUser);
      return reply.status(200).send({ success: true, profile: formatted, user: formatted });
    } catch (err: any) {
      fastify.log.error(err, "[PATCH /api/user/profile] Failed");
      return reply.status(500).send({ error: "Failed to update user profile" });
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
        dietaryPreference?: string;
        medicalConditions?: string;
        preferredLanguage?: string;
        dateOfBirth?: string;
        guardianName?: string;
        guardianPhone?: string;
        guardianEmail?: string;
        age?: number;
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

      // Compute age dynamically from dateOfBirth if provided
      let computedAge: number | undefined = body.age;
      if (body.dateOfBirth) {
        const birthDate = new Date(body.dateOfBirth);
        if (!isNaN(birthDate.getTime())) {
          computedAge = Math.floor((Date.now() - birthDate.getTime()) / (365.25 * 24 * 60 * 60 * 1000));
        }
      }

      const dataToUpdate: any = {};
      if (typeof body.name === "string" && body.name.trim()) dataToUpdate.name = body.name.trim();
      if (typeof body.email === "string" && body.email.trim()) dataToUpdate.email = body.email.trim().toLowerCase();
      if (typeof body.gender === "string" && body.gender.trim()) dataToUpdate.gender = body.gender.trim();
      if (typeof body.profession === "string" && body.profession.trim()) dataToUpdate.profession = body.profession.trim();
      if (typeof body.educationBoard === "string" && body.educationBoard.trim()) dataToUpdate.educationBoard = body.educationBoard.trim();
      if (typeof body.grade === "string" && body.grade.trim()) dataToUpdate.grade = body.grade.trim();
      if (computedAge !== undefined) dataToUpdate.age = computedAge;

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

      // Synchronize users table in Neon PostgreSQL
      const targetEmail = (updated.email || body.email || "").toLowerCase().trim();
      let dbUser: any = null;
      if (targetEmail) {
        try {
          const rows: any[] = await prisma.$queryRawUnsafe(`
            UPDATE users 
            SET name = COALESCE($1, name),
                gender = COALESCE($2, gender),
                profession = COALESCE($3, profession),
                dietary_preference = COALESCE($4, dietary_preference),
                medical_conditions = COALESCE($5, medical_conditions),
                preferred_language = COALESCE($6, preferred_language),
                date_of_birth = COALESCE($7::date, date_of_birth),
                guardian_name = COALESCE($8, guardian_name),
                guardian_phone = COALESCE($9, guardian_phone),
                guardian_email = COALESCE($10, guardian_email),
                updated_at = NOW()
            WHERE LOWER(email) = $11
            RETURNING *;
          `,
            body.name || null,
            body.gender || null,
            body.profession || null,
            body.dietaryPreference || null,
            body.medicalConditions || null,
            body.preferredLanguage || null,
            body.dateOfBirth || null,
            body.guardianName || null,
            body.guardianPhone || null,
            body.guardianEmail || null,
            targetEmail
          );
          dbUser = rows && rows.length > 0 ? rows[0] : null;
        } catch (_) {}
      }

      return reply.status(200).send({ profile: formatProfilePayload(updated, dbUser) });
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
