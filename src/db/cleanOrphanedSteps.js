require('dotenv').config();
const { Pool } = require('pg');

async function cleanOrphans() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.log('[Cleanup] No DATABASE_URL found, skipping pre-migration cleanup.');
    return;
  }

  const pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
  });

  // Helper to run a cleanup query safely without throwing if a table/column doesn't exist yet
  async function safeExec(label, sql) {
    try {
      const res = await pool.query(sql);
      if (res && res.rowCount > 0) {
        console.log(`[Cleanup] ${label}: cleaned ${res.rowCount} rows.`);
      }
    } catch (e) {
      // Ignore table/column does not exist errors during schema transitions
    }
  }

  try {
    console.log('[Cleanup] Sanitizing orphaned foreign keys across database...');

    // 0. Drop any legacy cross-table constraint resources_chapter_id_fkey pointing to chapters
    await safeExec('drop legacy resources_chapter_id_fkey', `ALTER TABLE "resources" DROP CONSTRAINT IF EXISTS "resources_chapter_id_fkey";`);

    // 1. Convert empty string '' foreign keys to NULL on resources
    await safeExec('resources empty chapter_id -> NULL', `UPDATE "resources" SET "chapter_id" = NULL WHERE "chapter_id" = '';`);
    await safeExec('resources empty chapterId -> NULL', `UPDATE "resources" SET "chapterId" = NULL WHERE "chapterId" = '';`);
    await safeExec('resources empty topic_id -> NULL', `UPDATE "resources" SET "topic_id" = NULL WHERE "topic_id" = '';`);
    await safeExec('resources empty topicId -> NULL', `UPDATE "resources" SET "topicId" = NULL WHERE "topicId" = '';`);

    // 2. Nullify dangling chapter_id on resources (check both step_chapters and StepChapter)
    await safeExec(
      'resources dangling chapter_id (step_chapters)',
      `UPDATE "resources" SET "chapter_id" = NULL WHERE "chapter_id" IS NOT NULL AND "chapter_id" NOT IN (SELECT "id" FROM "step_chapters");`
    );
    await safeExec(
      'resources dangling chapter_id (StepChapter)',
      `UPDATE "resources" SET "chapter_id" = NULL WHERE "chapter_id" IS NOT NULL AND "chapter_id" NOT IN (SELECT "id" FROM "StepChapter");`
    );
    await safeExec(
      'resources dangling chapterId (StepChapter)',
      `UPDATE "resources" SET "chapterId" = NULL WHERE "chapterId" IS NOT NULL AND "chapterId" NOT IN (SELECT "id" FROM "StepChapter");`
    );
    await safeExec(
      'resources dangling chapterId (step_chapters)',
      `UPDATE "resources" SET "chapterId" = NULL WHERE "chapterId" IS NOT NULL AND "chapterId" NOT IN (SELECT "id" FROM "step_chapters");`
    );

    // If chapter_id is NOT NULL in resources, delete orphaned resource rows whose chapter is missing
    await safeExec(
      'delete resources with missing chapter_id (step_chapters)',
      `DELETE FROM "resources" WHERE "chapter_id" IS NOT NULL AND "chapter_id" NOT IN (SELECT "id" FROM "step_chapters");`
    );
    await safeExec(
      'delete resources with missing chapter_id (StepChapter)',
      `DELETE FROM "resources" WHERE "chapter_id" IS NOT NULL AND "chapter_id" NOT IN (SELECT "id" FROM "StepChapter");`
    );

    // 3. Nullify/clean dangling topic_id on resources
    await safeExec(
      'resources dangling topic_id (step_topics)',
      `UPDATE "resources" SET "topic_id" = NULL WHERE "topic_id" IS NOT NULL AND "topic_id" NOT IN (SELECT "id" FROM "step_topics");`
    );
    await safeExec(
      'resources dangling topic_id (StepTopic)',
      `UPDATE "resources" SET "topic_id" = NULL WHERE "topic_id" IS NOT NULL AND "topic_id" NOT IN (SELECT "id" FROM "StepTopic");`
    );
    await safeExec(
      'resources dangling topicId (StepTopic)',
      `UPDATE "resources" SET "topicId" = NULL WHERE "topicId" IS NOT NULL AND "topicId" NOT IN (SELECT "id" FROM "StepTopic");`
    );

    // 4. Delete resources whose parent step no longer exists
    await safeExec(
      'resources orphaned step_id (skill_steps)',
      `DELETE FROM "resources" WHERE "step_id" IS NOT NULL AND "step_id" NOT IN (SELECT "id" FROM "skill_steps");`
    );
    await safeExec(
      'resources orphaned stepId (SkillStep)',
      `DELETE FROM "resources" WHERE "stepId" IS NOT NULL AND "stepId" NOT IN (SELECT "id" FROM "SkillStep");`
    );

    // 5. Clean orphaned step_topics and step_chapters
    await safeExec(
      'step_topics orphaned chapter_id',
      `DELETE FROM "step_topics" WHERE "chapter_id" IS NOT NULL AND "chapter_id" NOT IN (SELECT "id" FROM "step_chapters");`
    );
    await safeExec(
      'StepTopic orphaned chapterId',
      `DELETE FROM "StepTopic" WHERE "chapterId" IS NOT NULL AND "chapterId" NOT IN (SELECT "id" FROM "StepChapter");`
    );
    await safeExec(
      'step_chapters orphaned step_id',
      `DELETE FROM "step_chapters" WHERE "step_id" IS NOT NULL AND "step_id" NOT IN (SELECT "id" FROM "skill_steps");`
    );
    await safeExec(
      'StepChapter orphaned stepId',
      `DELETE FROM "StepChapter" WHERE "stepId" IS NOT NULL AND "stepId" NOT IN (SELECT "id" FROM "SkillStep");`
    );

    // 6. Clean orphaned skill_steps
    await safeExec(
      'skill_steps orphaned skill_id (user_skills)',
      `DELETE FROM "skill_steps" WHERE "skill_id" IS NULL OR "skill_id" NOT IN (SELECT "id" FROM "user_skills");`
    );
    await safeExec(
      'SkillStep orphaned workspaceId (Workspace)',
      `DELETE FROM "SkillStep" WHERE "workspaceId" IS NULL OR "workspaceId" NOT IN (SELECT "id" FROM "Workspace");`
    );

    // 7. Clean dangling evaluation_questions / question_options
    await safeExec(
      'evaluation_questions dangling resource_id',
      `UPDATE "evaluation_questions" SET "resource_id" = NULL WHERE "resource_id" IS NOT NULL AND "resource_id" NOT IN (SELECT "id" FROM "resources");`
    );
    await safeExec(
      'evaluation_questions dangling topic_id',
      `UPDATE "evaluation_questions" SET "topic_id" = NULL WHERE "topic_id" IS NOT NULL AND "topic_id" NOT IN (SELECT "id" FROM "step_topics");`
    );

    console.log('[Cleanup] Foreign key sanitization complete.');
  } catch (err) {
    console.warn('[Cleanup Warning]:', err.message);
  } finally {
    try {
      await pool.end();
    } catch (_) {}
  }
}

cleanOrphans().catch((err) => {
  console.warn('[Cleanup Error]:', err);
  process.exit(0);
});
