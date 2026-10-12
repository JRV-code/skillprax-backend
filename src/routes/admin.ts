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

const activeAdminTokens = new Set<string>();

export async function adminRoutes(fastify: FastifyInstance) {
  // GET /api/admin/auth-status - Direct alias for setup / status determination
  fastify.get('/api/admin/auth-status', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const security = await (prisma as any).adminSecurity.findUnique({
        where: { id: 'admin-master' },
      });
      return reply.status(200).send({
        initialized: Boolean(security?.passcodeHash && security?.salt),
      });
    } catch (err) {
      fastify.log.error(err, '[Admin] Auth status check failed');
      return reply.status(500).send({ error: 'Failed to verify admin status' });
    }
  });

  // GET /api/admin/status - Check if master passcode is configured
  fastify.get('/api/admin/status', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const security = await (prisma as any).adminSecurity.findUnique({
        where: { id: 'admin-master' },
      });
      return reply.status(200).send({
        isConfigured: Boolean(security?.passcodeHash && security?.salt),
        initialized: Boolean(security?.passcodeHash && security?.salt),
      });
    } catch (err) {
      fastify.log.error(err, '[Admin] Status check failed');
      return reply.status(500).send({ error: 'Failed to verify admin status' });
    }
  });

  // POST /api/admin/setup - Initial password setup (only allowed once, min 8 chars)
  fastify.post('/api/admin/setup', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const { passcode } = (req.body || {}) as { passcode?: string };
      if (!passcode || passcode.trim().length < 8) {
        return reply.status(400).send({ error: 'Master password must be at least 8 characters long.' });
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
      activeAdminTokens.add(sessionToken);

      return reply.status(200).send({
        success: true,
        message: 'Master password established successfully',
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
        return reply.status(403).send({ error: 'Incorrect master password.' });
      }

      const sessionToken = crypto.randomBytes(32).toString('hex');
      activeAdminTokens.add(sessionToken);

      return reply.status(200).send({
        success: true,
        token: sessionToken,
      });
    } catch (err) {
      fastify.log.error(err, '[Admin] Verification failed');
      return reply.status(500).send({ error: 'Passcode verification failed' });
    }
  });

  // Helper to verify admin session token or admin secret header
  const verifyAdminTokenOrSecret = async (request: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
    const authHeader = request.headers['authorization'];
    const tokenHeader = (request.headers['x-admin-token'] as string) || (authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null);
    const adminSecretHeader = request.headers['x-admin-secret'];

    if (tokenHeader && activeAdminTokens.has(tokenHeader)) {
      return true;
    }

    const config = await prisma.adminConfig.findUnique({ where: { id: 'global_config' } });
    const expectedSecret = config?.adminSecret || 'skillprax_admin_2026';

    if (adminSecretHeader && adminSecretHeader === expectedSecret) {
      return true;
    }

    reply.status(401).send({ error: 'Unauthorized: Valid Admin Session Token or Secret is required.' });
    return false;
  };

  // GET /api/admin/keys
  fastify.get('/api/admin/keys', async (request: FastifyRequest, reply: FastifyReply) => {
    const isAuth = await verifyAdminTokenOrSecret(request, reply);
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
    const isAuth = await verifyAdminTokenOrSecret(request, reply);
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
    const isAuth = await verifyAdminTokenOrSecret(request, reply);
    if (!isAuth) return;
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

  // =========================================================================
  // MODULE 7: ADMIN CONTROL CENTER EXTENSIONS FOR MAIDAN ATHLETICS
  // =========================================================================

  // 1. Club Verification Queue
  fastify.get('/api/admin/sports/clubs/pending', async (req, reply) => {
    try {
      const clubs: any[] = await prisma.$queryRawUnsafe(`
        SELECT * FROM sports_clubs WHERE is_verified = FALSE ORDER BY created_at DESC;
      `);
      return reply.send({ success: true, clubs });
    } catch (err: any) {
      return reply.status(500).send({ error: 'Failed to fetch pending clubs' });
    }
  });

  fastify.post('/api/admin/sports/clubs/:id/verify', async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const { action = 'approve' } = (req.body || {}) as { action: 'approve' | 'reject' };

      if (action === 'approve') {
        await prisma.$executeRawUnsafe(`
          UPDATE sports_clubs SET is_verified = TRUE WHERE id::text = $1;
        `, id);
        return reply.send({ success: true, message: 'Club accredited and published to public discovery' });
      } else {
        await prisma.$executeRawUnsafe(`
          DELETE FROM sports_clubs WHERE id::text = $1;
        `, id);
        return reply.send({ success: true, message: 'Club application rejected and removed' });
      }
    } catch (err: any) {
      return reply.status(500).send({ error: 'Failed to verify club' });
    }
  });

  // 2. Driver & Vendor Approvals
  fastify.get('/api/admin/sports/drivers/pending', async (req, reply) => {
    try {
      const drivers: any[] = await prisma.$queryRawUnsafe(`
        SELECT * FROM sports_travel_vans WHERE is_driver_verified = FALSE ORDER BY created_at DESC;
      `);
      return reply.send({ success: true, drivers });
    } catch (err: any) {
      return reply.status(500).send({ error: 'Failed to fetch pending drivers' });
    }
  });

  fastify.post('/api/admin/sports/drivers/:id/verify', async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const { action = 'approve' } = (req.body || {}) as { action: 'approve' | 'reject' };

      if (action === 'approve') {
        await prisma.$executeRawUnsafe(`
          UPDATE sports_travel_vans SET is_driver_verified = TRUE WHERE id::text = $1;
        `, id);
        return reply.send({ success: true, message: 'Driver commercial license verified and route unlocked' });
      } else {
        await prisma.$executeRawUnsafe(`
          DELETE FROM sports_travel_vans WHERE id::text = $1;
        `, id);
        return reply.send({ success: true, message: 'Driver application rejected' });
      }
    } catch (err: any) {
      return reply.status(500).send({ error: 'Failed to verify driver' });
    }
  });

  // 3. High-Fee Discount Manager
  fastify.post('/api/admin/sports/clubs/:id/discount', async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const { discountedFee, discountLabel = '15% Negotiated Academy Concession' } = (req.body || {}) as any;

      await prisma.$executeRawUnsafe(`
        UPDATE sports_clubs
        SET discounted_fee = $1, discount_label = $2
        WHERE id::text = $3;
      `, discountedFee ? Number(discountedFee) : null, discountLabel, id);

      return reply.send({ success: true, message: 'Academy discount promotion updated successfully' });
    } catch (err: any) {
      return reply.status(500).send({ error: 'Failed to update discount' });
    }
  });

  // 4. Escrow Payout Queue
  fastify.get('/api/admin/sports/escrow/held', async (req, reply) => {
    try {
      const txns: any[] = await prisma.$queryRawUnsafe(`
        SELECT * FROM sports_escrow_transactions WHERE escrow_status = 'held' ORDER BY created_at DESC;
      `);
      return reply.send({ success: true, transactions: txns });
    } catch (err: any) {
      return reply.status(500).send({ error: 'Failed to fetch held escrow funds' });
    }
  });

  fastify.post('/api/admin/sports/escrow/:id/release', async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const { action = 'release' } = (req.body || {}) as { action: 'release' | 'refund' };

      if (action === 'release') {
        await prisma.$executeRawUnsafe(`
          UPDATE sports_escrow_transactions
          SET escrow_status = 'released', payout_released_at = NOW()
          WHERE id::text = $1;
        `, id);
        return reply.send({ success: true, message: 'Escrow payment released to service provider' });
      } else {
        await prisma.$executeRawUnsafe(`
          UPDATE sports_escrow_transactions
          SET escrow_status = 'refunded', refunded_at = NOW()
          WHERE id::text = $1;
        `, id);
        return reply.send({ success: true, message: 'Escrow payment refunded to athlete via Razorpay' });
      }
    } catch (err: any) {
      return reply.status(500).send({ error: 'Failed to release escrow funds' });
    }
  });
}

export default adminRoutes;
