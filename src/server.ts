import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { env, getAuthRedirectUrl } from './config/env';

const server = Fastify({
  logger: {
    transport: env.NODE_ENV === 'development' ? {
      target: 'pino-pretty',
      options: { translateTime: 'HH:MM:ss Z', ignore: 'pid,hostname' }
    } : undefined
  }
});

const start = async () => {
  try {
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
      credentials: true
    });

    // Register WebSockets for Socratic Rubber Duck & Sabotage Telemetry
    await server.register(websocket);

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
