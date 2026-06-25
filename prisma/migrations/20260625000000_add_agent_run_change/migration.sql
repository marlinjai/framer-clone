-- slice4-content-agent-phase2: CMS content agent run + change persistence.
--
-- Two public-schema tables and one enum that record every natural-language
-- agent run (agent_runs) and its per-mutation inverses (agent_changes). The
-- inverse_tool + inverse_payload pair captured read-before-write is what powers
-- the one-click "Undo all": undo replays the changes in reverse `position`
-- order. agent_changes cascades on its parent run delete.
--
-- GENERATION NOTE: hand-authored to be byte-equivalent to what
-- `prisma migrate diff` emits for these additive objects (the agent has no live
-- DB). Public-schema objects use unqualified names, matching the init and
-- site-persistence migrations' `public` convention; the commerce schema's
-- objects stay qualified. APPLYING this migration is a Marlin / secrets step
-- (`pnpm db:migrate` dev / `pnpm db:deploy` prod under Infisical-injected
-- DATABASE_URL). The agent did NOT apply it anywhere.

-- CreateEnum
CREATE TYPE "AgentRunStatus" AS ENUM ('pending', 'running', 'done', 'failed');

-- CreateTable
CREATE TABLE "agent_runs" (
    "id" TEXT NOT NULL,
    "collection_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "status" "AgentRunStatus" NOT NULL DEFAULT 'pending',
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_changes" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "tool" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "inverse_tool" TEXT NOT NULL,
    "inverse_payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_changes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_changes_run_id_idx" ON "agent_changes"("run_id");

-- AddForeignKey
ALTER TABLE "agent_changes" ADD CONSTRAINT "agent_changes_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
