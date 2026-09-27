import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import prisma from '../lib/prisma';
import { testProviderConnection } from '../lib/ai/orchestrator';

function maskKey(key?: string | null): string | null {
  if (!key) return null;
  if (key.length <= 8) return '********';
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

export async function adminRoutes(fastify: FastifyInstance) {
  // Helper to verify admin secret header
  const verifyAdminSecret = async (request: FastifyRequest, reply: FastifyReply) => {
    const adminSecretHeader = request.headers['x-admin-secret'];
    const config = await prisma.adminConfig.findUnique({ where: { id: 'global_config' } });
    const expectedSecret = config?.adminSecret || 'skillprax_admin_2026';

    if (!adminSecretHeader || adminSecretHeader !== expectedSecret) {
      reply.status(401).send({ error: 'Unauthorized: Invalid x-admin-secret header.' });
      return false;
    }
    return true;
  };

  // GET /api/admin/keys
  fastify.get('/api/admin/keys', async (request: FastifyRequest, reply: FastifyReply) => {
    const isAuth = await verifyAdminSecret(request, reply);
    if (!isAuth) return;

    let config = await prisma.adminConfig.findUnique({ where: { id: 'global_config' } });
    if (!config) {
      config = await prisma.adminConfig.create({
        data: {
          id: 'global_config',
          adminSecret: 'skillprax_admin_2026',
          defaultProvider: 'groq',
        },
      });
    }

    return reply.send({
      defaultProvider: config.defaultProvider || 'groq',
      keys: {
        groq: maskKey(config.groqKey || process.env.GROQ_API_KEY),
        openai: maskKey(config.openaiKey || process.env.OPENAI_API_KEY),
        anthropic: maskKey(config.anthropicKey || process.env.ANTHROPIC_API_KEY),
        gemini: maskKey(config.geminiKey || process.env.GEMINI_API_KEY),
        openrouter: maskKey(config.openrouterKey || process.env.OPENROUTER_API_KEY),
        tavily: maskKey((config as any).tavilyKey || process.env.TAVILY_API_KEY),
      },
      configured: {
        groq: !!(config.groqKey || process.env.GROQ_API_KEY),
        openai: !!(config.openaiKey || process.env.OPENAI_API_KEY),
        anthropic: !!(config.anthropicKey || process.env.ANTHROPIC_API_KEY),
        gemini: !!(config.geminiKey || process.env.GEMINI_API_KEY),
        openrouter: !!(config.openrouterKey || process.env.OPENROUTER_API_KEY),
        tavily: !!((config as any).tavilyKey || process.env.TAVILY_API_KEY),
      },
    });
  });

  // POST /api/admin/keys
  fastify.post('/api/admin/keys', async (request: FastifyRequest, reply: FastifyReply) => {
    const isAuth = await verifyAdminSecret(request, reply);
    if (!isAuth) return;

    const body = request.body as {
      groqKey?: string;
      openaiKey?: string;
      anthropicKey?: string;
      geminiKey?: string;
      openrouterKey?: string;
      tavilyKey?: string;
      defaultProvider?: string;
      adminSecret?: string;
    };

    const updateData: any = {};
    if (body.groqKey !== undefined) updateData.groqKey = body.groqKey;
    if (body.openaiKey !== undefined) updateData.openaiKey = body.openaiKey;
    if (body.anthropicKey !== undefined) updateData.anthropicKey = body.anthropicKey;
    if (body.geminiKey !== undefined) updateData.geminiKey = body.geminiKey;
    if (body.openrouterKey !== undefined) updateData.openrouterKey = body.openrouterKey;
    if (body.tavilyKey !== undefined) updateData.tavilyKey = body.tavilyKey;
    if (body.defaultProvider !== undefined) updateData.defaultProvider = body.defaultProvider;
    if (body.adminSecret !== undefined) updateData.adminSecret = body.adminSecret;

    const updated = await prisma.adminConfig.upsert({
      where: { id: 'global_config' },
      create: {
        id: 'global_config',
        adminSecret: 'skillprax_admin_2026',
        ...updateData,
      },
      update: updateData,
    });

    return reply.send({
      success: true,
      message: 'Admin configuration saved successfully.',
      defaultProvider: updated.defaultProvider,
    });
  });

  // POST /api/admin/test-connection
  fastify.post('/api/admin/test-connection', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as { provider: string; key?: string };
    if (!body?.provider) {
      return reply.status(400).send({ error: 'Provider is required' });
    }

    const result = await testProviderConnection(body.provider, body.key);
    return reply.send(result);
  });
}

export default adminRoutes;
