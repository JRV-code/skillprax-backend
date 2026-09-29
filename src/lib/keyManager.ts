import prisma from './prisma';

let cachedGroqKey: string | null = null;
let cachedTavilyKey: string | null = null;

export async function getEffectiveKeys() {
  if (cachedGroqKey && cachedTavilyKey) {
    return { groqKey: cachedGroqKey, tavilyKey: cachedTavilyKey };
  }
  let config: any = null;
  try {
    config = await (prisma as any).systemConfig?.findUnique({ where: { id: 'global' } });
  } catch (_) {}
  if (!config) {
    try {
      config = await (prisma as any).adminConfig?.findUnique({ where: { id: 'global' } });
    } catch (_) {}
  }
  cachedGroqKey = config?.groqApiKey || config?.groqKey || process.env.GROQ_API_KEY || '';
  cachedTavilyKey = config?.tavilyApiKey || config?.tavilyKey || process.env.TAVILY_API_KEY || '';
  return { groqKey: cachedGroqKey, tavilyKey: cachedTavilyKey };
}

export function invalidateKeyCache() {
  cachedGroqKey = null;
  cachedTavilyKey = null;
}
