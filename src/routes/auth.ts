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
    if (ipEntry.count >= 15) {
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
    activeMonths,
    streakDays: profile.streakDays || userRecord?.current_streak || 1,
    currentStreak: profile.currentStreak || userRecord?.current_streak || 1,
    longestStreak: profile.longestStreak || userRecord?.longest_streak || 1,
    freezeShields: profile.freezeShields || 0,
    targetHours: profile.targetHours || 1,
    targetMinutes: profile.targetMinutes || 50,
    alertNotification: profile.alertNotification || "20:30",
    totalXp: profile.totalXp || userRecord?.xp || 0,
    level: profile.level || userRecord?.level || Math.floor((profile.totalXp || userRecord?.xp || 0) / 300) + 1,
    ageCategory: profile.ageCategory || userRecord?.age_category || "Open",
    dietaryPreference: profile.dietaryPreference || userRecord?.dietary_preference || "Vegetarian",
    healthConditions: profile.healthConditions || userRecord?.health_conditions || userRecord?.medical_conditions || "None",
    onboardingCompleted: profile.onboardingCompleted ?? userRecord?.onboarding_completed ?? false,
    totalQuizzesTaken: profile.totalQuizzesTaken || userRecord?.total_quizzes_taken || 0,
    totalQuestionsAttempted: profile.totalQuestionsAttempted || userRecord?.total_questions_attempted || 0,
    totalQuestionsCorrect: profile.totalQuestionsCorrect || userRecord?.total_questions_correct || 0,
    avgQuizAccuracy: profile.avgQuizAccuracy || userRecord?.avg_quiz_accuracy || 0,
    hasPassword: Boolean(userRecord?.password_hash || profile.passwordHash),
    preferredLanguage: profile.preferredLanguage || userRecord?.preferred_language || "en",
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
  // 1. POST /api/auth/google & /auth/google — Multi-Format Google OAuth Handler
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
        gender?: string;
        profession?: string;
        studentDetails?: { educationBoard?: string; grade?: string };
      };

      let verifiedEmail = body.email ? body.email.trim().toLowerCase() : "";
      let verifiedName = body.name ? body.name.trim() : "";
      let verifiedPicture = (body.avatarUrl || body.picture) ? (body.avatarUrl || body.picture)!.trim() : "";
      let googleSub: string | null = body.googleSub || body.sub || null;
      let emailVerified = false;

      // FORMAT A: Google ID Token (credential / idToken / id_token)
      const tokenToVerify = body.credential || body.idToken || body.id_token || (body.googleToken && body.googleToken.length > 100 ? body.googleToken : null);
      if (tokenToVerify) {
        let verifiedSuccessfully = false;

        // Try official Google library if client ID configured
        if (googleClientId) {
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
              googleSub = payload.sub || googleSub;
              emailVerified = payload.email_verified === true;
              verifiedSuccessfully = true;
            }
          } catch (tokenErr) {
            fastify.log.warn({ err: tokenErr }, "[GoogleAuth] verifyIdToken failed, falling back to tokeninfo endpoint.");
          }
        }

        // Fallback: Google tokeninfo endpoint
        if (!verifiedSuccessfully) {
          try {
            const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${tokenToVerify}`);
            if (res.ok) {
              const payload: any = await res.json();
              if (payload?.email) {
                verifiedEmail = payload.email.toLowerCase();
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
      }

      // FORMAT B: Google access_token (from window.google.accounts.oauth2.initTokenClient or @react-oauth/google)
      const accessToken = body.access_token || body.accessToken;
      if (!verifiedEmail && accessToken) {
        try {
          const userinfoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          if (userinfoRes.ok) {
            const uData: any = await userinfoRes.json();
            if (uData?.email) {
              verifiedEmail = uData.email.toLowerCase();
              verifiedName = uData.name || verifiedName;
              verifiedPicture = uData.picture || verifiedPicture;
              googleSub = uData.sub || googleSub;
              emailVerified = uData.email_verified === true;
            }
          } else {
            fastify.log.warn(`[GoogleAuth] userinfo request returned HTTP ${userinfoRes.status}`);
          }
        } catch (uiErr) {
          fastify.log.warn({ err: uiErr }, "[GoogleAuth] userinfo request failed.");
        }
      }

      // FORMAT C: Direct verified profile payload if client SDK pre-verified
      if (!verifiedEmail && body.email && (body.googleSub || body.sub)) {
        verifiedEmail = body.email.trim().toLowerCase();
        verifiedName = body.name || verifiedEmail.split('@')[0];
        verifiedPicture = body.avatarUrl || body.picture || "";
        googleSub = body.googleSub || body.sub || null;
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
      const dietaryPreference = (body as any).dietaryPreference || "Vegetarian";
      const medicalConditions = (body as any).medicalConditions || "None";
      const preferredLanguage = (body as any).preferredLanguage || "en";

      // 1. Find or update in users table
      let dbUser: any = null;
      try {
        const rows: any[] = await prisma.$queryRawUnsafe(`
          SELECT * FROM users WHERE google_sub = $1 OR email_key = $2 OR LOWER(email) = $3 LIMIT 1;
        `, googleSub || "non-existent-sub", targetEmailKey, verifiedEmail);
        if (rows && rows.length > 0) {
          dbUser = rows[0];
        }
      } catch (sqlErr) {
        fastify.log.warn({ err: sqlErr }, "[GoogleAuth] Error querying users table");
      }

      if (dbUser) {
        try {
          const rows: any[] = await prisma.$queryRawUnsafe(`
            UPDATE users SET
              name = COALESCE(NULLIF($1, ''), users.name),
              avatar_url = COALESCE($2, users.avatar_url),
              google_id = COALESCE($3, users.google_id),
              google_sub = COALESCE($3, users.google_sub),
              email_key = $4,
              is_email_verified = TRUE,
              gender = COALESCE($5, users.gender),
              profession = COALESCE($6, users.profession),
              last_login_at = NOW(),
              last_active_date = CURRENT_DATE,
              updated_at = NOW()
            WHERE id = $7
            RETURNING *;
          `, verifiedName || verifiedEmail.split('@')[0], verifiedPicture || null, googleSub || null, targetEmailKey, gender, profession, dbUser.id);
          dbUser = rows && rows.length > 0 ? rows[0] : dbUser;
        } catch (rawSqlErr) {
          fastify.log.warn({ err: rawSqlErr }, "[GoogleAuth] Raw users update notice.");
        }
      } else {
        try {
          const rows: any[] = await prisma.$queryRawUnsafe(`
            INSERT INTO users (
              email, email_key, name, avatar_url, google_id, google_sub,
              is_email_verified, gender, profession, dietary_preference,
              medical_conditions, preferred_language, daily_reminder_enabled,
              preferred_reminder_time, last_active_date, created_at, updated_at, last_login_at
            )
            VALUES ($1, $2, $3, $4, $5, $5, TRUE, $6, $7, $8, $9, $10, TRUE, '19:00', CURRENT_DATE, NOW(), NOW(), NOW())
            RETURNING *;
          `, verifiedEmail, targetEmailKey, verifiedName || verifiedEmail.split('@')[0], verifiedPicture || null, googleSub || null, gender, profession, dietaryPreference, medicalConditions, preferredLanguage);
          dbUser = rows && rows.length > 0 ? rows[0] : null;
        } catch (rawSqlErr) {
          fastify.log.warn({ err: rawSqlErr }, "[GoogleAuth] Raw users insert notice.");
        }
      }

      // 2. Upsert UserProfile record
      let profile = await prisma.userProfile.findFirst({
        where: {
          OR: [
            { googleSub: googleSub || undefined },
            { emailKey: targetEmailKey },
            { email: { equals: verifiedEmail, mode: "insensitive" } },
          ],
        },
      });

      if (!profile) {
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
            city: dbUser?.city || "Ahmedabad",
            state: dbUser?.state || "Gujarat",
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
            emailKey: targetEmailKey,
            googleSub: googleSub || profile.googleSub,
            avatarUrl: verifiedPicture || profile.avatarUrl,
            googleId: googleSub || profile.googleId,
            isEmailVerified: true,
            gender: gender !== "Prefer not to say" ? gender : profile.gender,
            profession: profession || profile.profession,
            educationBoard: educationBoard || profile.educationBoard,
            grade: grade || profile.grade,
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
        needsPasswordSetup: !hasPassword,
      });
    } catch (err: any) {
      fastify.log.error(err, "[GoogleAuth] Authentication failed");
      return reply.status(500).send({ success: false, error: "Google authentication failed. Please try again." });
    }
  };

  registerBoth('post', ['/api/auth/google', '/auth/google'], handleGoogleAuth);

  // =========================================================================
  // 2. POST /api/auth/register & /auth/register — Standard Registration
  // =========================================================================
  const handleRegister = async (req: any, reply: any) => {
    reply.header('Content-Type', 'application/json');
    try {
      const { email, password, confirmPassword, name } = (req.body || {}) as {
        email?: string;
        password?: string;
        confirmPassword?: string;
        name?: string;
      };

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

      const existingProfile = await prisma.userProfile.findFirst({
        where: {
          OR: [{ emailKey: targetEmailKey }, { email: { equals: cleanEmail, mode: "insensitive" } }],
        },
      });

      if (existingUser || existingProfile) {
        return reply.status(409).send({
          success: false,
          error: "An account with this email already exists. Please sign in instead.",
        });
      }

      const userName = name && name.trim() ? name.trim() : cleanEmail.split("@")[0];
      const passwordHash = hashPassword(cleanPassword);
      let dbUser: any = null;

      try {
        const rows: any[] = await prisma.$queryRawUnsafe(`
          INSERT INTO users (
            email, email_key, name, password_hash, is_email_verified,
            gender, profession, city, state, dietary_preference,
            medical_conditions, preferred_language, daily_reminder_enabled,
            preferred_reminder_time, last_active_date, created_at, updated_at
          ) VALUES (
            $1, $2, $3, $4, TRUE,
            'Prefer not to say', 'Student', 'Ahmedabad', 'Gujarat', 'Vegetarian',
            'None', 'en', TRUE,
            '19:00', CURRENT_DATE, NOW(), NOW()
          )
          RETURNING *;
        `, cleanEmail, targetEmailKey, userName, passwordHash);
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
          city: "Ahmedabad",
          state: "Gujarat",
          currentStreak: 1,
          longestStreak: 1,
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
      });
    } catch (err: any) {
      fastify.log.error(err, "[POST /api/auth/register] Failed");
      return reply.status(500).send({ success: false, error: "Registration failed. Please try again." });
    }
  };

  registerBoth('post', ['/api/auth/register', '/auth/register'], handleRegister);

  // =========================================================================
  // 3. POST /api/auth/login & /auth/login — Standard Login
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
          error: "Account created via Google. Please sign in with Google to set your password.",
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
            currentStreak: dbUser?.current_streak || 1,
            longestStreak: dbUser?.longest_streak || 1,
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
        user: {
          ...formatted,
          id: profile.id,
          userId: dbUser?.id || profile.id,
          email: cleanEmail,
          name: profile.name,
          hasPassword: true,
        },
        profile: formatted,
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
            gender, profession, city, state, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, TRUE, 'Prefer not to say', 'Student', 'Ahmedabad', 'Gujarat', NOW(), NOW())
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
      decoded = jwt.verify(token, JWT_SECRET);
    } catch {
      return reply.status(401).send({ success: false, error: "Session expired. Please sign in again." });
    }

    const { password } = (req.body || {}) as { password?: string };
    if (!password || password.trim().length < 6) {
      return reply.status(400).send({ success: false, error: "Password must be at least 6 characters long." });
    }

    const newHash = hashPassword(password.trim());
    const email = decoded.email?.toLowerCase();
    const targetEmailKey = emailKey(email || "");

    try {
      if (email) {
        await prisma.$queryRawUnsafe(`
          UPDATE users SET password_hash = $1, updated_at = NOW()
          WHERE email_key = $2 OR LOWER(email) = $3;
        `, newHash, targetEmailKey, email);
      }
      if (decoded.id) {
        await prisma.userProfile.update({
          where: { id: decoded.id },
          data: { passwordHash: newHash },
        });
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
  // 6. GET /api/auth/me & /auth/me & /api/user/me — Current User Session
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
      decoded = jwt.verify(token, JWT_SECRET);
    } catch {
      return reply.status(401).send({ success: false, error: "Invalid or expired token." });
    }

    const email = decoded.email?.toLowerCase();
    const targetEmailKey = email ? emailKey(email) : null;

    let profile = await prisma.userProfile.findFirst({
      where: {
        OR: [
          ...(decoded.id ? [{ id: decoded.id }] : []),
          ...(targetEmailKey ? [{ emailKey: targetEmailKey }] : []),
          ...(email ? [{ email: { equals: email, mode: 'insensitive' as const } }] : []),
        ],
      },
    });

    if (!profile) {
      return reply.status(404).send({ success: false, error: "User profile not found." });
    }

    let dbUser: any = null;
    if (email) {
      try {
        const rows: any[] = await prisma.$queryRawUnsafe(`
          SELECT * FROM users WHERE email_key = $1 OR LOWER(email) = $2 LIMIT 1;
        `, targetEmailKey, email);
        if (rows && rows.length > 0) dbUser = rows[0];
      } catch (_) {}
    }

    const formatted = formatProfilePayload(profile, dbUser);
    return reply.status(200).send({
      success: true,
      user: formatted,
      profile: formatted,
    });
  };

  registerBoth('get', ['/api/auth/me', '/auth/me', '/api/user/me'], handleGetMe);
};

export default authRoutes;
