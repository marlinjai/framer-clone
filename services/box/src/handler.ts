// services/box/src/handler.ts
//
// Every decision the box makes about a request, as one function from a
// request to an answer, with no socket in it, so each refusal can be tested
// without a network. Plan: docs/plans/2026-11-02-sandboxed-custom-code.md,
// "The box service".
//
// The order of the checks is part of the contract:
//   1. the method (405);
//   2. the shape of the request target (400);
//   3. the address's overall rate limit (429), before anything is looked up;
//   4. a query string (400);
//   5. for a block: the two fetch metadata headers (403), the shape of the
//      pair (404), the kill switch (410), the rate limit of the path (429),
//      and only then the cache and the database.
// So a direct visit, a flood and a malformed address never reach the database.

import {
  BOX_LIMITS,
  boxDocumentHeaders,
  boxRefusalHeaders,
  composeBoxDocument,
  isCrossSiteFrameRequest,
  parseBoxPath,
  siteHostsOf,
} from '../../../src/lib/customCode/contract';
import { LookupCache, type CachedLookup } from './cache';
import { clientAddressOf } from './clientAddress';
import type { BoxConfig } from './config';
import { RateLimiter } from './rateLimit';
import { storeFailureOf, type BoxStore, type StoreFailure } from './store';

export interface BoxRequest {
  method: string | undefined;
  url: string | undefined;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  remoteAddress: string | undefined;
}

export type BoxRoute = 'box' | 'health' | 'health-db' | 'info' | 'security-txt' | 'other';

export interface BoxResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  /** For the log line. `siteId` is set only for a well-formed pair that came as a frame request. */
  route: BoxRoute;
  siteId: string | null;
  logPrefix: string;
}

export interface BoxHandlerOptions {
  config: BoxConfig;
  store: BoxStore;
  /** Reads the kill switch, on every request. */
  killSwitchOn: () => boolean;
  now?: () => number;
  /** Overrides for tests. */
  cacheBytes?: number;
  cacheTtlMs?: number;
  cacheMisses?: number;
  maxPendingLookups?: number;
  rateLimitKeys?: number;
}

const EMPTY = Buffer.alloc(0);
const MAX_TARGET_LENGTH = 2048;
const HEALTH_DB_TTL_MS = 5000;

