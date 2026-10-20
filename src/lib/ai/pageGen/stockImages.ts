// src/lib/ai/pageGen/stockImages.ts
//
// Server-only: resolve the images the page generator described (an English
// search query per img, collected by ./validate.ts) to real Unsplash photos.
//
// Unsplash API guidelines, followed here:
//   - Hotlink: the photo URL is Unsplash's own images.unsplash.com URL (the
//     `raw` URL sized with w / q / fit / auto params when the box width is
//     known, else `regular`). Nothing is downloaded or re-hosted.
//   - Attribute: every placed photo carries the photographer's name and
//     profile link and an Unsplash link, both with
//     `utm_source=<app name>&utm_medium=referral` (./stockCredit.ts).
//   - Trigger the download endpoint: `links.download_location` is called once
//     per photo actually placed in a page (triggerStockDownloads), server-side,
//     fire-and-forget with error logging.
//
// Budget (a demo key allows 50 requests per hour): one search per distinct
// query and orientation, search results cached in memory for CACHE_TTL_MS, at
// most GENERATION_LIMITS.maxStockImages images resolved per generation, and
// every request time-limited, identical searches running at the same time
// shared. The first 401 / 403 / 429 / 5xx / timeout stops further calls for
// that generation; the remaining images keep the placeholder and the summary
// says how many and why, so the dialog can tell the user. A 429 (or Unsplash
// reporting no requests left) and a 401 / 403 also pause searching for the
// whole server for a while (the circuit breaker), so later generations answer
// at once instead of spending time on requests that will fail. This
// module never throws into the generation: a stock-photo problem is a note,
// never a failed generation.
//
// The key (UNSPLASH_ACCESS_KEY) is read here, server-side, and never sent to
// the browser or written to a log. Unset means the feature is off.

import 'server-only';
import { GENERATION_LIMITS } from './schema';
import type { GeneratedNodeSnapshot, ImageOrientation, ImageRequest } from './validate';
import type { StockImageFallbackReason, StockImageSummary, StockPhotoCredit } from './protocol';
import { stockCreditProps } from './stockCredit';

const SEARCH_URL = 'https://api.unsplash.com/search/photos';
/** Results asked for per search: enough for repeated queries on one page to stay distinct. */
const PER_PAGE = 15;
/** Per request (search or download trigger). */
const REQUEST_TIMEOUT_MS = 5_000;
/** Searches in flight at once. */
const CONCURRENCY = 4;
/** How long one query's results are reused. */
export const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_MAX_ENTRIES = 500;
/** The hotlinked photo is at most this wide (2x the box, for sharp high-density screens). */
const MAX_PHOTO_WIDTH = 2400;
const DEFAULT_APP_NAME = 'lumitra';
/** Pause after a rate limit: the demo limit is per hour, so retrying sooner mostly fails. */
export const RATE_LIMIT_PAUSE_MS = 10 * 60 * 1000;
/** Pause after the key was refused: long enough to stop hammering, short enough for a fixed key to take. */
export const AUTH_PAUSE_MS = 5 * 60 * 1000;

/** One usable search result (the fields we rely on, checked). */
interface UnsplashPhoto {
  id: string;
  rawUrl?: string;
  regularUrl: string;
  photographerName: string;
  photographerProfile: string;
  downloadLocation: string;
}

/** A photo chosen for one img node. */
export interface PlacedPhoto {
  nodeId: string;
  src: string;
  credit: StockPhotoCredit;
  /** Unsplash's download-tracking endpoint for this photo (api.unsplash.com). */
  downloadLocation: string;
}

export interface StockImageResolution {
  placed: PlacedPhoto[];
  summary: StockImageSummary;
}

export interface StockImageDeps {
  /** Defaults to process.env.UNSPLASH_ACCESS_KEY. */
  accessKey?: string;
  /** Defaults to process.env.UNSPLASH_APP_NAME, then "lumitra" (the utm_source). */
  appName?: string;
  fetch?: typeof fetch;
  /** The generation's signal: a cancelled generation stops searching. */
  signal?: AbortSignal;
  timeoutMs?: number;
  now?: () => number;
}

