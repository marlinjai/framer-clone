import 'server-only';

// src/server/customCode/liveBlocks.ts
//
// What a published page's sandboxed custom code blocks may run with, read once per
// request for a page that names a block (plan docs/plans/2026-11-02-sandboxed-custom-code.md,
// slice C3, decisions D60 onward). The declaration has one trusted source, the blob row:
// the frame never says what it may do, and neither does the page.
//
// Null, and so every block shows its fallback, when:
//   - the kill switch is not exactly `0` or the box's origin is not configured
//     (boxFrameSource, the same reading the middleware's enforced `frame-src` takes, D38);
//   - the request is a branch's preview (D44; previewSafeTree already took `customCode` off);
//   - the page names no block;
//   - the site's switch is off (read here, live, never from the cached published site, so
//     disabling a site reaches every page at its next request);
//   - the read fails: logged, and the page renders without frames.
// A blob that is blocked (its row, or the takedown list) or whose declaration does not parse
// is left out, so its block shows the fallback too. The box refuses all of these on its own.

import type { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '@/server/db';
import { parseDeclaration, type CustomCodeDeclaration } from '@/lib/customCode/contract';
import { boxFrameSource, sandboxOriginFrom } from '@/lib/customCode/customCode';
import type { LiveCustomCode } from '@/lib/renderer/server/applyCustomCode';

export interface LiveCustomCodeInput {
  siteId: string;
  /** True on a branch's public preview link. */
  preview: boolean;
  /** The hashes the page names (customCodeHashes). */
  hashes: readonly string[];
}

export async function loadLiveCustomCode(
  { siteId, preview, hashes }: LiveCustomCodeInput,
  env: { CUSTOM_CODE_DISABLED?: string; SANDBOX_ORIGIN?: string } = { CUSTOM_CODE_DISABLED: process.env.CUSTOM_CODE_DISABLED, SANDBOX_ORIGIN: process.env.SANDBOX_ORIGIN },
  prisma: Pick<PrismaClient, 'customCodeBlob' | 'customCodeBlockedHash'> = getPrismaClient(),
): Promise<LiveCustomCode | null> {
  const origin = sandboxOriginFrom(env.SANDBOX_ORIGIN);
  if (preview || hashes.length === 0 || boxFrameSource(env) === null || origin === null) return null;
  try {
    const [rows, blocked] = await Promise.all([
      prisma.customCodeBlob.findMany({
        where: { siteId, sha256: { in: [...hashes] }, blockedAt: null, site: { customCodeEnabled: true } },
        select: { sha256: true, declaration: true },
      }),
      prisma.customCodeBlockedHash.findMany({ where: { sha256: { in: [...hashes] } }, select: { sha256: true } }),
    ]);
    const takenDown = new Set(blocked.map((row) => row.sha256));
    const blobs = new Map<string, CustomCodeDeclaration>();
    for (const row of rows) {
      if (takenDown.has(row.sha256)) continue;
      const parsed = parseDeclaration(row.declaration);
      if (parsed.ok) blobs.set(row.sha256, parsed.declaration);
      else console.error(`[custom code] site ${siteId}: a stored declaration does not parse (${parsed.reason}); its block shows the fallback`);
    }
    return { siteId, origin, blobs };
  } catch (error) {
    console.error(`[custom code] site ${siteId}: the blob read failed; every block shows its fallback`, error);
    return null;
  }
}
