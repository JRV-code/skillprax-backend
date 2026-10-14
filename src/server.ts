import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { env, getAuthRedirectUrl } from './config/env';
import adminRoutes from './routes/admin';
import authRoutes from './routes/auth';
import workspaceRoutes from './routes/workspaces';
import stepRoutes from './routes/steps';
import { learningRoutes } from './routes/learning';
import profileRoutes from './routes/profile';
import telemetryRoutes from './routes/telemetry';
import reviewRoutes from './routes/reviews';
import contentRoutes from './routes/content';
import milestoneRoutes from './routes/milestones';
import sportsRoutes from './routes/sports';
import recommendationRoutes from './routes/recommendations';
import skillsRoutes from './routes/skills';
import { ensureDatabaseSchema } from './lib/ensureSchema';
import { initializeReminderCron } from './jobs/reminderCron';
import { sendDailyPracticeReminderEmail } from './services/emailService';

const server = Fastify({
  logger: {
    transport: env.NODE_ENV === 'development' ? {
      target: 'pino-pretty',
      options: { translateTime: 'HH:MM:ss Z', ignore: 'pid,hostname' }
    } : undefined
  }
});

// Accept empty JSON body gracefully instead of throwing FST_ERR_CTP_EMPTY_JSON_BODY
server.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
  try {
    const text = typeof body === 'string' ? body.trim() : '';
    const json = text ? JSON.parse(text) : {};
    done(null, json);
  } catch (err: any) {
    err.statusCode = 400;
    done(err, undefined);
  }
});

const start = async () => {
  try {
    // Initialize Module 7 Database Schema & Safe Migration
    await ensureDatabaseSchema();
    await import('./db/ensureSchema').then(m => m.runSchemaMigration()).catch(e => console.warn('[SchemaMigration] Startup notice:', e));

    const allowedOrigins = [
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'https://skillprax-frontend-3a8p.vercel.app',
      ...(env.FRONTEND_URL ? [env.FRONTEND_URL] : [])
    ];

    // Register CORS for localhost:3000, Vercel frontend, and production origins with credentials enabled
    await server.register(cors, {
      origin: (origin, cb) => {
        if (!origin || allowedOrigins.includes(origin) || origin.endsWith('.vercel.app')) {
          cb(null, true);
        } else {
          cb(null, true);
        }
      },
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-secret', 'x-admin-token'],
      credentials: true
    });

    // Register WebSockets for Socratic Rubber Duck & Sabotage Telemetry
    await server.register(websocket);

    // Register REST Routes
    await server.register(authRoutes);
    await server.register(adminRoutes);
    await server.register(workspaceRoutes);
    await server.register(stepRoutes);
    await server.register(learningRoutes);
    await server.register(profileRoutes);
    await server.register(telemetryRoutes);
    await server.register(reviewRoutes);
    await server.register(contentRoutes);
    await server.register(milestoneRoutes);
    await server.register(sportsRoutes);
    await server.register(recommendationRoutes);
    await server.register(skillsRoutes);

    // Test reminder email endpoint (Module 3)
    server.post('/api/reminders/send-test/:profileId', async (req, reply) => {
      const { profileId } = req.params as { profileId: string };
      const profile = await (server as any).prisma?.userProfile.findUnique({
        where: { id: profileId },
        include: { workspaces: { orderBy: { updatedAt: 'desc' }, take: 1 } },
      }) || await import('./lib/prisma').then(m => m.default.userProfile.findUnique({
        where: { id: profileId },
        include: { workspaces: { orderBy: { updatedAt: 'desc' }, take: 1 } },
      }));

      if (!profile || !profile.email) {
        return reply.status(404).send({ error: 'User profile with valid email not found.' });
      }

      const activeTrack = profile.workspaces[0]?.title || 'Daily Mastery Track';
      const hours = profile.targetDailyHours || 1;
      const minutes = profile.targetDailyMinutes || 30;

      const res = await sendDailyPracticeReminderEmail({
        to: profile.email,
        userName: profile.name || 'Learner',
        skillOrSportName: activeTrack,
        streakDays: profile.currentStreak || 1,
        targetDailyTime: `${hours}h ${minutes}m`,
      });

      return reply.send(res);
    });

    // Start automated 15-minute reminder cron scheduler (Module 3)
    initializeReminderCron();

    // Health check endpoint (mandatory for Render cloud service health checks)
    server.get('/health', async () => {
      return {
        status: 'ok',
        service: 'skillprax-backend',
        authRedirectBase: getAuthRedirectUrl(),
        timestamp: new Date().toISOString()
      };
    });

    // Telemetry WebSocket endpoint
    server.register(async function (fastify) {
      fastify.get('/ws', { websocket: true }, (connection: any) => {
        const ws = connection.socket || connection;

        ws.send(
          JSON.stringify({
            type: 'CONNECTED',
            message: 'Skillprax telemetry link established.'
          })
        );

        ws.on('message', (message: Buffer) => {
          try {
            const data = JSON.parse(message.toString());
            ws.send(
              JSON.stringify({
                type: 'ACK',
                received: data,
                timestamp: new Date().toISOString()
              })
            );
          } catch (err) {
            ws.send(
              JSON.stringify({
                type: 'ERROR',
                message: 'Invalid JSON message payload.'
              })
            );
          }
        });
      });
    });

    await server.listen({ port: env.PORT, host: env.HOST });
    console.log(`🚀 [BACKEND] Fastify server running on http://${env.HOST}:${env.PORT}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

start();