type SearchOutcome = { ok: true; photos: UnsplashPhoto[] } | { ok: false; reason: StockImageFallbackReason };

const cache = new Map<string, { photos: UnsplashPhoto[]; expiresAt: number }>();
/** Searches in flight, shared by concurrent generations asking the same thing. */
const inflight = new Map<string, Promise<SearchOutcome>>();
/** The circuit breaker: no searches until `until`, reported as `reason`. */
let paused: { until: number; reason: StockImageFallbackReason } | undefined;

/** Test-only: forget cached search results, searches in flight and a pause. */
export function __resetStockImageCacheForTests(): void {
  cache.clear();
  inflight.clear();
  paused = undefined;
}

function pause(reason: StockImageFallbackReason, ms: number, now: number): void {
  paused = { until: now + ms, reason };
}

function logWarn(message: string, meta: Record<string, unknown>): void {
  console.warn(`[stock-images] ${message} ${JSON.stringify(meta)}`);
}

function isHttpsOn(url: unknown, host: string): url is string {
  if (typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === host;
  } catch {
    return false;
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Read one search result defensively; anything we cannot attribute or hotlink is skipped. */
function parsePhoto(raw: unknown): UnsplashPhoto | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as {
    id?: unknown;
    urls?: { raw?: unknown; regular?: unknown };
    user?: { name?: unknown; links?: { html?: unknown } };
    links?: { download_location?: unknown };
  };
  const id = str(r.id);
  const regularUrl = r.urls?.regular;
  const rawUrl = r.urls?.raw;
  const photographerName = str(r.user?.name);
  const photographerProfile = r.user?.links?.html;
  const downloadLocation = r.links?.download_location;
  if (!id || !photographerName) return undefined;
  if (!isHttpsOn(regularUrl, 'images.unsplash.com')) return undefined;
  if (!isHttpsOn(photographerProfile, 'unsplash.com')) return undefined;
  if (!isHttpsOn(downloadLocation, 'api.unsplash.com')) return undefined;
  return {
    id,
    regularUrl,
    ...(isHttpsOn(rawUrl, 'images.unsplash.com') ? { rawUrl } : {}),
    photographerName: photographerName.slice(0, 120),
    photographerProfile,
    downloadLocation,
  };
}

function withReferral(url: string, appName: string): string {
  const u = new URL(url);
  u.searchParams.set('utm_source', appName);
  u.searchParams.set('utm_medium', 'referral');
  return u.toString();
}

/** The hotlinked URL: `raw` sized to the box when its width is known, else `regular`. */
export function photoSrc(photo: Pick<UnsplashPhoto, 'rawUrl' | 'regularUrl'>, widthPx?: number): string {
  if (!photo.rawUrl || !widthPx) return photo.regularUrl;
  const u = new URL(photo.rawUrl);
  u.searchParams.set('w', String(Math.min(MAX_PHOTO_WIDTH, Math.max(1, Math.round(widthPx * 2)))));
  u.searchParams.set('q', '80');
  u.searchParams.set('fit', 'max');
  u.searchParams.set('auto', 'format');
  return u.toString();
}

function appNameFrom(deps: StockImageDeps): string {
  const raw = deps.appName ?? process.env.UNSPLASH_APP_NAME ?? DEFAULT_APP_NAME;
  const clean = raw.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_');
  return clean || DEFAULT_APP_NAME;
}

function cacheKey(query: string, orientation?: ImageOrientation): string {
  return `${query.toLowerCase()}|${orientation ?? ''}`;
}

function isTimeout(err: unknown): boolean {
  return !!err && typeof err === 'object' && 'name' in err && (err as { name: unknown }).name === 'TimeoutError';
}

async function search(
  query: string,
  orientation: ImageOrientation | undefined,
  accessKey: string,
  deps: StockImageDeps,
): Promise<SearchOutcome> {
  const now = deps.now ?? Date.now;
  const key = cacheKey(query, orientation);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now()) return { ok: true, photos: hit.photos };
  if (hit) cache.delete(key);
  if (paused && paused.until > now()) return { ok: false, reason: paused.reason };
  const running = inflight.get(key);
  if (running) return running;
  const promise = fetchSearch(key, query, orientation, accessKey, deps).finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

async function fetchSearch(
  key: string,
  query: string,
  orientation: ImageOrientation | undefined,
  accessKey: string,
  deps: StockImageDeps,
): Promise<SearchOutcome> {
  const now = deps.now ?? Date.now;
  // Logs carry the query's length, never its text (it comes from the user's brief).
  const meta = { queryChars: query.length };

  const url = new URL(SEARCH_URL);
  url.searchParams.set('query', query);
  url.searchParams.set('per_page', String(PER_PAGE));
  url.searchParams.set('content_filter', 'high');
  if (orientation) url.searchParams.set('orientation', orientation);

  const timeout = AbortSignal.timeout(deps.timeoutMs ?? REQUEST_TIMEOUT_MS);
  const signal = deps.signal ? AbortSignal.any([deps.signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await (deps.fetch ?? fetch)(url.toString(), {
      headers: { Authorization: `Client-ID ${accessKey}`, 'Accept-Version': 'v1' },
      signal,
    });
  } catch (err) {
    const reason: StockImageFallbackReason = isTimeout(err) || timeout.aborted ? 'timeout' : 'unavailable';
    if (!deps.signal?.aborted) logWarn('search failed', { reason, ...meta });
    return { ok: false, reason };
  }
  if (!res.ok) {
    const reason: StockImageFallbackReason =
      res.status === 401 || res.status === 403 ? 'auth' : res.status === 429 ? 'rate_limited' : 'unavailable';
    if (reason === 'rate_limited') pause(reason, RATE_LIMIT_PAUSE_MS, now());
    if (reason === 'auth') pause(reason, AUTH_PAUSE_MS, now());
    logWarn('search refused', { status: res.status, reason, ...meta });
    return { ok: false, reason };
  }
  // Unsplash reports the requests left this hour; at zero, pause before the next 429.
  if (res.headers.get('x-ratelimit-remaining') === '0') pause('rate_limited', RATE_LIMIT_PAUSE_MS, now());
  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    const reason: StockImageFallbackReason = isTimeout(err) || timeout.aborted ? 'timeout' : 'unavailable';
    if (!deps.signal?.aborted) logWarn('search answered with an unreadable body', { reason, ...meta });
    return { ok: false, reason };
  }
  const results = (body as { results?: unknown })?.results;
  const photos = Array.isArray(results)
    ? results.map(parsePhoto).filter((p): p is UnsplashPhoto => p !== undefined)
    : [];
  if (cache.size >= CACHE_MAX_ENTRIES) {
    // Drop the oldest entry (Map iterates in insertion order).
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { photos, expiresAt: now() + CACHE_TTL_MS });
  return { ok: true, photos };
}

function emptySummary(requested: number): StockImageSummary {
  return { requested, resolved: 0, fellBack: {}, credits: [] };
}

function countFallback(summary: StockImageSummary, reason: StockImageFallbackReason): void {
  summary.fellBack[reason] = (summary.fellBack[reason] ?? 0) + 1;
}

/**
 * Resolve the generation's image requests to distinct Unsplash photos. Never
 * throws; images that cannot be resolved keep the placeholder and are counted
 * by reason in the summary.
 */
export async function resolveStockImages(
  requests: ImageRequest[],
  deps: StockImageDeps = {},
): Promise<StockImageResolution> {
  const summary = emptySummary(requests.length);
  const placed: PlacedPhoto[] = [];
  if (requests.length === 0) return { placed, summary };

  const accessKey = (deps.accessKey ?? process.env.UNSPLASH_ACCESS_KEY ?? '').trim();
  if (!accessKey) {
    summary.fellBack.disabled = requests.length;
    return { placed, summary };
  }

  const inScope = requests.slice(0, GENERATION_LIMITS.maxStockImages);
  const overCap = requests.length - inScope.length;
  if (overCap > 0) summary.fellBack.cap = overCap;

  // One search per distinct query + orientation, a few at a time. The first
  // failure stops the rest: every later search would most likely fail the same
  // way and spend the hourly budget.
  const keys: Array<{ key: string; query: string; orientation?: ImageOrientation }> = [];
  const seen = new Set<string>();
  for (const r of inScope) {
    const key = cacheKey(r.query, r.orientation);
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push({ key, query: r.query, orientation: r.orientation });
  }
  const outcomes = new Map<string, SearchOutcome>();
  let stopReason: StockImageFallbackReason | undefined;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < keys.length && !stopReason && !deps.signal?.aborted) {
      const item = keys[next++];
      let outcome: SearchOutcome;
      try {
        outcome = await search(item.query, item.orientation, accessKey, deps);
      } catch (err) {
        logWarn('search threw', { error: err instanceof Error ? err.name : 'error' });
        outcome = { ok: false, reason: 'unavailable' };
      }
      outcomes.set(item.key, outcome);
      if (!outcome.ok) stopReason ??= outcome.reason;
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, keys.length) }, worker));

  const appName = appNameFrom(deps);
  const unsplashUrl = withReferral('https://unsplash.com/', appName);
  const used = new Set<string>();
  for (const r of inScope) {
    const outcome = outcomes.get(cacheKey(r.query, r.orientation));
    if (!outcome) {
      // Never searched: an earlier failure stopped the rest (or the generation was cancelled).
      countFallback(summary, stopReason ?? 'unavailable');
      continue;
    }
    if (!outcome.ok) {
      countFallback(summary, outcome.reason);
      continue;
    }
    const photo = outcome.photos.find((p) => !used.has(p.id));
    if (!photo) {
      countFallback(summary, 'no_results');
      continue;
    }
    used.add(photo.id);
    const credit: StockPhotoCredit = {
      photoId: photo.id,
      photographerName: photo.photographerName,
      photographerUrl: withReferral(photo.photographerProfile, appName),
      unsplashUrl,
    };
    placed.push({ nodeId: r.nodeId, src: photoSrc(photo, r.widthPx), credit, downloadLocation: photo.downloadLocation });
    summary.credits.push(credit);
    summary.resolved += 1;
  }
  return { placed, summary };
}

