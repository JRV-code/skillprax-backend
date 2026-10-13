#!/usr/bin/env bash
# skillprax-backend/scripts/render-build.sh
#
# Fixes Issue D: `npx prisma db push` aborts non-interactively on Render
# whenever a schema change is flagged as potentially destructive (e.g. adding
# @@unique([workspaceId, stepIndex]) to SkillStep while duplicate rows exist).
#
# We deliberately use `prisma migrate deploy` for the actual production
# deploy path (it applies committed, reviewed migrations and never prompts).

set -euo pipefail

echo "==> Installing dependencies"
npm ci || npm install

echo "==> Generating Prisma client"
npx prisma generate

echo "==> Synchronizing database schema"
npx prisma db push --skip-generate

echo "==> Building application"
npm run build

echo "==> Build complete"
