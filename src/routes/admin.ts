import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import prisma from '../lib/prisma';
import { testProviderConnection } from '../lib/ai/orchestrator';
import crypto from 'crypto';
import { callGroqWithFallback } from '../lib/ai/pipeline';
import { getEffectiveKeys, invalidateKeyCache } from '../lib/keyManager';

function hashPasscode(passcode: string, salt: string): string {
  return crypto.scryptSync(passcode, salt, 64).toString('hex');
}

function maskKey(key?: string | null): string | null {
  if (!key) return null;
  if (key.length <= 8) return '********';
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

export async function adminRoutes(fastify: FastifyInstance) {
  // GET /api/admin/status - Check if master passcode is configured
  fastify.get('/api/admin/status', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const security = await (prisma as any).adminSecurity.findUnique({
        where: { id: 'admin-master' },
      });
      return reply.status(200).send({
        isConfigured: Boolean(security?.passcodeHash && security?.salt),
      });
    } catch (err) {
      fastify.log.error(err, '[Admin] Status check failed');
      return reply.status(500).send({ error: 'Failed to verify admin status' });
    }
  });

  // POST /api/admin/setup - Initial password setup (only allowed once)
  fastify.post('/api/admin/setup', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const { passcode } = (req.body || {}) as { passcode?: string };
      if (!passcode || passcode.trim().length < 4) {
        return reply.status(400).send({ error: 'Passcode must be at least 4 characters long.' });
      }

      const existing = await (prisma as any).adminSecurity.findUnique({
        where: { id: 'admin-master' },
      });

      if (existing?.passcodeHash) {
        return reply.status(409).send({ error: 'Admin passcode is already set. Use verify endpoint.' });
      }

      const salt = crypto.randomBytes(16).toString('hex');
      const passcodeHash = hashPasscode(passcode.trim(), salt);

      await (prisma as any).adminSecurity.upsert({
        where: { id: 'admin-master' },
        create: { id: 'admin-master', passcodeHash, salt },
        update: { passcodeHash, salt },
      });

      const sessionToken = crypto.randomBytes(32).toString('hex');
      return reply.status(200).send({
        success: true,
        message: 'Master passcode created successfully',
        token: sessionToken,
      });
    } catch (err) {
      fastify.log.error(err, '[Admin] Setup failed');
      return reply.status(500).send({ error: 'Failed to setup admin passcode' });
    }
  });

  // POST /api/admin/verify - Validate passcode and grant session token
  fastify.post('/api/admin/verify', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const { passcode } = (req.body || {}) as { passcode?: string };
      if (!passcode) {
        return reply.status(400).send({ error: 'Passcode is required.' });
      }

      const security = await (prisma as any).adminSecurity.findUnique({
        where: { id: 'admin-master' },
      });

      if (!security?.passcodeHash || !security?.salt) {
        return reply.status(404).send({ error: 'Admin passcode has not been initialized.' });
      }

      const candidateHash = hashPasscode(passcode.trim(), security.salt);
      const isMatch = crypto.timingSafeEqual(
        Buffer.from(candidateHash, 'hex'),
        Buffer.from(security.passcodeHash, 'hex')
      );

      if (!isMatch) {
        return reply.status(403).send({ error: 'Incorrect master passcode.' });
      }

      const sessionToken = crypto.randomBytes(32).toString('hex');
      return reply.status(200).send({
        success: true,
        token: sessionToken,
      });
    } catch (err) {
      fastify.log.error(err, '[Admin] Verification failed');
      return reply.status(500).send({ error: 'Passcode verification failed' });
    }
  });

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

  // GET /api/admin/config — status & masked keys
  fastify.get('/api/admin/config', async (request: FastifyRequest, reply: FastifyReply) => {
    const { groqKey, tavilyKey } = await getEffectiveKeys();
    return reply.send({
      groqConfigured: !!groqKey && groqKey.length > 5,
      tavilyConfigured: !!tavilyKey && tavilyKey.length > 5,
      groqKeyMasked: groqKey ? `${groqKey.slice(0, 4)}...${groqKey.slice(-4)}` : '',
      tavilyKeyMasked: tavilyKey ? `${tavilyKey.slice(0, 4)}...${tavilyKey.slice(-4)}` : '',
    });
  });

  // POST /api/admin/config — save keys
  fastify.post('/api/admin/config', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body || {}) as any;
    const groqApiKey = body.groqApiKey || body.groqKey || '';
    const tavilyApiKey = body.tavilyApiKey || body.tavilyKey || '';

    try {
      await (prisma as any).systemConfig?.upsert({
        where: { id: 'global' },
        update: {
          ...(groqApiKey ? { groqApiKey } : {}),
          ...(tavilyApiKey ? { tavilyApiKey } : {}),
        },
        create: {
          id: 'global',
          groqApiKey: groqApiKey || '',
          tavilyApiKey: tavilyApiKey || '',
        },
      });
    } catch (_) {}

    try {
      await (prisma as any).adminConfig?.upsert({
        where: { id: 'global' },
        update: {
          ...(groqApiKey ? { groqApiKey, groqKey: groqApiKey } : {}),
          ...(tavilyApiKey ? { tavilyApiKey, tavilyKey: tavilyApiKey } : {}),
        },
        create: {
          id: 'global',
          groqApiKey: groqApiKey || '',
          tavilyApiKey: tavilyApiKey || '',
        },
      });
    } catch (_) {}

    invalidateKeyCache();
    return reply.send({ success: true, message: 'API credentials updated successfully.' });
  });

  // POST /api/admin/test-groq — test Groq latency
  fastify.post('/api/admin/test-groq', async (request: FastifyRequest, reply: FastifyReply) => {
    const { apiKey } = (request.body || {}) as any;
    const { groqKey } = await getEffectiveKeys();
    const keyToTest = apiKey || groqKey;

    if (!keyToTest) {
      return reply.status(400).send({ success: false, error: 'No Groq API Key provided or configured.' });
    }

    const start = Date.now();
    try {
      const response = await callGroqWithFallback(
        [{ role: 'user', content: 'Ping. Output OK.' }],
        { apiKey: keyToTest, model: 'llama-3.3-70b-versatile' }
      );
      const latency = Date.now() - start;
      const replyText = response.content?.trim() || 'OK';
      return reply.send({ success: true, latency, reply: replyText });
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message || 'Groq connection failed' });
    }
  });

  // POST /api/admin/test-tavily — test Tavily latency
  fastify.post('/api/admin/test-tavily', async (request: FastifyRequest, reply: FastifyReply) => {
    const { apiKey } = (request.body || {}) as any;
    const { tavilyKey } = await getEffectiveKeys();
    const keyToTest = apiKey || tavilyKey;

    if (!keyToTest) {
      return reply.status(400).send({ success: false, error: 'No Tavily API Key provided or configured.' });
    }

    const start = Date.now();
    try {
      const res = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: keyToTest,
          query: 'Next.js 14 App Router state management',
          max_results: 1,
        }),
      });
      const data: any = await res.json();
      const latency = Date.now() - start;
      if (res.ok && data.results) {
        return reply.send({ success: true, latency, resultsCount: data.results.length });
      } else {
        return reply.status(400).send({ success: false, error: data.error || 'Tavily rejection' });
      }
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message || 'Tavily connection failed' });
    }
  });
}

export default adminRoutes;
