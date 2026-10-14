import prisma from '../src/lib/prisma';

export function emailKey(raw: string): string {
  const e = raw.trim().toLowerCase();
  const [local, domainRaw] = e.split('@');
  if (!local || !domainRaw) return e;
  const domain = domainRaw === 'googlemail.com' ? 'gmail.com' : domainRaw;
  return domain === 'gmail.com' ? `${local.replace(/\./g, '')}@${domain}` : `${local}@${domain}`;
}

async function runMerge() {
  const isApply = process.argv.includes('--apply');
  console.log(`\n======================================================`);
  console.log(` SKILL-TRACK ACCOUNT MERGE SCRIPT`);
  console.log(` Mode: ${isApply ? 'APPLY (Changes will be written)' : 'DRY-RUN (No changes will be written)'}`);
  console.log(`======================================================\n`);

  // Fetch all user profiles and users
  const [profiles, users] = await Promise.all([
    prisma.userProfile.findMany({
      include: {
        workspaces: true,
      },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.user.findMany({
      orderBy: { createdAt: 'asc' },
    }),
  ]);

  console.log(`Found ${profiles.length} UserProfiles and ${users.length} Users.\n`);

  // Group UserProfiles by emailKey
  const profileGroups = new Map<string, typeof profiles>();
  for (const p of profiles) {
    if (!p.email) continue;
    const key = emailKey(p.email);
    if (!profileGroups.has(key)) profileGroups.set(key, []);
    profileGroups.get(key)!.push(p);
  }

  let duplicateProfileGroups = 0;
  for (const [key, group] of profileGroups.entries()) {
    if (group.length > 1) {
      duplicateProfileGroups++;
      const [primary, ...duplicates] = group;
      console.log(`Duplicate group found for emailKey: "${key}" (${group.length} profiles)`);
      console.log(`  Primary (oldest): ID ${primary.id} | Email: ${primary.email} | Created: ${primary.createdAt}`);
      for (const dup of duplicates) {
        console.log(`  Duplicate to merge: ID ${dup.id} | Email: ${dup.email} | Workspaces: ${dup.workspaces.length}`);
        if (isApply) {
          // Re-parent workspaces to primary profile
          for (const ws of dup.workspaces) {
            await prisma.workspace.update({
              where: { id: ws.id },
              data: {
                userProfileId: primary.id,
                profileId: primary.id,
              },
            });
            console.log(`    Re-parented Workspace ${ws.id} -> Primary ${primary.id}`);
          }
          // Merge XP
          if (dup.totalXp > 0) {
            await prisma.userProfile.update({
              where: { id: primary.id },
              data: { totalXp: { increment: dup.totalXp } },
            });
            console.log(`    Merged ${dup.totalXp} XP into primary profile.`);
          }
        }
      }
    }
  }

  if (duplicateProfileGroups === 0) {
    console.log(`No duplicate accounts found sharing an emailKey.`);
  } else {
    console.log(`\nProcessed ${duplicateProfileGroups} duplicate account group(s).`);
    if (!isApply) {
      console.log(`\n[DRY-RUN] To apply these merges to the database, run:`);
      console.log(`  npx tsx scripts/merge-duplicate-accounts.ts --apply\n`);
    } else {
      console.log(`\n[APPLY] Account merges committed successfully.\n`);
    }
  }

  await prisma.$disconnect();
}

runMerge().catch((err) => {
  console.error('Account merge script error:', err);
  process.exit(1);
});