export function createBoxHandler(options: BoxHandlerOptions): (request: BoxRequest) => Promise<BoxResponse> {
  const { config, store, killSwitchOn } = options;
  const now = options.now ?? Date.now;
  const cache = new LookupCache(options.cacheBytes ?? 32 * 1024 * 1024, options.cacheTtlMs ?? 60_000, options.cacheMisses ?? 4096);
  const maxPending = options.maxPendingLookups ?? 64;
  const keys = options.rateLimitKeys ?? 50_000;
  // 600 requests a minute per address, and 60 a minute per address and path.
  const overall = new RateLimiter({ capacity: 600, windowMs: 60_000, maxKeys: keys });
  const perPath = new RateLimiter({ capacity: 60, windowMs: 60_000, maxKeys: keys });
  const pending = new Map<string, Promise<CachedLookup | StoreFailure>>();
  let healthDb: { at: number; failure: StoreFailure | null } | null = null;
  let healthDbPending: Promise<StoreFailure | null> | null = null;

  const infoPage = Buffer.from(
    [
      'This domain serves sandboxed customer code for sites hosted by Lumitra.',
      'It holds no pages of its own, and what it serves runs only inside a frame on the site that owns it.',
      ...(config.abuseContact ? [`Abuse: ${config.abuseContact}`] : []),
      ...(config.takedownUrl ? [`Takedown: ${config.takedownUrl}`] : []),
      ...(config.securityContact ? [`Security: ${config.securityContact}`] : []),
      '',
    ].join('\n'),
    'utf8',
  );
  const securityTxt =
    config.securityContact && config.securityTxtExpires
      ? Buffer.from(`Contact: mailto:${config.securityContact}\nExpires: ${config.securityTxtExpires}\n`, 'utf8')
      : null;

  async function lookup(key: string, siteId: string, sha256: string): Promise<CachedLookup | StoreFailure> {
    const cached = cache.get(key, now());
    if (cached) return cached;
    const running = pending.get(key);
    if (running) return running;
    // The database is asked by a bounded number of requests at once; the rest are told to come back.
    if (pending.size >= maxPending) return 'timeout';
    const started = (async (): Promise<CachedLookup | StoreFailure> => {
      try {
        const row = await store.find(siteId, sha256);
        let value: CachedLookup;
        if (!row) {
          value = { kind: 'missing' };
        } else if (typeof row.document !== 'string' || Buffer.byteLength(row.document, 'utf8') > BOX_LIMITS.documentBytes) {
          // A row the box will not serve: not text, or larger than a block may be. Remembered as not live.
          value = { kind: 'found', live: false, body: EMPTY, frameAncestorHosts: [] };
        } else {
          value = {
            kind: 'found',
            // Only the boolean `true` is live.
            live: row.live === true,
            body: Buffer.from(composeBoxDocument(row.document), 'utf8'),
            frameAncestorHosts: siteHostsOf(row.subdomainLabels, row.customHostnames, config.sitesBaseHost),
          };
        }
        cache.set(key, value, now());
        return value;
      } catch (error) {
        // Never remembered: the next request asks again, so service comes back with the database.
        return storeFailureOf(error);
      } finally {
        pending.delete(key);
      }
    })();
    pending.set(key, started);
    return started;
  }

  async function databaseHealth(): Promise<StoreFailure | null> {
    const at = now();
    if (healthDb && at - healthDb.at < HEALTH_DB_TTL_MS) return healthDb.failure;
    healthDbPending ??= (async () => {
      let failure: StoreFailure | null = null;
      try {
        await store.ping();
      } catch (error) {
        failure = storeFailureOf(error);
      }
      healthDb = { at: now(), failure };
      healthDbPending = null;
      return failure;
    })();
    return healthDbPending;
  }

  return async function handle(request) {
    const client = clientAddressOf(request.remoteAddress, request.headers['x-forwarded-for'], config.trustedProxies);
    const answer = (
      status: number,
      route: BoxRoute,
      extra: Record<string, string> = {},
      body: Buffer = EMPTY,
      siteId: string | null = null,
    ): BoxResponse => ({
      status,
      headers: { ...boxRefusalHeaders(), ...extra, 'Content-Length': String(body.length) },
      body,
      route,
      siteId,
      logPrefix: client.logPrefix,
    });

    if (request.method !== 'GET' && request.method !== 'HEAD') return answer(405, 'other', { Allow: 'GET, HEAD' });

    const target = request.url;
    // Origin form only, printable ASCII only: no absolute address, no fragment, no control character, no backslash.
    if (typeof target !== 'string' || target.length > MAX_TARGET_LENGTH || !/^\/[\x21-\x7e]*$/.test(target) || /[#\\]/.test(target)) {
      return answer(400, 'other');
    }

    if (!overall.take(client.key, now())) return answer(429, 'other', { 'Retry-After': '60' });

    const mark = target.indexOf('?');
    const path = mark === -1 ? target : target.slice(0, mark);
    const hasQuery = mark !== -1;

    if (path === '/health') {
      if (hasQuery) return answer(400, 'health');
      return answer(200, 'health', {}, Buffer.from('ok'));
    }

    if (path === '/health/db') {
      if (hasQuery) return answer(400, 'health-db');
      const failure = await databaseHealth();
      if (failure) return answer(503, 'health-db', { 'Retry-After': '5' }, Buffer.from(`unavailable: ${failure}`));
      return answer(200, 'health-db', {}, Buffer.from('ok'));
    }

    if (path === '/') {
      if (hasQuery) return answer(400, 'info');
      return answer(200, 'info', {}, infoPage);
    }

    if (path === '/.well-known/security.txt') {
      if (hasQuery) return answer(400, 'security-txt');
      return securityTxt ? answer(200, 'security-txt', {}, securityTxt) : answer(404, 'security-txt');
    }

    if (!path.startsWith('/box/')) return answer(404, 'other');

    // A block is served to a frame on another site, and to nothing else.
    if (!isCrossSiteFrameRequest(request.headers['sec-fetch-dest'], request.headers['sec-fetch-site'])) return answer(403, 'box');
    if (hasQuery) return answer(400, 'box');
    const address = parseBoxPath(path);
    if (!address) return answer(404, 'box');
    const { siteId, sha256 } = address;
    if (killSwitchOn()) return answer(410, 'box', {}, EMPTY, siteId);

    const key = `${siteId}/${sha256}`;
    if (!perPath.take(`${client.key}|${key}`, now())) return answer(429, 'box', { 'Retry-After': '60' }, EMPTY, siteId);

    const found = await lookup(key, siteId, sha256);
    if (typeof found === 'string') return answer(503, 'box', { 'Retry-After': '5' }, EMPTY, siteId);
    if (found.kind === 'missing') return answer(404, 'box', {}, EMPTY, siteId);
    if (!found.live) return answer(410, 'box', {}, EMPTY, siteId);

    return {
      status: 200,
      headers: { ...boxDocumentHeaders(found.frameAncestorHosts, config.editorHost), 'Content-Length': String(found.body.length) },
      body: found.body,
      route: 'box',
      siteId,
      logPrefix: client.logPrefix,
    };
  };
}
