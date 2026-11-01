// src/server/sites/cspReports.ts
//
// POST /api/csp-report: browsers report here what the report-only policy of a
// published page would have blocked (src/lib/site/cspReportOnly.ts). The route
// is open and unauthenticated, as it has to be, so a report is treated as junk
// until proven otherwise:
//
//   1. limits before any work: per IP and for the whole process, because the
//      per-IP key is forgeable and a flood must not become a stream of writes;
//   2. a host that serves no published site (the editor host among them) answers
//      404 and stores nothing;
//   3. a body of at most CSP_REPORT_LIMITS.maxBodyBytes, read as a stream (413);
//   4. anything that is not a report of a measured directive against an http or
//      https address is answered 204 and dropped: a browser cannot act on a
//      refusal, and a scanner learns nothing from one.
//
// Stored: the site, the directive and the blocked address's host and port. The
// rest of the report is never kept or logged: a blocked address's path and query
// can carry what a visitor typed, and the page address, referrer, source file
// and sample belong to the visit. The IP is only a key of the in-memory limiter,
// as for the form endpoint (src/server/forms/rateLimit.ts). Process-local too,
// for the same reason as there: framer-clone runs as one container.

import { jsonError } from '@/lib/api/respond';
import { REPORTED_DIRECTIVES, type ReportedDirective } from '@/lib/site/cspReportOnly';
import { boundedText } from '@/server/books/http/boundedBody';
import { clientIpOf, SlidingWindow, type LimitResult, type WindowLimit } from '@/server/forms/rateLimit';
import type { CspViolation } from './cspReportStore';

export const CSP_REPORT_LIMITS = {
  /** Far above a real report; a longer one is a blocked address no count needs. */
  maxBodyBytes: 16 * 1024,
  /** A page with many foreign images sends one report for each of them. */
  ip: { max: 120, windowMs: 60_000 },
  everyone: { max: 1_200, windowMs: 60_000 },
  /** The longest host and port kept: a DNS name has at most 253 characters. */
  maxHostLength: 259,
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The measured directive of a report: `effective-directive`, else the first word of `violated-directive`. */
function directiveOf(report: Record<string, unknown>): ReportedDirective | null {
  const named = report['effective-directive'] ?? report['violated-directive'];
  if (typeof named !== 'string') return null;
  const directive = named.trim().split(/\s+/)[0].toLowerCase();
  return REPORTED_DIRECTIVES.find((known) => known === directive) ?? null;
}

/** The host and port of an http(s) address. Path, query, fragment and credentials never leave here. */
function hostOf(blockedUri: unknown): string | null {
  if (typeof blockedUri !== 'string') return null;
  let url: URL;
  try {
    url = new URL(blockedUri);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.host || url.host.length > CSP_REPORT_LIMITS.maxHostLength) return null;
  return url.host;
}

/** The one thing kept from a report body, or null when it is junk. */
export function parseCspReport(text: string): CspViolation | null {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  const report = isRecord(body) ? body['csp-report'] : null;
  if (!isRecord(report)) return null;
  const directive = directiveOf(report);
  const blockedHost = hostOf(report['blocked-uri']);
  return directive && blockedHost ? { directive, blockedHost } : null;
}

export interface CspReportLimiter {
  /** Check one report from `ip` against both windows, and count it when both pass. */
  hit(ip: string, now: number): LimitResult;
}

export function createCspReportLimiter(
  limits: { ip: WindowLimit; everyone: WindowLimit } = CSP_REPORT_LIMITS,
): CspReportLimiter {
  const perIp = new SlidingWindow(limits.ip);
  const everyone = new SlidingWindow(limits.everyone);
  return {
    hit(ip, now) {
      const mine = perIp.check(ip, now);
      if (!mine.ok) return mine;
      const all = everyone.check('all', now);
      if (!all.ok) return all;
      perIp.record(ip, now);
      everyone.record('all', now);
      return { ok: true };
    },
  };
}

let _limiter: CspReportLimiter | null = null;

export function getCspReportLimiter(): CspReportLimiter {
  if (!_limiter) _limiter = createCspReportLimiter();
  return _limiter;
}

/** Test-only: start from empty windows. */
export function __resetCspReportLimiterForTests(): void {
  _limiter = null;
}

export interface CspReportDeps {
  /** The published site `host` names, or null. */
  resolveSiteId(host: string | null): Promise<string | null>;
  store(siteId: string, violation: CspViolation): Promise<void>;
  limiter: CspReportLimiter;
  now(): number;
}

export async function handleCspReport(req: Request, deps: CspReportDeps): Promise<Response> {
  const limited = deps.limiter.hit(clientIpOf(req.headers), deps.now());
  if (!limited.ok) {
    const refused = jsonError('rate_limited', 'too many reports', 429);
    refused.headers.set('retry-after', String(limited.retryAfterSec));
    return refused;
  }
  try {
    const siteId = await deps.resolveSiteId(req.headers.get('host'));
    if (!siteId) return jsonError('not_found', 'not found', 404);
    const text = await boundedText(req, CSP_REPORT_LIMITS.maxBodyBytes);
    if (text === null) return jsonError('too_large', 'report too large', 413);
    const violation = parseCspReport(text);
    if (violation) await deps.store(siteId, violation);
    return new Response(null, { status: 204 });
  } catch (err) {
    // The error of a failed read or write, never the report.
    console.error('[csp-report] a report could not be stored:', err);
    return jsonError('csp_report_failed', 'the report could not be stored', 500);
  }
}
