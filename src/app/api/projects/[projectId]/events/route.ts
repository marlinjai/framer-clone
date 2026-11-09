// src/app/api/projects/[projectId]/events/route.ts
//
// GET /api/projects/<projectId>/events: the site's live stream for an open
// editor (plan docs/plans/2026-11-08-live-agent-canvas.md, section 1), as
// server-sent events (SSE: one long response of named events).
//
// Guarded like the save route (src/server/sites/liveGuard.ts): editor host (404),
// a verified session cookie (401), the active company with the `sites` grant
// (403), `editSite` on its workspace (403), the project in that workspace (404);
// auth-brain or OpenFGA outages answer 503 through withAuthAvailability.
//
// What it sends (src/lib/projects/liveEvents.ts), ids and server-written lines only,
// never stored content (the one exception is a running MCP generate_page's draft,
// below):
//   - `state` once on connect: the current version, the agents active on the
//     site with their last focus (src/server/sites/livePresence.ts) and the last
//     30 feed lines (the site's audit rows, scoped to the caller's workspace,
//     merged with the live lines of reads and refusals) and the skeleton plans
//     agents announced on it (src/server/mcp/livePlans.ts), never one that ended,
//     and the MCP generate_page running on it with its draft so far
//     (src/server/sites/liveGeneration.ts), read with the scope this stream's
//     guard verified, so a reload mid-run draws the same draft;
//   - `gen:outline`, `gen:section` and `gen:done` while an MCP generate_page
//     runs on the site: its outline, its preview sections (the model's output
//     before it is saved, which this guard lets only the site's editors see,
//     bounded by GEN_DRAFT_LIMITS) and how it ended, `gen:done` always before the
//     `site:version` of its save;
//   - `plan:update` when an agent announces, replaces, fulfils, clears or loses a
//     skeleton plan;
//   - `agent:activity` when an MCP tool call on the site starts and ends
//     (src/server/mcp/presence.ts);
//   - `site:version` after every committed write of the working copy, from any
//     writer (src/server/sites/liveBus.ts), flagged `own` on the stream of the
//     tab that wrote it (`?tab=<id>`; tab ids themselves are never sent, so no
//     editor can pass for another); its SSE id is the version, so a
//     browser that reconnects sends it back as Last-Event-ID, and a site that
//     moved on meanwhile gets one catch-up `site:version` for the current one;
//   - `auth:expired` when the session or the permission is gone (re-checked every
//     five minutes, and on a write or a draft event of a running generation heard
//     more than 30 s after the last check),
//     after which the stream ends and the editor does not reconnect.
//
// Bounds: at most 4 streams per session, 50 per site and 1,000 per process; over
// a bound the answer is 429 and the editor polls the snapshot route instead. The
// stream ends when the browser goes away, which unsubscribes from the bus.

import { createHash } from 'node:crypto';
import { withAuthAvailability, AuthUnavailableError, AuthzUnavailableError } from '@/lib/authBrainAvailability';
import { jsonError } from '@/lib/api/respond';
import { createSseStream, SSE_HEADERS, SSE_HEARTBEAT_MS } from '@/lib/ai/sse';
import { authorizeLiveProject } from '@/server/sites/liveGuard';
import { acquireStreamSlot, subscribeSite } from '@/server/sites/liveBus';
import { getSiteRepository } from '@/server/sites';
import { presenceSnapshot } from '@/server/sites/livePresence';
import { plansSnapshot } from '@/server/mcp/livePlans';
import { generationSnapshot } from '@/server/sites/liveGeneration';
import { recentSiteOperations } from '@/server/siteOps/audit';
import { getPrismaClient } from '@/server/db';
import type { TenantScope } from '@/server/sites/repository';
import {
  LIVE_EVENTS,
  LIVE_FEED_MAX,
  LIVE_RECHECK_MS,
  LIVE_RECHECK_ON_WRITE_MS,
  ORIGIN_TAB_PATTERN,
  type LiveFeedLine,
  type SiteStateEvent,
  type SiteVersionEvent,
} from '@/lib/projects/liveEvents';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ projectId: string }> };

/** How long an access check may take; past it, it counts as an outage (never a sign-out) and held draft events go. */
const CHECK_TIMEOUT_MS = 10_000;
/** Events held behind such a check at most; past this the stream ends and the editor reconnects. */
const GATE_QUEUE_MAX = 500;