/** Write each placed photo (src plus credit) into its img node. Pure: returns new nodes. */
export function applyStockPhotos(nodes: GeneratedNodeSnapshot[], placed: PlacedPhoto[]): GeneratedNodeSnapshot[] {
  if (placed.length === 0) return nodes;
  const byNode = new Map(placed.map((p) => [p.nodeId, p]));
  const walk = (node: GeneratedNodeSnapshot): GeneratedNodeSnapshot => {
    const photo = byNode.get(node.id);
    const children = node.children.map(walk);
    if (!photo) return { ...node, children };
    return { ...node, props: { ...node.props, src: photo.src, ...stockCreditProps(photo.credit) }, children };
  };
  return nodes.map(walk);
}

/**
 * Tell Unsplash each placed photo was used (its download_location endpoint),
 * once per photo. Fire-and-forget: the generation never waits for it, and a
 * failure is logged, never surfaced as an error.
 */
export function triggerStockDownloads(placed: PlacedPhoto[], deps: StockImageDeps = {}): void {
  const accessKey = (deps.accessKey ?? process.env.UNSPLASH_ACCESS_KEY ?? '').trim();
  if (!accessKey) return;
  const doFetch = deps.fetch ?? fetch;
  const done = new Set<string>();
  for (const p of placed) {
    if (done.has(p.credit.photoId) || !isHttpsOn(p.downloadLocation, 'api.unsplash.com')) continue;
    done.add(p.credit.photoId);
    void Promise.resolve()
      .then(() =>
        doFetch(p.downloadLocation, {
          headers: { Authorization: `Client-ID ${accessKey}`, 'Accept-Version': 'v1' },
          signal: AbortSignal.timeout(deps.timeoutMs ?? REQUEST_TIMEOUT_MS),
        }),
      )
      .then((res) => {
        if (!res.ok) logWarn('download trigger refused', { status: res.status, photoId: p.credit.photoId });
      })
      .catch((err: unknown) => {
        logWarn('download trigger failed', {
          photoId: p.credit.photoId,
          error: err instanceof Error ? err.name : String(err),
        });
      });
  }
}
