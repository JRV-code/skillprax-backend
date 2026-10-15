import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import jwt from 'jsonwebtoken';
import {
  listUserSessions,
  createChatSession,
  getSessionMessages,
  deleteChatSession,
  streamAssistantChat,
} from '../services/assistant/assistantService';

const JWT_SECRET = process.env.JWT_SECRET || 'skilltrack_enterprise_jwt_secret_2026';

function extractUserId(req: any): string {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    try {
      const decoded: any = jwt.verify(token, JWT_SECRET);
      if (decoded?.id || decoded?.userId || decoded?.profileId) {
        return String(decoded.id || decoded.userId || decoded.profileId);
      }
    } catch (_) {}
  }

  const headerId = req.headers['x-user-id'] || req.headers['x-profile-id'];
  if (headerId) return String(headerId);

  const queryId = (req.query as any)?.userId || (req.query as any)?.profileId;
  if (queryId) return String(queryId);

  const bodyId = (req.body as any)?.userId || (req.body as any)?.profileId;
  if (bodyId) return String(bodyId);

  return 'default-profile';
}

export const assistantRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // 1. GET /api/assistant/sessions — List all chat sessions for the active user
  fastify.get('/api/assistant/sessions', async (req, reply) => {
    try {
      const userId = extractUserId(req);
      const sessions = await listUserSessions(userId);
      return reply.send({ sessions });
    } catch (err: any) {
      req.log.error(err);
      return reply.status(500).send({ error: err.message || 'Failed to list chat sessions' });
    }
  });

  // 2. POST /api/assistant/sessions — Create a fresh "New Conversation" session (+ New Chat)
  fastify.post('/api/assistant/sessions', async (req, reply) => {
    try {
      const userId = extractUserId(req);
      const { title } = (req.body as any) || {};
      const session = await createChatSession(userId, title);
      return reply.status(201).send({ session });
    } catch (err: any) {
      req.log.error(err);
      return reply.status(500).send({ error: err.message || 'Failed to create chat session' });
    }
  });

  // 3. GET /api/assistant/sessions/:sessionId/messages — Fetch all messages for session
  fastify.get('/api/assistant/sessions/:sessionId/messages', async (req, reply) => {
    try {
      const userId = extractUserId(req);
      const { sessionId } = req.params as { sessionId: string };
      const messages = await getSessionMessages(sessionId, userId);
      return reply.send({ messages });
    } catch (err: any) {
      req.log.error(err);
      return reply.status(404).send({ error: err.message || 'Failed to load messages' });
    }
  });

  // 4. DELETE /api/assistant/sessions/:sessionId — Delete a specific chat session
  fastify.delete('/api/assistant/sessions/:sessionId', async (req, reply) => {
    try {
      const userId = extractUserId(req);
      const { sessionId } = req.params as { sessionId: string };
      await deleteChatSession(sessionId, userId);
      return reply.send({ success: true, deletedSessionId: sessionId });
    } catch (err: any) {
      req.log.error(err);
      return reply.status(500).send({ error: err.message || 'Failed to delete chat session' });
    }
  });

  // 5. POST /api/assistant/sessions/:sessionId/stream — Real-time Token-by-Token Autoregressive Stream
  fastify.post('/api/assistant/sessions/:sessionId/stream', async (req, reply) => {
    const userId = extractUserId(req);
    const { sessionId } = req.params as { sessionId: string };
    const { prompt, forceWebSearch } = (req.body as any) || {};

    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      return reply.status(400).send({ error: 'Prompt is required.' });
    }

    // Initialize Server-Sent Events headers
    reply.raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no'); // Disable proxy buffering in Nginx/Render
    reply.raw.flushHeaders?.();

    try {
      const stream = streamAssistantChat({
        sessionId,
        userId,
        userPrompt: prompt.trim(),
        forceWebSearch: Boolean(forceWebSearch),
      });

      for await (const event of stream) {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      }

      reply.raw.end();
    } catch (err: any) {
      req.log.error(err);
      reply.raw.write(`data: ${JSON.stringify({ type: 'error', message: err.message || 'Stream generation failed' })}\n\n`);
      reply.raw.end();
    }
  });
};

export default assistantRoutes;