/** The bound "per session" counts streams of one session cookie, never its value. */
function sessionKey(req: Request, userId: string): string {
  const cookie = /(?:^|;\s*)lumitra_session=([^;]+)/.exec(req.headers.get('cookie') ?? '')?.[1];
  return cookie ? createHash('sha256').update(cookie).digest('base64url').slice(0, 22) : `user:${userId}`;
}

/** The Last-Event-ID a reconnecting browser sent: the last version it heard. */
function lastSeenVersion(req: Request): number | undefined {
  const raw = req.headers.get('last-event-id');
  if (!raw || !/^\d{1,10}$/.test(raw)) return undefined;
  return Number(raw);
}

/**
 * The feed a newly opened editor starts with: the site's last writes from the
 * audit table (scoped to the caller's workspace) and the live lines that leave
 * no row (reads, refusals), newest first, LIVE_FEED_MAX at most. The audit read
 * failing costs the backfill, never the stream.
 */
async function feedFor(scope: TenantScope, siteId: string, live: LiveFeedLine[]): Promise<LiveFeedLine[]> {
  let stored: LiveFeedLine[] = [];
  try {
    stored = await recentSiteOperations(getPrismaClient(), scope, siteId, LIVE_FEED_MAX);
  } catch (err) {
    console.error(`[live] the activity feed of site ${siteId} could not be read for its stream`, err);
  }
  return [...stored, ...live].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, LIVE_FEED_MAX);
}

