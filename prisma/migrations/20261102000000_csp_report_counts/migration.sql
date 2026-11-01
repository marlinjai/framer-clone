-- Counts of what the report-only policy of published pages would block
-- (src/lib/site/cspReportOnly.ts). Additive: a new table, no visitor data.

-- CreateTable
CREATE TABLE "csp_report_counts" (
    "site_id" TEXT NOT NULL,
    "directive" TEXT NOT NULL,
    "blocked_host" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "csp_report_counts_pkey" PRIMARY KEY ("site_id","directive","blocked_host")
);

-- AddForeignKey
ALTER TABLE "csp_report_counts" ADD CONSTRAINT "csp_report_counts_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;
