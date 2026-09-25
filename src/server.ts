import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { env } from './config/env.js';

const server = Fastify({
  logger: {
    transport: env.NODE_ENV === 'development' ? {
      target: 'pino-pretty',
      options: { translateTime: 'HH:MM:ss Z', ignore: 'pid,hostname' }
    } : undefined
  }
});

// Register CORS for Vercel frontend target
await server.register(cors, {
  origin: env.FRONTEND_URL,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  credentials: true
});

// Register WebSockets for Socratic Rubber Duck & Sabotage Telemetry
await server.register(websocket);

// Health check endpoint (mandatory for Render cloud service health checks)
server.get('/health', async () => {
  return {
    status: 'ok',
    service: 'skillprax-backend',
    timestamp: new Date().toISOString()
  };
});

// Telemetry WebSocket endpoint
server.register(async function (fastify) {
  fastify.get('/ws', { websocket: true }, (connection: any, req) => {
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

const start = async () => {
  try {
    await server.listen({ port: env.PORT, host: env.HOST });
    console.log(`🚀 [BACKEND] Fastify server running on http://${env.HOST}:${env.PORT}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

start();
