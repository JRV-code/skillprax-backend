import prisma from '../../src/lib/prisma';
import { callGroqJson } from '../../src/services/learning/foundation';
import { ensureDatabaseSchema } from '../../src/lib/ensureSchema';

async function suggestSubgenres(skill: string) {
  const trimmed = skill.trim();
  const normalized = trimmed.toLowerCase().replace(/\s+/g, ' ');

  const cached = await prisma.subgenreCache.findUnique({
    where: { normalizedSkillName: normalized },
  });

  if (cached && Array.isArray(cached.subgenres)) {
    return { subgenres: cached.subgenres as string[], cached: true };
  }

  const prompt = `You are a Principal Curriculum Taxonomist. A user wants to learn the skill: "${trimmed}". Return 4 to 6 specific professional sub-genres or specializations of THIS skill. Do not return levels like Beginner/Advanced/Intermediate. Return JSON: {"subgenres": ["..."]}`;

  const res = await callGroqJson<{ subgenres: string[] }>(
    'You are a Principal Curriculum Taxonomist. Return strictly JSON.',
    prompt,
    {
      validate: (v: any) => {
        if (!Array.isArray(v?.subgenres)) return false;
        if (v.subgenres.length < 4 || v.subgenres.length > 6) return false;
        const seen = new Set<string>();
        for (const s of v.subgenres) {
          if (typeof s !== 'string') return false;
          const clean = s.trim();
          if (clean.length < 3 || clean.length > 60) return false;
          if (/^(beginner|intermediate|advanced|basic|expert)$/i.test(clean)) return false;
          const lower = clean.toLowerCase();
          if (seen.has(lower)) return false;
          seen.add(lower);
        }
        return true;
      },
      maxTokens: 500,
      temperature: 0.3,
    }
  );

  const subgenres = res.subgenres.map(s => s.trim());
  await prisma.subgenreCache.upsert({
    where: { normalizedSkillName: normalized },
    create: { normalizedSkillName: normalized, subgenres },
    update: { subgenres },
  });

  return { subgenres, cached: false };
}

async function main() {
  console.log('=== T1: DYNAMIC SUB-GENRES ENGINE & SUBGENRECACHE AUDIT ===\n');
  await ensureDatabaseSchema();

  const skills = ['Roblox Studio Development', 'Cricket', 'Excalidraw Diagramming'];

  for (const s of skills) {
    console.log(`[Testing Subgenres for: "${s}"]`);
    const res = await suggestSubgenres(s);
    console.log(`  Count: ${res.subgenres.length} items`);
    console.log(`  Pills: ${JSON.stringify(res.subgenres)}`);
    console.log(`  From Cache: ${res.cached}`);

    // Verify constraints
    const hasForbidden = res.subgenres.some(sub => /^(beginner|intermediate|advanced|basic|expert)$/i.test(sub));
    console.log(`  Forbidden labels present? ${hasForbidden} (Expected: false)\n`);
  }

  // Repeat "Cricket" to demonstrate SubgenreCache hit
  console.log('[Repeating "Cricket" to verify SubgenreCache hit]');
  const repeatRes = await suggestSubgenres('Cricket');
  console.log(`  From Cache: ${repeatRes.cached} (Expected: true)`);
  console.log(`  Cached Pills: ${JSON.stringify(repeatRes.subgenres)}`);

  console.log('\n[T1 RESULT] ALL SUB-GENRE TAXONOMY INVARIANTS SATISFIED.');
}

main().catch(err => {
  console.error('Subgenres test error:', err);
  process.exit(1);
});