async function handleGET(req: Request, { params }: Ctx): Promise<Response> {
  const { projectId } = await params;
  const auth = await authorizeLiveProject(req, projectId);
  if (!auth.ok) return auth.response;

  const release = acquireStreamSlot(projectId, sessionKey(req, auth.session.user.id));
  if (!release) {
    const refused = jsonError('too_many_streams', 'too many live streams are open; the editor checks for changes instead', 429);
    refused.headers.set('retry-after', '60');
    return refused;
  }

  const sse = createSseStream();
  // Events heard before `state` went out wait for it, so nothing is lost or reordered.
  let ready = false;
  const waiting: Array<[string, unknown]> = [];
  // The tab this stream belongs to (`?tab=`): its own writes are flagged `own`,
  // and no tab id is ever sent to anyone.
  const tabParam = new URL(req.url).searchParams.get('tab');
  const tab = tabParam && ORIGIN_TAB_PATTERN.test(tabParam) ? tabParam : undefined;
  let lastCheck = Date.now();
  let inflight: Promise<void> | undefined;
  /** Re-check the session and the permission; a check already running is shared. */
  const check = (): Promise<void> => {
    if (ended) return Promise.resolve();
    inflight ??= (async () => {
      lastCheck = Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // A check that does not answer in time counts as an outage, and the next one really runs again.
        const deadline = new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), CHECK_TIMEOUT_MS);
        });
        const again = await Promise.race([authorizeLiveProject(req, projectId), deadline]);
        // Timed out, or the browser left while the check ran.
        if (again === 'timeout' || again.ok || ended) return;
        sse.send(LIVE_EVENTS.authExpired, {});
        end();
      } catch (err) {
        // An outage is not a sign-out: the stream stays, the next check decides.
        if (err instanceof AuthUnavailableError || err instanceof AuthzUnavailableError) return;
        console.error(`[live] the stream of site ${projectId} could not re-check its session`, err);
      } finally {
        clearTimeout(timer);
        inflight = undefined;
      }
    })();
    return inflight;
  };
  // A running generation's draft is content: when the last check is older than
  // LIVE_RECHECK_ON_WRITE_MS, it waits for a check, and everything after it waits
  // too (so the order holds); a stream whose access is gone gets none of it. A
  // check that does not answer within CHECK_TIMEOUT_MS lets the queue go, as an
  // outage does (an outage is not a sign-out); a queue that grows past
  // GATE_QUEUE_MAX ends the stream, and the editor reconnects.
  let gated: Array<[string, unknown]> | undefined;
  const send = (event: string, data: unknown) => {
    if (event !== LIVE_EVENTS.siteVersion) {
      sse.send(event, data);
      return;
    }
    const { originTab, ...rest } = data as SiteVersionEvent;
    const out: SiteVersionEvent = tab && originTab === tab ? { ...rest, own: true } : rest;
    sse.send(event, out, out.version);
    if (Date.now() - lastCheck > LIVE_RECHECK_ON_WRITE_MS) void check();
  };
  /** Whether a draft event must wait for a check: one is running (its answer is not in yet), or the last one is old. */
  const checkDue = () => inflight !== undefined || Date.now() - lastCheck > LIVE_RECHECK_ON_WRITE_MS;
  const forward = (event: string, data: unknown) => {
    if (gated) {
      gated.push([event, data]);
      if (gated.length > GATE_QUEUE_MAX) end();
      return;
    }
    const content = event === LIVE_EVENTS.genOutline || event === LIVE_EVENTS.genSection;
    if (content && checkDue()) {
      const queue: Array<[string, unknown]> = [[event, data]];
      gated = queue;
      void check().then(() => {
        gated = undefined;
        if (ended) return;
        for (const [e, d] of queue) forward(e, d);
      });
      return;
    }
    send(event, data);
  };
  // Subscribed before the version is read, so a write between the two is heard.
  const unsubscribe = subscribeSite(projectId, (event, data) => {
    if (ready) forward(event, data);
    else {
      waiting.push([event, data]);
      // Bounded like the gate: a read that stalls cannot hold draft content without limit.
      if (waiting.length > GATE_QUEUE_MAX) end();
    }
  });

  const timers: { heartbeat?: ReturnType<typeof setInterval>; recheck?: ReturnType<typeof setInterval> } = {};
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    if (timers.heartbeat) clearInterval(timers.heartbeat);
    if (timers.recheck) clearInterval(timers.recheck);
    waiting.length = 0;
    gated = undefined;
    unsubscribe();
    release();
    sse.close();
  };
  req.signal?.addEventListener('abort', end, { once: true });
  sse.signal.addEventListener('abort', end, { once: true });

  let version = auth.version;
  try {
    version = await getSiteRepository().getSiteVersion(auth.scope, projectId);
  } catch (err) {
    // The guard just read it; a failure now ends the stream and the editor reconnects.
    console.error(`[live] the version of site ${projectId} could not be read for its stream`, err);
    end();
    return new Response(sse.stream, { status: 200, headers: SSE_HEADERS });
  }

  const presence = presenceSnapshot(projectId);
  // The plans announced under the scope this stream's guard verified; one whose time ran out is never sent.
  const feed = await feedFor(auth.scope, projectId, presence.feed);
  // The draft is content: when the initialization took long enough for access to have changed,
  // the same gate as for draft events applies before it is read and sent.
  if (checkDue()) {
    await check();
    if (ended) return new Response(sse.stream, { status: 200, headers: SSE_HEADERS });
  }
  // Read after the feed's await, so a run that ended meanwhile is not drawn again (its gen:done is in `waiting`).
  const generation = generationSnapshot(projectId, auth.scope);
  const state: SiteStateEvent = { version, plans: plansSnapshot(projectId, auth.scope), agents: presence.agents, feed, ...(generation ? { generation } : {}) };
  if (ended) return new Response(sse.stream, { status: 200, headers: SSE_HEADERS });
  sse.send(LIVE_EVENTS.state, state, version);
  const seen = lastSeenVersion(req);
  const caughtUp = waiting.some(([event, data]) => event === LIVE_EVENTS.siteVersion && (data as SiteVersionEvent).version >= version);
  if (seen !== undefined && seen < version && !caughtUp) {
    const catchUp: SiteVersionEvent = { origin: 'editor', version, versionBefore: seen, catchUp: true };
    sse.send(LIVE_EVENTS.siteVersion, catchUp, version);
  }
  for (const [event, data] of waiting.splice(0)) forward(event, data);
  ready = true;

  // The browser may already be gone (it left while the version was read): no timers then.
  if (ended) return new Response(sse.stream, { status: 200, headers: SSE_HEADERS });
  timers.heartbeat = setInterval(() => sse.heartbeat(), SSE_HEARTBEAT_MS);
  timers.recheck = setInterval(() => void check(), LIVE_RECHECK_MS);

  return new Response(sse.stream, { status: 200, headers: SSE_HEADERS });
}

export const GET = withAuthAvailability(handleGET);
