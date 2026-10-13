-- AlterTable SkillStep
ALTER TABLE "SkillStep" ADD COLUMN IF NOT EXISTS "difficultyTier" TEXT;
ALTER TABLE "SkillStep" ADD COLUMN IF NOT EXISTS "approachViewedAt" TIMESTAMP(3);

-- CreateTable ContentDocument
CREATE TABLE IF NOT EXISTS "content_documents" (
    "id" TEXT NOT NULL,
    "stepId" TEXT,
    "resourceId" TEXT,
    "sourceType" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "sourceTitle" TEXT,
    "markdown" TEXT,
    "quadrants" JSONB,
    "topicMap" JSONB NOT NULL,
    "approachBrief" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_documents_pkey" PRIMARY KEY ("id")
);

-- AlterTable ContentTranslation
ALTER TABLE "content_translations" ADD COLUMN IF NOT EXISTS "content_document_id" TEXT;
ALTER TABLE "content_translations" ADD COLUMN IF NOT EXISTS "topic_map" JSONB;
ALTER TABLE "content_translations" ADD COLUMN IF NOT EXISTS "approach_brief" JSONB;
ALTER TABLE "content_translations" ALTER COLUMN "content_id" DROP NOT NULL;

-- CreateTable UiTranslation
CREATE TABLE IF NOT EXISTS "ui_translations" (
    "language_code" TEXT NOT NULL,
    "strings" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ui_translations_pkey" PRIMARY KEY ("language_code")
);

-- CreateTable ResourceHistory
CREATE TABLE IF NOT EXISTS "resource_histories" (
    "id" TEXT NOT NULL,
    "profile_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "step_index" INTEGER NOT NULL,
    "resource_type" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "resource_histories_pkey" PRIMARY KEY ("id")
);

-- CreateTable SubgenreCache
CREATE TABLE IF NOT EXISTS "subgenre_caches" (
    "id" TEXT NOT NULL,
    "normalized_skill_name" TEXT NOT NULL,
    "subgenres" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subgenre_caches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "content_documents_stepId_key" ON "content_documents"("stepId");
CREATE UNIQUE INDEX IF NOT EXISTS "content_documents_resourceId_key" ON "content_documents"("resourceId");
CREATE UNIQUE INDEX IF NOT EXISTS "content_translations_content_document_id_language_code_key" ON "content_translations"("content_document_id", "language_code");
CREATE INDEX IF NOT EXISTS "resource_histories_profile_id_idx" ON "resource_histories"("profile_id");
CREATE UNIQUE INDEX IF NOT EXISTS "resource_histories_workspace_id_identifier_key" ON "resource_histories"("workspace_id", "identifier");
CREATE UNIQUE INDEX IF NOT EXISTS "subgenre_caches_normalized_skill_name_key" ON "subgenre_caches"("normalized_skill_name");

-- AddForeignKey
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'content_documents_stepId_fkey') THEN
        ALTER TABLE "content_documents" ADD CONSTRAINT "content_documents_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "SkillStep"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'content_translations_content_document_id_fkey') THEN
        ALTER TABLE "content_translations" ADD CONSTRAINT "content_translations_content_document_id_fkey" FOREIGN KEY ("content_document_id") REFERENCES "content_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
