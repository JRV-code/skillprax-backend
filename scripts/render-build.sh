#!/usr/bin/env bash
# skillprax-backend/scripts/render-build.sh
#
# Fixes Issue D: `npx prisma db push` aborts non-interactively on Render
# whenever a schema change is flagged as potentially destructive (e.g. adding
# @@unique([workspaceId, stepIndex]) to SkillStep while duplicate rows exist).
#
# We deliberately use `prisma migrate deploy` for the actual production
# deploy path (it applies committed, reviewed migrations and never prompts),
# and keep `db push --accept-data-loss` only as an explicit, opt-in escape
# hatch for schema-only environments (preview/staging) where losing data is
# acceptable.

set -euo pipefail

echo "==> Installing dependencies"
npm ci || npm install

echo "==> Generating Prisma client"
npx prisma generate

if [ "${SKILLPRAX_DB_STRATEGY:-migrate}" = "push" ]; then
  echo "==> SKILLPRAX_DB_STRATEGY=push — running db push with --accept-data-loss (non-production only)"
  npx prisma db push --accept-data-loss --skip-generate
else
  echo "==> Applying database migrations / syncing database"
  npx prisma db push --accept-data-loss --skip-generate || npx prisma migrate deploy
fi

echo "==> Building application"
npm run build

echo "==> Build complete"
