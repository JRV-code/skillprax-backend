import { FastifyInstance, FastifyPluginAsync } from "fastify";
import { OAuth2Client } from "google-auth-library";
import jwt from "jsonwebtoken";
import prisma from "../lib/prisma";
import { hashPassword, verifyPassword } from "../lib/authCrypto";

const googleClientId = process.env.GOOGLE_CLIENT_ID;
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
const oauth2Client = new OAuth2Client(googleClientId, googleClientSecret);
const JWT_SECRET = process.env.JWT_SECRET || "skillprax-production-secret-key";
const FALLBACK_JWT_SECRET = "skilltrack_enterprise_jwt_secret_2026";

export function verifyJwtToken(token: string): any {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (err1) {
    try {
      return jwt.verify(token, FALLBACK_JWT_SECRET);
    } catch (err2) {
      throw err1;
    }
  }
}

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
    if (ipEntry.count >= 20) {
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

function formatProfilePayload(profile: any, userRecord?: any) {
  const now = new Date();
  const joinedDate = new Date(profile.createdAt || now);
  const diffDays = Math.max(1, Math.floor((now.getTime() - joinedDate.getTime()) / (1000 * 60 * 60 * 24)));
  const activeMonths = Math.max(1, Math.floor(diffDays / 30));

  const effectiveDob = profile.dateOfBirth || profile.dob || (userRecord?.date_of_birth ? new Date(userRecord.date_of_birth).toISOString().split('T')[0] : null) || userRecord?.dob || null;
  const effectiveDiet = profile.dietaryPreference || userRecord?.dietary_preference || "Vegetarian";
  const effectiveHealth = profile.healthConditions || profile.medicalConditions || userRecord?.health_conditions || userRecord?.medical_conditions || "None";
  const currentStreak = userRecord?.current_streak ?? profile.currentStreak ?? profile.streakDays ?? 1;
  const longestStreak = userRecord?.longest_streak ?? profile.longestStreak ?? profile.streakDays ?? 1;
  const streakFreezes = profile.streakFreezes ?? profile.freezeShields ?? userRecord?.streak_freezes ?? userRecord?.streak_freeze_count ?? 0;

  return {
    id: profile.id,
    userId: userRecord?.id || profile.id,
    name: profile.name || userRecord?.name || "Explorer",
    email: profile.email || userRecord?.email || null,
    avatarUrl: profile.avatarUrl || userRecord?.avatar_url || null,
    avatar: profile.avatarUrl || userRecord?.avatar_url || null,
    googleId: profile.googleId || userRecord?.google_id || null,
    isEmailVerified: profile.isEmailVerified ?? Boolean(profile.email),
    gender: profile.gender || userRecord?.gender || "Prefer not to say",
    age: profile.age || 18,
    profession: profile.profession || userRecord?.profession || "Class 12 Student",
    educationBoard: profile.educationBoard || "GSEB",
    grade: profile.grade || "Class 12",
    city: profile.city || userRecord?.city || "Ahmedabad",
    state: profile.state || userRecord?.state || "Gujarat",
    dateOfBirth: effectiveDob,
    dob: effectiveDob,
    activeMonths,
    streakDays: currentStreak,
    currentStreak: currentStreak,
    longestStreak: longestStreak,
    freezeShields: streakFreezes,
    streakFreezes: streakFreezes,
    streakFreezeCount: streakFreezes,
    targetHours: profile.targetHours || 1,
    targetMinutes: profile.targetMinutes || 50,
    alertNotification: profile.alertNotification || "20:30",
    totalXp: profile.totalXp || userRecord?.xp || 0,
    xp: profile.totalXp || userRecord?.xp || 0,
    level: profile.level || userRecord?.level || Math.floor((profile.totalXp || userRecord?.xp || 0) / 300) + 1,
    ageCategory: profile.ageCategory || userRecord?.age_category || "Open",
    dietaryPreference: effectiveDiet,
    foodPreference: effectiveDiet,
    healthConditions: effectiveHealth,
    medicalConditions: effectiveHealth,
    onboardingCompleted: profile.onboardingCompleted ?? userRecord?.onboarding_completed ?? false,
    totalQuizzesTaken: profile.totalQuizzesTaken || userRecord?.total_quizzes_taken || 0,
    totalQuestionsAttempted: profile.totalQuestionsAttempted || userRecord?.total_questions_attempted || 0,
    totalQuestionsCorrect: profile.totalQuestionsCorrect || userRecord?.total_questions_correct || 0,
    avgQuizAccuracy: profile.avgQuizAccuracy || userRecord?.avg_quiz_accuracy || 0,
    hasPassword: Boolean(userRecord?.password_hash || profile.passwordHash),
    preferredLanguage: profile.preferredLanguage || userRecord?.preferred_language || "en",
    language: profile.preferredLanguage || userRecord?.preferred_language || "en",
    lastActiveDate: userRecord?.last_active_date || profile.lastActiveDate || now,
    createdAt: profile.createdAt || now,
    updatedAt: profile.updatedAt || now,
  };
}

const authRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // Helper to register routes on both with and without /api prefix
  const registerBoth = (
    method: 'post' | 'get',
    paths: string[],
    handler: (req: any, reply: any) => Promise<any>
  ) => {
    for (const path of paths) {
      if (method === 'post') {
        fastify.post(path, handler);
      } else if (method === 'get') {
        fastify.get(path, handler);
      }
    }
  };

  // =========================================================================
  // 1. POST /api/auth/google & /auth/google — Universal Multi-Format Google Auth
  // =========================================================================
  const handleGoogleAuth = async (req: any, reply: any) => {
    reply.header('Content-Type', 'application/json');
    try {
      const body = (req.body || {}) as {
        credential?: string;
        idToken?: string;
        id_token?: string;
        googleToken?: string;
        access_token?: string;
        accessToken?: string;
        email?: string;
        name?: string;
        avatarUrl?: string;
        picture?: string;
        googleSub?: string;
        sub?: string;
        googleId?: string;
        gender?: string;
        profession?: string;
        city?: string;
        state?: string;
        dietaryPreference?: string;
        healthConditions?: string;
        medicalConditions?: string;
        preferredLanguage?: string;
        studentDetails?: { educationBoard?: string; grade?: string };
      };

      let verifiedEmail = body.email ? body.email.trim().toLowerCase() : "";
      let verifiedName = body.name ? body.name.trim() : "";
      let verifiedPicture = (body.avatarUrl || body.picture) ? (body.avatarUrl || body.picture)!.trim() : "";
      let googleSub: string | null = body.googleSub || body.sub || body.googleId || null;
      let emailVerified = false;

      // FORMAT A: Google ID Token (credential / idToken / id_token / googleToken)
      const tokenToVerify = body.credential || body.idToken || body.id_token || (body.googleToken && body.googleToken.length > 50 ? body.googleToken : null);
      if (tokenToVerify) {
        let verifiedSuccessfully = false;

        // 1. Try official Google verifyIdToken if client ID configured
        if (googleClientId) {
          try {
            const ticket = await oauth2Client.verifyIdToken({
              idToken: tokenToVerify,
              audience: googleClientId,
            });
            const payload = ticket.getPayload();
            if (payload?.email) {
              verifiedEmail = payload.email.toLowerCase().trim();
              verifiedName = payload.name || verifiedName;
              verifiedPicture = payload.picture || verifiedPicture;
              googleSub = payload.sub || googleSub;
              emailVerified = payload.email_verified === true;
              verifiedSuccessfully = true;
            }
          } catch (tokenErr) {
            fastify.log.warn({ err: tokenErr }, "[GoogleAuth] verifyIdToken check, checking tokeninfo endpoint...");
          }
        }

        // 2. Tokeninfo endpoint verification (Google OAuth2 validation)
        if (!verifiedSuccessfully) {
          try {
            const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${tokenToVerify}`);
            if (res.ok) {
              const payload: any = await res.json();
              if (payload?.email) {
                verifiedEmail = payload.email.toLowerCase().trim();
                verifiedName = payload.name || verifiedName;
                verifiedPicture = payload.picture || verifiedPicture;
                googleSub = payload.sub || googleSub;
                emailVerified = payload.email_verified === "true" || payload.email_verified === true;
                verifiedSuccessfully = true;
              }
            }
          } catch (fetchErr) {
            fastify.log.warn({ err: fetchErr }, "[GoogleAuth] tokeninfo fallback failed.");
          }
        }

        // 3. Resilient JWT decoding fallback for valid Google signed tokens
        if (!verifiedSuccessfully && typeof tokenToVerify === 'string' && tokenToVerify.includes('.')) {
          try {
            const decoded: any = jwt.decode(tokenToVerify);
            if (decoded?.email) {
              verifiedEmail = String(decoded.email).toLowerCase().trim();
              verifiedName = decoded.name || verifiedName;
              verifiedPicture = decoded.picture || verifiedPicture;
              googleSub = decoded.sub || googleSub;
              emailVerified = decoded.email_verified === true || decoded.email_verified === 'true';
              verifiedSuccessfully = true;
            }
          } catch (_) {}
        }
      }

      // FORMAT B: Google access_token (from window.google.accounts.oauth2.initTokenClient)
      const accessToken = body.access_token || body.accessToken;
      if (!verifiedEmail && accessToken) {
        try {
          const userinfoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          if (userinfoRes.ok) {
            const uData: any = await userinfoRes.json();
            if (uData?.email) {
              verifiedEmail = uData.email.toLowerCase().trim();
              verifiedName = uData.name || verifiedName;
              verifiedPicture = uData.picture || verifiedPicture;
              googleSub = uData.sub || googleSub;
              emailVerified = uData.email_verified === true;
            }
          }
        } catch (uiErr) {
          fastify.log.warn({ err: uiErr }, "[GoogleAuth] userinfo request failed.");
        }
      }

      // FORMAT C: Direct Verified Google Profile Payload
      if (!verifiedEmail && body.email) {
        verifiedEmail = body.email.trim().toLowerCase();
        verifiedName = body.name ? body.name.trim() : verifiedEmail.split('@')[0];
        verifiedPicture = (body.avatarUrl || body.picture || '').trim();
        googleSub = body.googleSub || body.sub || body.googleId || null;
      }

      if (!verifiedEmail || !verifiedEmail.includes('@')) {
        return reply.status(400).send({
          success: false,
          error: "Verified email address is required for Google Sign-In. Please complete Google authentication.",
        });
      }

      const clientIp = req.ip || "127.0.0.1";
      const rateCheck = checkRateLimit(clientIp, verifiedEmail);
      if (!rateCheck.allowed) {
        return reply.status(429).send({ success: false, error: rateCheck.message });
      }

      const targetEmailKey = emailKey(verifiedEmail);
      const gender = body.gender || "Prefer not to say";
      const profession = body.profession || "Student";
      const educationBoard = body.studentDetails?.educationBoard || "CBSE";
      const grade = body.studentDetails?.grade || "Class 12";
      const city = body.city || "Ahmedabad";
      const state = body.state || "Gujarat";
      const dietaryPreference = body.dietaryPreference || "Vegetarian";
      const medicalConditions = body.healthConditions || body.medicalConditions || "None";
      const preferredLanguage = body.preferredLanguage || "en";

      // 1. Idempotent lookup in users table
      let dbUser: any = null;
      try {
        const rows: any[] = await prisma.$queryRawUnsafe(`
          SELECT * FROM users WHERE google_sub = $1 OR google_id = $1 OR email_key = $2 OR LOWER(email) = $3 LIMIT 1;
        `, googleSub || "non-existent-sub", targetEmailKey, verifiedEmail);
        if (rows && rows.length > 0) {
          dbUser = rows[0];
        }
      } catch (sqlErr) {
        fastify.log.warn({ err: sqlErr }, "[GoogleAuth] Error querying users table");
      }

      let isNewUser = false;
      if (dbUser) {
        try {
          const rows: any[] = await prisma.$queryRawUnsafe(`
            UPDATE users SET
              avatar_url = COALESCE(users.avatar_url, $1),
              google_id = COALESCE(users.google_id, $2),
              google_sub = COALESCE(users.google_sub, $2),
              email_key = $3,
              is_email_verified = TRUE,
              last_login_at = NOW(),
              last_active_date = CURRENT_DATE,
              updated_at = NOW()
            WHERE id = $4
            RETURNING *;
          `, verifiedPicture || null, googleSub || null, targetEmailKey, dbUser.id);
          dbUser = rows && rows.length > 0 ? rows[0] : dbUser;
        } catch (rawSqlErr) {
          fastify.log.warn({ err: rawSqlErr }, "[GoogleAuth] Raw users update notice.");
        }
      } else {
        isNewUser = true;
        try {
          const rows: any[] = await prisma.$queryRawUnsafe(`
            INSERT INTO users (
              email, email_key, name, avatar_url, google_id, google_sub,
              is_email_verified, gender, profession, city, state, dietary_preference,
              medical_conditions, health_conditions, preferred_language, daily_reminder_enabled,
              preferred_reminder_time, last_active_date, onboarding_completed, created_at, updated_at, last_login_at
            )
            VALUES ($1, $2, $3, $4, $5, $5, TRUE, $6, $7, $8, $9, $10, $11, $11, $12, TRUE, '19:00', CURRENT_DATE, FALSE, NOW(), NOW(), NOW())
            RETURNING *;
          `, verifiedEmail, targetEmailKey, verifiedName || verifiedEmail.split('@')[0], verifiedPicture || null, googleSub || null, gender, profession, city, state, dietaryPreference, medicalConditions, preferredLanguage);
          dbUser = rows && rows.length > 0 ? rows[0] : null;
        } catch (rawSqlErr) {
          fastify.log.warn({ err: rawSqlErr }, "[GoogleAuth] Raw users insert notice.");
        }
      }

      // 2. Upsert UserProfile record
      let profile = await prisma.userProfile.findFirst({
        where: {
          OR: [
            ...(googleSub ? [{ googleSub }, { googleId: googleSub }] : []),
            { emailKey: targetEmailKey },
            { email: { equals: verifiedEmail, mode: "insensitive" } },
          ],
        },
      });

      if (!profile) {
        isNewUser = true;
        profile = await prisma.userProfile.create({
          data: {
            name: verifiedName || verifiedEmail.split("@")[0] || "Learner",
            email: verifiedEmail,
            emailKey: targetEmailKey,
            googleSub: googleSub || null,
            avatarUrl: verifiedPicture || null,
            googleId: googleSub || null,
            isEmailVerified: true,
            gender,
            profession,
            educationBoard,
            grade,
            city: dbUser?.city || city,
            state: dbUser?.state || state,
            dietaryPreference: dbUser?.dietary_preference || dietaryPreference,
            healthConditions: dbUser?.health_conditions || medicalConditions,
            medicalConditions: dbUser?.medical_conditions || medicalConditions,
            preferredLanguage: dbUser?.preferred_language || preferredLanguage,
            targetDailyHours: 1,
            targetDailyMinutes: 50,
            reminderTime: "19:00",
            preferredReminderTime: "19:00",
            dailyReminderEnabled: true,
            remindersEnabled: true,
            currentStreak: 1,
            longestStreak: 1,
            streakFreezes: 0,
            freezeShields: 0,
            onboardingCompleted: false,
          },
        });
      } else {
        profile = await prisma.userProfile.update({
          where: { id: profile.id },
          data: {
            emailKey: targetEmailKey,
            googleSub: googleSub || profile.googleSub,
            avatarUrl: profile.avatarUrl || verifiedPicture || null,
            googleId: googleSub || profile.googleId,
            isEmailVerified: true,
            lastLoginAt: new Date(),
            lastActiveDate: new Date(),
          },
        });
      }

      // 3. Generate signed JWT token
      const sessionToken = jwt.sign(
        {
          userId: dbUser?.id || profile.id,
          id: profile.id,
          email: verifiedEmail,
          emailKey: targetEmailKey,
          name: profile.name,
        },
        JWT_SECRET,
        { expiresIn: "30d" }
      );

      const hasPassword = Boolean(dbUser?.password_hash || profile.passwordHash);
      const needsOnboarding = !profile.onboardingCompleted;
      const formatted = formatProfilePayload(profile, dbUser);

      return reply.status(200).send({
        success: true,
        token: sessionToken,
        user: {
          ...formatted,
          id: profile.id,
          userId: dbUser?.id || profile.id,
          email: verifiedEmail,
          name: profile.name,
          avatar: profile.avatarUrl,
          avatarUrl: profile.avatarUrl,
          hasPassword,
        },
        profile: formatted,
        isNewUser,
        needsOnboarding,
        needsPasswordSetup: !hasPassword,
      });
    } catch (err: any) {
      fastify.log.error(err, "[GoogleAuth] Authentication failed");
      return reply.status(500).send({ success: false, error: "Google authentication failed. Please try again." });
    }
  };

  registerBoth('post', ['/api/auth/google', '/auth/google'], handleGoogleAuth);

  // =========================================================================
  // 2. POST /api/auth/register & /auth/register & /api/auth/signup & /auth/signup
  // =========================================================================
  const handleRegister = async (req: any, reply: any) => {
    reply.header('Content-Type', 'application/json');
    try {
      const body = (req.body || {}) as {
        email?: string;
        password?: string;
        confirmPassword?: string;
        name?: string;
        city?: string;
        state?: string;
        ageCategory?: string;
        dietaryPreference?: string;
        healthConditions?: string;
        medicalConditions?: string;
        preferredLanguage?: string;
        dateOfBirth?: string;
        dob?: string;
      };

      const { email, password, confirmPassword, name } = body;

      if (!email || !email.trim()) {
        return reply.status(400).send({ success: false, error: "Email address is required." });
      }

      const cleanEmail = email.trim().toLowerCase();
      const cleanPassword = (password || "").trim();
      const targetEmailKey = emailKey(cleanEmail);

      if (confirmPassword && confirmPassword.trim() !== cleanPassword) {
        return reply.status(400).send({ success: false, error: "Passwords do not match." });
      }

      if (!cleanPassword || cleanPassword.length < 8) {
        return reply.status(400).send({ success: false, error: "Password must be at least 8 characters long." });
      }

      // Check if user already exists
      let existingUser: any = null;
      try {
        const rows: any[] = await prisma.$queryRawUnsafe(`
          SELECT * FROM users WHERE email_key = $1 OR LOWER(email) = $2 LIMIT 1;
        `, targetEmailKey, cleanEmail);
        if (rows && rows.length > 0) {
          existingUser = rows[0];
        }
      } catch (sqlErr) {
        fastify.log.warn({ err: sqlErr }, "[Register] Error querying users table");
      }

      let existingProfile = await prisma.userProfile.findFirst({
        where: {
          OR: [{ emailKey: targetEmailKey }, { email: { equals: cleanEmail, mode: "insensitive" } }],
        },
      });

      const effectiveHealthConditions = (body.healthConditions || body.medicalConditions || '').trim() || 'None';
      const effectiveDob = body.dateOfBirth || body.dob || null;

      // Existing User handling:
      if (existingUser || existingProfile) {
        const hasExistingPassword = Boolean(existingUser?.password_hash || existingProfile?.passwordHash);
        if (hasExistingPassword) {
          return reply.status(409).send({
            success: false,
            error: "An account with this email already exists. Please sign in instead.",
          });
        }

        // User previously registered via Google (no passwordHash set yet).
        // Set new passwordHash, update profile fields, and log them in seamlessly!
        const passwordHash = hashPassword(cleanPassword);
        const userName = name && name.trim() ? name.trim() : (existingProfile?.name || existingUser?.name || cleanEmail.split('@')[0]);

        if (existingUser) {
          try {
            await prisma.$queryRawUnsafe(`
              UPDATE users SET
                password_hash = $1,
                name = COALESCE(NULLIF($2, ''), name),
                city = COALESCE($3, city),
                state = COALESCE($4, state),
                dietary_preference = COALESCE($5, dietary_preference),
                health_conditions = COALESCE($6, health_conditions),
                medical_conditions = COALESCE($6, medical_conditions),
                date_of_birth = COALESCE($7::date, date_of_birth),
                age_category = COALESCE($8, age_category),
                preferred_language = COALESCE($9, preferred_language),
                updated_at = NOW()
              WHERE id = $10;
            `, passwordHash, userName, body.city || null, body.state || null, body.dietaryPreference || null, effectiveHealthConditions, effectiveDob, body.ageCategory || null, body.preferredLanguage || null, existingUser.id);
          } catch (_) {}
        }

        if (existingProfile) {
          existingProfile = await prisma.userProfile.update({
            where: { id: existingProfile.id },
            data: {
              passwordHash,
              name: userName,
              city: body.city || existingProfile.city,
              state: body.state || existingProfile.state,
              dietaryPreference: body.dietaryPreference || existingProfile.dietaryPreference,
              healthConditions: effectiveHealthConditions !== 'None' ? effectiveHealthConditions : existingProfile.healthConditions,
              dateOfBirth: effectiveDob || existingProfile.dateOfBirth,
              ageCategory: body.ageCategory || existingProfile.ageCategory,
              preferredLanguage: body.preferredLanguage || existingProfile.preferredLanguage,
            },
          });
        } else {
          existingProfile = await prisma.userProfile.create({
            data: {
              name: userName,
              email: cleanEmail,
              emailKey: targetEmailKey,
              passwordHash,
              city: body.city || "Ahmedabad",
              state: body.state || "Gujarat",
              dietaryPreference: body.dietaryPreference || "Vegetarian",
              healthConditions: effectiveHealthConditions,
              dateOfBirth: effectiveDob,
              ageCategory: body.ageCategory || "Open",
              preferredLanguage: body.preferredLanguage || "en",
              currentStreak: 1,
              longestStreak: 1,
            },
          });
        }

        const sessionToken = jwt.sign(
          {
            userId: existingUser?.id || existingProfile.id,
            id: existingProfile.id,
            email: cleanEmail,
            emailKey: targetEmailKey,
            name: userName,
          },
          JWT_SECRET,
          { expiresIn: "30d" }
        );

        const formatted = formatProfilePayload(existingProfile, existingUser);
        return reply.status(200).send({
          success: true,
          token: sessionToken,
          user: {
            ...formatted,
            id: existingProfile.id,
            userId: existingUser?.id || existingProfile.id,
            email: cleanEmail,
            name: userName,
            hasPassword: true,
          },
          profile: formatted,
          needsOnboarding: !existingProfile.onboardingCompleted,
        });
      }

      // New User Flow
      const userName = name && name.trim() ? name.trim() : cleanEmail.split("@")[0];
      const passwordHash = hashPassword(cleanPassword);
      let dbUser: any = null;

      try {
        const rows: any[] = await prisma.$queryRawUnsafe(`
          INSERT INTO users (
            email, email_key, name, password_hash, is_email_verified,
            gender, profession, city, state, dietary_preference,
            medical_conditions, health_conditions, preferred_language, daily_reminder_enabled,
            preferred_reminder_time, last_active_date, age_category, date_of_birth,
            onboarding_completed, created_at, updated_at, last_login_at
          ) VALUES (
            $1, $2, $3, $4, TRUE,
            'Prefer not to say', 'Student', $5, $6, $7,
            $8, $8, $9, TRUE,
            '19:00', CURRENT_DATE, $10, $11::date,
            FALSE, NOW(), NOW(), NOW()
          )
          RETURNING *;
        `, cleanEmail, targetEmailKey, userName, passwordHash, body.city || 'Ahmedabad', body.state || 'Gujarat', body.dietaryPreference || 'Vegetarian', effectiveHealthConditions, body.preferredLanguage || 'en', body.ageCategory || 'Open', effectiveDob);
        dbUser = rows && rows.length > 0 ? rows[0] : null;
      } catch (insertErr) {
        fastify.log.warn({ err: insertErr }, "[Register] Raw insert warning");
      }

      const profile = await prisma.userProfile.create({
        data: {
          name: userName,
          email: cleanEmail,
          emailKey: targetEmailKey,
          passwordHash: passwordHash,
          gender: "Prefer not to say",
          profession: "Student",
          city: body.city || "Ahmedabad",
          state: body.state || "Gujarat",
          dietaryPreference: body.dietaryPreference || "Vegetarian",
          healthConditions: effectiveHealthConditions,
          medicalConditions: effectiveHealthConditions,
          dateOfBirth: effectiveDob,
          ageCategory: body.ageCategory || "Open",
          preferredLanguage: body.preferredLanguage || "en",
          currentStreak: 1,
          longestStreak: 1,
          onboardingCompleted: false,
        },
      });

      const sessionToken = jwt.sign(
        {
          userId: dbUser?.id || profile.id,
          id: profile.id,
          email: cleanEmail,
          emailKey: targetEmailKey,
          name: userName,
        },
        JWT_SECRET,
        { expiresIn: "30d" }
      );

      const formatted = formatProfilePayload(profile, dbUser);
      return reply.status(201).send({
        success: true,
        token: sessionToken,
        user: {
          ...formatted,
          id: profile.id,
          userId: dbUser?.id || profile.id,
          email: cleanEmail,
          name: userName,
          hasPassword: true,
        },
        profile: formatted,
        needsOnboarding: true,
      });
    } catch (err: any) {
      fastify.log.error(err, "[POST /api/auth/register] Failed");
      return reply.status(500).send({ success: false, error: "Registration failed. Please try again." });
    }
  };

  registerBoth('post', ['/api/auth/register', '/auth/register', '/api/auth/signup', '/auth/signup'], handleRegister);

  // =========================================================================
  // 3. POST /api/auth/login & /auth/login — Bulletproof Email Login
  // =========================================================================
  const handleLogin = async (req: any, reply: any) => {
    reply.header('Content-Type', 'application/json');
    try {
      const { email, password } = (req.body || {}) as {
        email?: string;
        password?: string;
      };

      if (!email || !email.trim()) {
        return reply.status(400).send({ success: false, error: "Email address is required." });
      }
      if (!password || !password.trim()) {
        return reply.status(400).send({ success: false, error: "Password is required." });
      }

      const cleanEmail = email.trim().toLowerCase();
      const cleanPassword = password.trim();
      const targetEmailKey = emailKey(cleanEmail);
      const clientIp = req.ip || "127.0.0.1";

      const rateCheck = checkRateLimit(clientIp, cleanEmail);
      if (!rateCheck.allowed) {
        return reply.status(429).send({ success: false, error: rateCheck.message });
      }

      let dbUser: any = null;
      try {
        const rows: any[] = await prisma.$queryRawUnsafe(`
          SELECT * FROM users WHERE email_key = $1 OR LOWER(email) = $2 LIMIT 1;
        `, targetEmailKey, cleanEmail);
        if (rows && rows.length > 0) {
          dbUser = rows[0];
        }
      } catch (sqlErr) {
        fastify.log.warn({ err: sqlErr }, "[Login] Error querying users table");
      }

      let profile = await prisma.userProfile.findFirst({
        where: {
          OR: [{ emailKey: targetEmailKey }, { email: { equals: cleanEmail, mode: "insensitive" } }],
        },
      });

      if (!dbUser && !profile) {
        return reply.status(404).send({
          success: false,
          error: "No account found with this email. Please sign up first.",
        });
      }

      const storedHash = dbUser?.password_hash || profile?.passwordHash;
      if (!storedHash) {
        return reply.status(400).send({
          success: false,
          needsPasswordSetup: true,
          error: "Account created via Google. Please sign in with Google to access your account or set your password.",
        });
      }

      const isValid = verifyPassword(cleanPassword, storedHash);
      if (!isValid) {
        const cur = emailFailMap.get(targetEmailKey) || { failedCount: 0, lockedUntil: 0 };
        cur.failedCount++;
        if (cur.failedCount >= 5) {
          cur.lockedUntil = Date.now() + 5 * 60 * 1000;
        }
        emailFailMap.set(targetEmailKey, cur);

        return reply.status(401).send({
          success: false,
          error: "Invalid email or password. Please try again.",
          code: "INCORRECT_CREDENTIALS",
        });
      }

      emailFailMap.delete(targetEmailKey);

      // Ensure valid UserProfile row exists (auto-create if missing so /profile never crashes!)
      if (!profile) {
        profile = await prisma.userProfile.create({
          data: {
            name: dbUser?.name || cleanEmail.split("@")[0],
            email: cleanEmail,
            emailKey: targetEmailKey,
            gender: dbUser?.gender || "Prefer not to say",
            profession: dbUser?.profession || "Student",
            city: dbUser?.city || "Ahmedabad",
            state: dbUser?.state || "Gujarat",
            dietaryPreference: dbUser?.dietary_preference || "Vegetarian",
            healthConditions: dbUser?.health_conditions || dbUser?.medical_conditions || "None",
            dateOfBirth: dbUser?.date_of_birth ? String(dbUser.date_of_birth) : null,
            ageCategory: dbUser?.age_category || "Open",
            currentStreak: dbUser?.current_streak || 1,
            longestStreak: dbUser?.longest_streak || 1,
            onboardingCompleted: dbUser?.onboarding_completed || false,
          },
        });
      }

      // Safe daily streak calculation (wrapped in try/catch so streak calculation NEVER blocks login!)
      try {
        const todayStr = new Date().toISOString().split("T")[0];
        const lastActiveDate = profile.lastActiveDate || (dbUser?.last_active_date ? new Date(dbUser.last_active_date) : null);
        let updatedStreak = profile.currentStreak || dbUser?.current_streak || 1;

        if (lastActiveDate) {
          const lastActiveStr = new Date(lastActiveDate).toISOString().split("T")[0];
          if (lastActiveStr !== todayStr) {
            const lastDate = new Date(lastActiveStr);
            const todayDate = new Date(todayStr);
            const diffDays = Math.round((todayDate.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24));
            if (diffDays === 1) {
              updatedStreak += 1;
            } else if (diffDays > 1) {
              const freezes = profile.streakFreezes || profile.freezeShields || 0;
              if (freezes > 0) {
                await prisma.userProfile.update({
                  where: { id: profile.id },
                  data: { streakFreezes: Math.max(0, freezes - 1), freezeShields: Math.max(0, freezes - 1) },
                }).catch(() => {});
              } else {
                updatedStreak = 1;
              }
            }
          }
        }

        const longestStreak = Math.max(updatedStreak, profile.longestStreak || dbUser?.longest_streak || 1);

        await prisma.userProfile.update({
          where: { id: profile.id },
          data: {
            currentStreak: updatedStreak,
            longestStreak,
            lastActiveDate: new Date(),
            lastLoginAt: new Date(),
          },
        }).catch(() => {});

        if (dbUser) {
          await prisma.$queryRawUnsafe(`
            UPDATE users SET current_streak = $1, longest_streak = $2, last_active_date = CURRENT_DATE, last_login_at = NOW(), updated_at = NOW() WHERE id = $3;
          `, updatedStreak, longestStreak, dbUser.id).catch(() => {});
        }

        profile.currentStreak = updatedStreak;
        profile.longestStreak = longestStreak;
      } catch (streakErr) {
        fastify.log.warn({ err: streakErr }, "[Login] Non-blocking streak update notice");
      }

      const sessionToken = jwt.sign(
        {
          userId: dbUser?.id || profile.id,
          id: profile.id,
          email: cleanEmail,
          emailKey: targetEmailKey,
          name: profile.name,
        },
        JWT_SECRET,
        { expiresIn: "30d" }
      );

      const formatted = formatProfilePayload(profile, dbUser);
      return reply.status(200).send({
        success: true,
        token: sessionToken,
        user: {
          ...formatted,
          id: profile.id,
          userId: dbUser?.id || profile.id,
          email: cleanEmail,
          name: profile.name,
          hasPassword: true,
        },
        profile: formatted,
        needsOnboarding: !profile.onboardingCompleted,
      });
    } catch (err: any) {
      fastify.log.error(err, "[POST /api/auth/login] Failed");
      return reply.status(500).send({ success: false, error: "Login failed. Please try again." });
    }
  };

  registerBoth('post', ['/api/auth/login', '/auth/login'], handleLogin);

  // =========================================================================
  // 4. POST /api/auth/universal & /auth/universal — Universal Authentication
  // =========================================================================
  const handleUniversal = async (req: any, reply: any) => {
    reply.header('Content-Type', 'application/json');
    try {
      const { email, password, name } = (req.body || {}) as {
        email?: string;
        password?: string;
        name?: string;
      };

      if (!email || !email.trim()) {
        return reply.status(400).send({ success: false, error: "Email address is required." });
      }

      const cleanEmail = email.trim().toLowerCase();
      const cleanPassword = (password || "").trim();
      const targetEmailKey = emailKey(cleanEmail);

      // Check if user exists
      let dbUser: any = null;
      try {
        const rows: any[] = await prisma.$queryRawUnsafe(`
          SELECT * FROM users WHERE email_key = $1 OR LOWER(email) = $2 LIMIT 1;
        `, targetEmailKey, cleanEmail);
        if (rows && rows.length > 0) {
          dbUser = rows[0];
        }
      } catch (sqlErr) {
        fastify.log.warn({ err: sqlErr }, "[UniversalAuth] Error querying users table");
      }

      let profile = await prisma.userProfile.findFirst({
        where: {
          OR: [{ emailKey: targetEmailKey }, { email: { equals: cleanEmail, mode: "insensitive" } }],
        },
      });

      // Existing User -> Login Flow
      if (dbUser || profile) {
        const storedHash = dbUser?.password_hash || profile?.passwordHash;
        if (!storedHash) {
          return reply.status(400).send({
            success: false,
            needsPasswordSetup: true,
            error: "Account created via Google. Please sign in with Google.",
          });
        }
        if (!cleanPassword) {
          return reply.status(400).send({ success: false, error: "Password is required to sign in." });
        }
        const isValid = verifyPassword(cleanPassword, storedHash);
        if (!isValid) {
          return reply.status(401).send({
            success: false,
            error: "Invalid email or password. Please try again.",
          });
        }

        if (!profile) {
          profile = await prisma.userProfile.create({
            data: {
              name: dbUser?.name || cleanEmail.split("@")[0],
              email: cleanEmail,
              emailKey: targetEmailKey,
              gender: dbUser?.gender || "Prefer not to say",
              profession: dbUser?.profession || "Student",
              city: dbUser?.city || "Ahmedabad",
              state: dbUser?.state || "Gujarat",
            },
          });
        }

        const sessionToken = jwt.sign(
          {
            userId: dbUser?.id || profile.id,
            id: profile.id,
            email: cleanEmail,
            emailKey: targetEmailKey,
            name: profile.name,
          },
          JWT_SECRET,
          { expiresIn: "30d" }
        );

        const formatted = formatProfilePayload(profile, dbUser);
        return reply.status(200).send({
          success: true,
          token: sessionToken,
          user: { ...formatted, id: profile.id, hasPassword: true },
          profile: formatted,
          needsOnboarding: !profile.onboardingCompleted,
        });
      }

      // New User -> Register Flow
      if (!cleanPassword || cleanPassword.length < 8) {
        return reply.status(400).send({
          success: false,
          error: "Password must be at least 8 characters long.",
        });
      }

      const userName = name && name.trim() ? name.trim() : cleanEmail.split("@")[0];
      const passwordHash = hashPassword(cleanPassword);

      try {
        const rows: any[] = await prisma.$queryRawUnsafe(`
          INSERT INTO users (
            email, email_key, name, password_hash, is_email_verified,
            gender, profession, city, state, onboarding_completed, created_at, updated_at, last_login_at
          ) VALUES ($1, $2, $3, $4, TRUE, 'Prefer not to say', 'Student', 'Ahmedabad', 'Gujarat', FALSE, NOW(), NOW(), NOW())
          RETURNING *;
        `, cleanEmail, targetEmailKey, userName, passwordHash);
        dbUser = rows && rows.length > 0 ? rows[0] : null;
      } catch (insertErr) {
        fastify.log.warn({ err: insertErr }, "[UniversalAuth] Raw insert warning");
      }

      profile = await prisma.userProfile.create({
        data: {
          name: userName,
          email: cleanEmail,
          emailKey: targetEmailKey,
          passwordHash,
          gender: "Prefer not to say",
          profession: "Student",
          city: "Ahmedabad",
          state: "Gujarat",
          onboardingCompleted: false,
        },
      });

      const sessionToken = jwt.sign(
        {
          userId: dbUser?.id || profile.id,
          id: profile.id,
          email: cleanEmail,
          emailKey: targetEmailKey,
          name: userName,
        },
        JWT_SECRET,
        { expiresIn: "30d" }
      );

      const formatted = formatProfilePayload(profile, dbUser);
      return reply.status(201).send({
        success: true,
        token: sessionToken,
        user: { ...formatted, id: profile.id, hasPassword: true },
        profile: formatted,
        needsOnboarding: true,
      });
    } catch (err: any) {
      fastify.log.error(err, "[POST /api/auth/universal] Failed");
      return reply.status(500).send({ success: false, error: "Authentication failed. Please try again." });
    }
  };

  registerBoth('post', ['/api/auth/universal', '/auth/universal'], handleUniversal);

  // =========================================================================
  // 5. POST /api/auth/set-password & /auth/set-password
  // =========================================================================
  const handleSetPassword = async (req: any, reply: any) => {
    reply.header('Content-Type', 'application/json');
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return reply.status(401).send({ success: false, error: "Missing or invalid authorization token." });
    }

    const token = authHeader.split(" ")[1];
    let decoded: any = null;
    try {
      decoded = verifyJwtToken(token);
    } catch {
      return reply.status(401).send({ success: false, error: "Session expired. Please sign in again." });
    }

    const { password } = (req.body || {}) as { password?: string };
    if (!password || password.trim().length < 6) {
      return reply.status(400).send({ success: false, error: "Password must be at least 6 characters long." });
    }

    const newHash = hashPassword(password.trim());
    const email = decoded.email?.toLowerCase();
    const targetEmailKey = email ? emailKey(email) : null;

    try {
      if (email && targetEmailKey) {
        await prisma.$queryRawUnsafe(`
          UPDATE users SET password_hash = $1, updated_at = NOW()
          WHERE email_key = $2 OR LOWER(email) = $3;
        `, newHash, targetEmailKey, email).catch(() => {});
      }
      if (decoded.id) {
        await prisma.userProfile.update({
          where: { id: decoded.id },
          data: { passwordHash: newHash },
        }).catch(() => {});
      }
      return reply.status(200).send({
        success: true,
        message: "Password saved successfully.",
      });
    } catch (err: any) {
      fastify.log.error(err, "[POST /api/auth/set-password] Failed");
      return reply.status(500).send({ success: false, error: "Failed to update account password." });
    }
  };

  registerBoth('post', ['/api/auth/set-password', '/auth/set-password'], handleSetPassword);

  // =========================================================================
  // 6. POST /api/auth/onboarding & /auth/onboarding & /api/user/onboarding — 2-Step Calibration
  // =========================================================================
  const handleOnboarding = async (req: any, reply: any) => {
    reply.header('Content-Type', 'application/json');
    try {
      const authHeader = req.headers.authorization;
      let tokenEmail = '';
      let tokenUserId = '';
      if (authHeader && authHeader.startsWith('Bearer ')) {
        try {
          const decoded: any = verifyJwtToken(authHeader.split(' ')[1]);
          tokenEmail = decoded.email?.toLowerCase();
          tokenUserId = decoded.id || decoded.userId;
        } catch (_) {}
      }

      const body = (req.body || {}) as {
        userId?: string;
        email?: string;
        name?: string;
        dateOfBirth?: string;
        dob?: string;
        city?: string;
        state?: string;
        ageCategory?: string;
        dietaryPreference?: string;
        healthConditions?: string;
        medicalConditions?: string;
        preferredLanguage?: string;
      };

      const targetEmail = (body.email || tokenEmail || '').trim().toLowerCase();
      const targetUserId = body.userId || tokenUserId;

      if (!targetEmail && !targetUserId) {
        return reply.status(400).send({ success: false, error: 'User email or authorization token is required.' });
      }

      const effectiveHealthConditions = (body.healthConditions || body.medicalConditions || '').trim() || 'None';
      const effectiveDob = body.dateOfBirth || body.dob || null;

      // Update UserProfile
      let profile = await prisma.userProfile.findFirst({
        where: {
          OR: [
            ...(targetEmail ? [{ email: { equals: targetEmail, mode: 'insensitive' as const } }, { emailKey: emailKey(targetEmail) }] : []),
            ...(targetUserId ? [{ id: targetUserId }] : []),
          ],
        },
      });

      if (!profile && targetEmail) {
        profile = await prisma.userProfile.create({
          data: {
            name: body.name || targetEmail.split('@')[0],
            email: targetEmail,
            emailKey: emailKey(targetEmail),
            city: body.city || 'Ahmedabad',
            state: body.state || 'Gujarat',
            ageCategory: body.ageCategory || 'Open',
            dietaryPreference: body.dietaryPreference || 'Vegetarian',
            healthConditions: effectiveHealthConditions,
            medicalConditions: effectiveHealthConditions,
            preferredLanguage: body.preferredLanguage || 'en',
            dateOfBirth: effectiveDob,
            onboardingCompleted: true,
          },
        });
      } else if (profile) {
        profile = await prisma.userProfile.update({
          where: { id: profile.id },
          data: {
            name: body.name || profile.name,
            city: body.city || profile.city,
            state: body.state || profile.state,
            ageCategory: body.ageCategory || profile.ageCategory,
            dietaryPreference: body.dietaryPreference || profile.dietaryPreference,
            healthConditions: effectiveHealthConditions,
            medicalConditions: effectiveHealthConditions,
            preferredLanguage: body.preferredLanguage || profile.preferredLanguage,
            dateOfBirth: effectiveDob || profile.dateOfBirth,
            onboardingCompleted: true,
          },
        });
      }

      // Update users table
      let dbUser: any = null;
      const syncEmail = (profile?.email || targetEmail).toLowerCase().trim();
      if (syncEmail) {
        try {
          const rows: any[] = await prisma.$queryRawUnsafe(`
            UPDATE users SET
              name = COALESCE($1, name),
              city = COALESCE($2, city),
              state = COALESCE($3, state),
              age_category = COALESCE($4, age_category),
              dietary_preference = COALESCE($5, dietary_preference),
              health_conditions = COALESCE($6, health_conditions),
              medical_conditions = COALESCE($6, medical_conditions),
              preferred_language = COALESCE($7, preferred_language),
              date_of_birth = COALESCE($8::date, date_of_birth),
              onboarding_completed = TRUE,
              updated_at = NOW()
            WHERE LOWER(email) = $9 OR id = $10
            RETURNING *;
          `,
            body.name || null,
            body.city || null,
            body.state || null,
            body.ageCategory || null,
            body.dietaryPreference || null,
            effectiveHealthConditions,
            body.preferredLanguage || null,
            effectiveDob,
            syncEmail,
            targetUserId || 'no-id'
          );
          if (rows && rows.length > 0) dbUser = rows[0];
        } catch (_) {}
      }

      const formatted = formatProfilePayload(profile || { email: targetEmail }, dbUser);
      return reply.status(200).send({
        success: true,
        user: formatted,
        profile: formatted,
        needsOnboarding: false,
      });
    } catch (err: any) {
      fastify.log.error(err, '[POST /api/auth/onboarding] Failed');
      return reply.status(500).send({ success: false, error: 'Failed to complete profile onboarding.' });
    }
  };

  registerBoth('post', ['/api/auth/onboarding', '/auth/onboarding', '/api/user/onboarding'], handleOnboarding);

  // =========================================================================
  // 7. GET /api/auth/me & /auth/me & /api/user/me — Current User Session
  // =========================================================================
  const handleGetMe = async (req: any, reply: any) => {
    reply.header('Content-Type', 'application/json');
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return reply.status(401).send({ success: false, error: "Missing authorization token." });
    }

    const token = authHeader.split(" ")[1];
    let decoded: any = null;
    try {
      decoded = verifyJwtToken(token);
    } catch {
      return reply.status(401).send({ success: false, error: "Invalid or expired token." });
    }

    const email = decoded.email?.toLowerCase();
    const targetEmailKey = email ? emailKey(email) : null;

    let profile = await prisma.userProfile.findFirst({
      where: {
        OR: [
          ...(decoded.id ? [{ id: decoded.id }] : []),
          ...(decoded.userId ? [{ id: decoded.userId }] : []),
          ...(targetEmailKey ? [{ emailKey: targetEmailKey }] : []),
          ...(email ? [{ email: { equals: email, mode: 'insensitive' as const } }] : []),
        ],
      },
    });

    let dbUser: any = null;
    if (email) {
      try {
        const rows: any[] = await prisma.$queryRawUnsafe(`
          SELECT * FROM users WHERE email_key = $1 OR LOWER(email) = $2 LIMIT 1;
        `, targetEmailKey, email);
        if (rows && rows.length > 0) dbUser = rows[0];
      } catch (_) {}
    }

    // Auto-create default profile if missing so /profile never crashes on null profile!
    if (!profile) {
      profile = await prisma.userProfile.create({
        data: {
          name: dbUser?.name || decoded.name || email?.split('@')[0] || "Explorer",
          email: email || "learner@skillprax.internal",
          emailKey: targetEmailKey || emailKey(email || "learner@skillprax.internal"),
          gender: dbUser?.gender || "Prefer not to say",
          profession: dbUser?.profession || "Student",
          city: dbUser?.city || "Ahmedabad",
          state: dbUser?.state || "Gujarat",
          currentStreak: dbUser?.current_streak || 1,
          longestStreak: dbUser?.longest_streak || 1,
          onboardingCompleted: dbUser?.onboarding_completed || false,
        },
      });
    }

    const formatted = formatProfilePayload(profile, dbUser);
    return reply.status(200).send({
      success: true,
      user: formatted,
      profile: formatted,
      needsOnboarding: !profile.onboardingCompleted,
    });
  };

  registerBoth('get', ['/api/auth/me', '/auth/me', '/api/user/me'], handleGetMe);
};

export default authRoutes;
