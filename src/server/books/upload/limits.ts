// src/server/books/upload/limits.ts
//
// What bounds the spend of the upload import (plan decision 2):
//
//   - at most EXTRACT_PARALLEL extractions in flight per company, process
//     local (a Map in memory, like the per-user slot of /api/ai/generate-page:
//     framer-clone runs as one container, so this bounds one company's calls);
//     the per-company slot replaces the per-user slot of the editor AI routes
//     because the plan's unit is the company: one user uploading 50 files gets
//     four in parallel, and a second user of the same company shares them;
//   - one extraction per file at a time, durable: the claim on the staging row
//     (service.ts), which a crashed or aborted call releases after
//     CLAIM_TIMEOUT_MS so it is retried, not lost;
//   - a daily ceiling per company (BOOKS_IMPORT_DAILY_LIMIT, default 500), durable:
//     the extraction ledger counts the calls started in the last 24 hours, so a
//     restart does not reset it and retries count like first attempts.

/** Extractions in flight per company. */
export const EXTRACT_PARALLEL = 4;

/** A claim older than this is a crashed or abandoned call: the file may be read again. */
export const CLAIM_TIMEOUT_MS = 5 * 60 * 1000;

/** The rolling window of the daily ceiling. */
export const DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The daily ceiling from env, default 500; a value that is not a positive integer is a configuration error. */
export function dailyExtractLimit(env: Record<string, string | undefined> = process.env): number {
  const raw = (env.BOOKS_IMPORT_DAILY_LIMIT ?? '').trim();
  if (raw === '') return 500;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error('BOOKS_IMPORT_DAILY_LIMIT must be a positive integer');
  return n;
}

export type SlotResult = { ok: true; release: () => void } | { ok: false; retryAfterSec: number };

export interface CompanySlots {
  acquire(companyId: string): SlotResult;
  /** In flight now (tests). */
  inFlight(companyId: string): number;
}

export function createCompanySlots(capacity: number = EXTRACT_PARALLEL): CompanySlots {
  const running = new Map<string, number>();
  return {
    acquire(companyId) {
      const n = running.get(companyId) ?? 0;
      if (n >= capacity) return { ok: false, retryAfterSec: 5 };
      running.set(companyId, n + 1);
      let released = false;
      return {
        ok: true,
        release: () => {
          if (released) return;
          released = true;
          const now = (running.get(companyId) ?? 1) - 1;
          if (now <= 0) running.delete(companyId);
          else running.set(companyId, now);
        },
      };
    },
    inFlight: (companyId) => running.get(companyId) ?? 0,
  };
}

const globalForSlots = globalThis as unknown as { __booksImportSlots?: CompanySlots };

/** The process-wide slots (cached on globalThis, HMR-safe). */
export function companySlots(): CompanySlots {
  globalForSlots.__booksImportSlots ??= createCompanySlots();
  return globalForSlots.__booksImportSlots;
}
