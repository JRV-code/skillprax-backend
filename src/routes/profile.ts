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
    ageCategory: userRecord?.age_category || profile.ageCategory || "Open",
    dietaryPreference: userRecord?.dietary_preference || profile.dietaryPreference || "Vegetarian",
    medicalConditions: userRecord?.medical_conditions || userRecord?.health_conditions || profile.healthConditions || "None",
    healthConditions: userRecord?.health_conditions || userRecord?.medical_conditions || profile.healthConditions || "None",
    onboardingCompleted: profile.onboardingCompleted ?? userRecord?.onboarding_completed ?? false,
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
    totalXp: userRecord?.xp || profile.totalXp || 0,
    level: profile.level || userRecord?.level || Math.floor((userRecord?.xp || profile.totalXp || 0) / 300) + 1,
    totalQuizzesTaken: profile.totalQuizzesTaken || userRecord?.total_quizzes_taken || 0,
    totalQuestionsAttempted: profile.totalQuestionsAttempted || userRecord?.total_questions_attempted || 0,
    totalQuestionsCorrect: profile.totalQuestionsCorrect || userRecord?.total_questions_correct || 0,
    avgQuizAccuracy: profile.avgQuizAccuracy || userRecord?.avg_quiz_accuracy || 0,
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
        healthConditions?: string;
        ageCategory?: string;
        onboardingCompleted?: boolean;
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

      const effectiveHealthConditions = (body.healthConditions || body.medicalConditions || '').trim() || null;

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
              health_conditions = COALESCE($5, health_conditions),
              preferred_language = COALESCE($6, preferred_language),
              date_of_birth = COALESCE($7::date, date_of_birth),
              guardian_name = COALESCE($8, guardian_name),
              guardian_phone = COALESCE($9, guardian_phone),
              guardian_email = COALESCE($10, guardian_email),
              city = COALESCE($11, city),
              state = COALESCE($12, state),
              age_category = COALESCE($13, age_category),
              onboarding_completed = COALESCE($14, onboarding_completed),
              updated_at = NOW()
          WHERE LOWER(email) = $15
          RETURNING *;
        `, 
          body.name || null, 
          body.gender || null, 
          body.profession || null, 
          body.dietaryPreference || null, 
          effectiveHealthConditions, 
          body.preferredLanguage || null,
          body.dateOfBirth || null,
          body.guardianName || null,
          body.guardianPhone || null,
          body.guardianEmail || null,
          body.city || null,
          body.state || null,
          body.ageCategory || null,
          body.onboardingCompleted !== undefined ? body.onboardingCompleted : null,
          targetEmail
        );
        dbUser = rows && rows.length > 0 ? rows[0] : null;
      } catch (_) {}

      // Update UserProfile
      let profile = await prisma.userProfile.findFirst({
        where: { email: { equals: targetEmail, mode: "insensitive" } },
      });

      if (profile) {
        const updateData: any = {
          name: body.name || profile.name,
          gender: body.gender || profile.gender,
          profession: body.profession || profile.profession,
          city: body.city || (profile as any).city,
          state: body.state || (profile as any).state,
          age: computedAge !== undefined ? computedAge : profile.age,
        };
        if (body.ageCategory) updateData.ageCategory = body.ageCategory;
        if (body.dietaryPreference) updateData.dietaryPreference = body.dietaryPreference;
        if (effectiveHealthConditions) updateData.healthConditions = effectiveHealthConditions;
        if (body.onboardingCompleted !== undefined) updateData.onboardingCompleted = body.onboardingCompleted;
        if (body.preferredLanguage) updateData.preferredLanguage = body.preferredLanguage;

        profile = await prisma.userProfile.update({
          where: { id: profile.id },
          data: updateData,
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

  // Helper to fetch user workspaces and categorize into Cognitive vs Physical, Pending vs Completed
  async function getProfileWorkspaces(userProfileId: string, email?: string | null) {
    const isSportTitle = (title: string) => {
      const t = (title || '').toLowerCase();
      return ['cricket', 'football', 'soccer', 'swimming', 'tennis', 'badminton', 'basketball', 'sprint', 'athletics', 'running', 'gymnastics', 'yoga', 'calisthenics', 'strength'].some(s => t.includes(s));
    };

    const workspaces = await prisma.workspace.findMany({
      where: {
        OR: [
          { userProfileId },
          { profileId: userProfileId },
          ...(email ? [{ userProfile: { email: { equals: email, mode: 'insensitive' as const } } }] : []),
        ],
      },
      include: {
        steps: {
          orderBy: { stepIndex: 'asc' },
          select: {
            id: true,
            stepIndex: true,
            title: true,
            status: true,
          },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });

    const pendingCognitiveSkills: any[] = [];
    const completedCognitiveSkills: any[] = [];
    const pendingPhysicalSkills: any[] = [];
    const completedPhysicalSkills: any[] = [];

    for (const ws of workspaces) {
      const dCat = (ws.domainCategory || '').toLowerCase();
      const dName = (ws.domain || '').toLowerCase();
      const isPhysical = dCat === 'athletics' || dName === 'athletics' || isSportTitle(ws.title || ws.skillName || '');

      const totalSteps = Math.max(1, ws.totalPlannedSteps || ws.steps.length || 5);
      const completedSteps = ws.steps.filter((s) => s.status === 'PASSED').length;
      const progressPercent = Math.min(100, Math.round((completedSteps / totalSteps) * 100));
      const isCompleted = completedSteps >= totalSteps && totalSteps > 0;
      const activeStep = ws.steps.find((s) => s.status !== 'PASSED') || ws.steps[ws.steps.length - 1];

      const skillItem = {
        id: ws.id,
        title: ws.title || ws.skillName || 'Skill Track',
        skillName: ws.skillName || ws.title || 'Skill Track',
        subGenre: ws.subGenre || ws.subTitle || 'Core Specialization',
        domainCategory: ws.domainCategory || (isPhysical ? 'Athletics' : 'Cognitive Logic'),
        level: ws.level || 'Beginner',
        completedSteps,
        totalSteps,
        progressPercent,
        currentStepTitle: activeStep?.title || `Milestone ${completedSteps + 1}`,
        currentStepIndex: activeStep?.stepIndex || (completedSteps + 1),
        isPhysical,
        isCompleted,
        updatedAt: ws.updatedAt,
        createdAt: ws.createdAt,
      };

      if (isPhysical) {
        if (isCompleted) {
          completedPhysicalSkills.push(skillItem);
        } else {
          pendingPhysicalSkills.push(skillItem);
        }
      } else {
        if (isCompleted) {
          completedCognitiveSkills.push(skillItem);
        } else {
          pendingCognitiveSkills.push(skillItem);
        }
      }
    }

    return {
      pendingCognitiveSkills,
      completedCognitiveSkills,
      pendingPhysicalSkills,
      completedPhysicalSkills,
    };
  }

  // 9. GET /api/profile — Module 2.1 Complete Profile with Live Telemetry & Skills Categories
  fastify.get("/api/profile", async (req, reply) => {
    try {
      const authHeader = req.headers.authorization;
      let emailFromToken = "";
      let profileIdFromToken = "";
      if (authHeader && authHeader.startsWith("Bearer ")) {
        try {
          const decoded: any = jwt.verify(authHeader.split(" ")[1], JWT_SECRET);
          emailFromToken = decoded.email?.toLowerCase();
          profileIdFromToken = decoded.id || decoded.userId;
        } catch (_) {}
      }

      const query = (req.query || {}) as { profileId?: string; email?: string; userId?: string };
      const targetEmail = (query.email || emailFromToken || "").trim().toLowerCase();
      const targetId = query.profileId || query.userId || profileIdFromToken;

      let profile: any = null;
      if (targetEmail) {
        profile = await prisma.userProfile.findFirst({
          where: { email: { equals: targetEmail, mode: "insensitive" } },
        });
      }
      if (!profile && targetId) {
        profile = await prisma.userProfile.findUnique({
          where: { id: targetId },
        });
      }
      if (!profile) {
        profile = await getOrCreateProfile("default-profile");
      }

      let dbUser: any = null;
      if (profile.email) {
        try {
          const rows: any[] = await prisma.$queryRawUnsafe(
            `SELECT * FROM users WHERE LOWER(email) = $1 LIMIT 1;`,
            profile.email.toLowerCase().trim()
          );
          if (rows && rows.length > 0) dbUser = rows[0];
        } catch (_) {}
      }

      const formattedProfile = formatProfilePayload(profile, dbUser);
      const workspacesData = await getProfileWorkspaces(profile.id, profile.email);

      return reply.status(200).send({
        success: true,
        profile: formattedProfile,
        user: formattedProfile,
        ...workspacesData,
      });
    } catch (err: any) {
      fastify.log.error(err, "[GET /api/profile] Failed");
      return reply.status(500).send({ error: "Failed to retrieve profile data" });
    }
  });

  // 10. PUT /api/profile — Module 2.1 Profile Calibration & Demographics Update
  fastify.put("/api/profile", async (req, reply) => {
    try {
      const authHeader = req.headers.authorization;
      let emailFromToken = "";
      let profileIdFromToken = "";
      if (authHeader && authHeader.startsWith("Bearer ")) {
        try {
          const decoded: any = jwt.verify(authHeader.split(" ")[1], JWT_SECRET);
          emailFromToken = decoded.email?.toLowerCase();
          profileIdFromToken = decoded.id || decoded.userId;
        } catch (_) {}
      }

      const body = (req.body || {}) as {
        profileId?: string;
        userId?: string;
        email?: string;
        name?: string;
        city?: string;
        state?: string;
        ageCategory?: string;
        preferredLanguage?: string;
        dietaryPreference?: string;
        healthConditions?: string;
        medicalConditions?: string;
        onboardingCompleted?: boolean;
        gender?: string;
        profession?: string;
        age?: number;
      };

      const targetEmail = (body.email || emailFromToken || "").trim().toLowerCase();
      const targetId = body.profileId || body.userId || profileIdFromToken;

      let profile = targetEmail
        ? await prisma.userProfile.findFirst({
            where: { email: { equals: targetEmail, mode: "insensitive" } },
          })
        : null;

      if (!profile && targetId) {
        profile = await prisma.userProfile.findUnique({
          where: { id: targetId },
        });
      }

      if (!profile) {
        profile = await getOrCreateProfile("default-profile");
      }

      const effectiveHealthConditions = (body.healthConditions || body.medicalConditions || '').trim() || null;

      const updateData: any = {};
      if (body.name) updateData.name = body.name.trim();
      if (body.city) updateData.city = body.city.trim();
      if (body.state) updateData.state = body.state.trim();
      if (body.ageCategory) updateData.ageCategory = body.ageCategory.trim();
      if (body.preferredLanguage) updateData.preferredLanguage = body.preferredLanguage.trim();
      if (body.dietaryPreference) updateData.dietaryPreference = body.dietaryPreference.trim();
      if (effectiveHealthConditions) updateData.healthConditions = effectiveHealthConditions;
      if (body.onboardingCompleted !== undefined) updateData.onboardingCompleted = Boolean(body.onboardingCompleted);
      if (body.gender) updateData.gender = body.gender.trim();
      if (body.profession) updateData.profession = body.profession.trim();
      if (typeof body.age === "number") updateData.age = body.age;

      const updatedProfile = await prisma.userProfile.update({
        where: { id: profile.id },
        data: updateData,
      });

      // Synchronize users table
      let dbUser: any = null;
      const syncEmail = (updatedProfile.email || targetEmail || "").toLowerCase().trim();
      if (syncEmail) {
        try {
          const rows: any[] = await prisma.$queryRawUnsafe(
            `UPDATE users SET
              name = COALESCE($1, name),
              city = COALESCE($2, city),
              state = COALESCE($3, state),
              age_category = COALESCE($4, age_category),
              preferred_language = COALESCE($5, preferred_language),
              dietary_preference = COALESCE($6, dietary_preference),
              health_conditions = COALESCE($7, health_conditions),
              medical_conditions = COALESCE($7, medical_conditions),
              onboarding_completed = COALESCE($8, onboarding_completed),
              gender = COALESCE($9, gender),
              profession = COALESCE($10, profession),
              updated_at = NOW()
            WHERE LOWER(email) = $11
            RETURNING *;`,
            body.name || null,
            body.city || null,
            body.state || null,
            body.ageCategory || null,
            body.preferredLanguage || null,
            body.dietaryPreference || null,
            effectiveHealthConditions,
            body.onboardingCompleted !== undefined ? body.onboardingCompleted : null,
            body.gender || null,
            body.profession || null,
            syncEmail
          );
          if (rows && rows.length > 0) dbUser = rows[0];
        } catch (_) {}
      }

      const formatted = formatProfilePayload(updatedProfile, dbUser);
      const workspacesData = await getProfileWorkspaces(updatedProfile.id, updatedProfile.email);

      return reply.status(200).send({
        success: true,
        profile: formatted,
        user: formatted,
        ...workspacesData,
      });
    } catch (err: any) {
      fastify.log.error(err, "[PUT /api/profile] Failed");
      return reply.status(500).send({ error: "Failed to update profile data" });
    }
  });
};

export default profileRoutes;
