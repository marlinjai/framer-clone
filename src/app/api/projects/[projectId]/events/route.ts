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
// never content:
//   - `state` once on connect: the current version (the plans, agents and feed
//     lists stay empty until the presence and skeleton slices fill them);
//   - `site:version` after every committed write of the working copy, from any
//     writer (src/server/sites/liveBus.ts); its SSE id is the version, so a
//     browser that reconnects sends it back as Last-Event-ID, and a site that
//     moved on meanwhile gets one catch-up `site:version` for the current one;
//   - `auth:expired` when the session or the permission is gone (re-checked every
//     five minutes), after which the stream ends and the editor does not reconnect.
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
import { LIVE_EVENTS, type SiteStateEvent, type SiteVersionEvent } from '@/lib/projects/liveEvents';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** How often an open stream checks that its session and permission still hold. */
export const LIVE_RECHECK_MS = 5 * 60_000;

type Ctx = { params: Promise<{ projectId: string }> };

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
  const forward = (event: string, data: unknown) => {
    const id = event === LIVE_EVENTS.siteVersion ? (data as SiteVersionEvent).version : undefined;
    sse.send(event, data, id);
  };
  // Subscribed before the version is read, so a write between the two is heard.
  const unsubscribe = subscribeSite(projectId, (event, data) => {
    if (ready) forward(event, data);
    else waiting.push([event, data]);
  });

  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let recheck: ReturnType<typeof setInterval> | undefined;
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    if (heartbeat) clearInterval(heartbeat);
    if (recheck) clearInterval(recheck);
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

  const state: SiteStateEvent = { version, plans: [], agents: [], feed: [] };
  sse.send(LIVE_EVENTS.state, state, version);
  const seen = lastSeenVersion(req);
  const caughtUp = waiting.some(([event, data]) => event === LIVE_EVENTS.siteVersion && (data as SiteVersionEvent).version >= version);
  if (seen !== undefined && seen < version && !caughtUp) {
    const catchUp: SiteVersionEvent = { origin: 'editor', version, versionBefore: seen, catchUp: true };
    sse.send(LIVE_EVENTS.siteVersion, catchUp, version);
  }
  for (const [event, data] of waiting.splice(0)) forward(event, data);
  ready = true;

  heartbeat = setInterval(() => sse.heartbeat(), SSE_HEARTBEAT_MS);
  recheck = setInterval(() => {
    void (async () => {
      try {
        const again = await authorizeLiveProject(req, projectId);
        if (again.ok) return;
        sse.send(LIVE_EVENTS.authExpired, {});
        end();
      } catch (err) {
        // An outage is not a sign-out: the stream stays, the next check decides.
        if (err instanceof AuthUnavailableError || err instanceof AuthzUnavailableError) return;
        console.error(`[live] the stream of site ${projectId} could not re-check its session`, err);
      }
    })();
  }, LIVE_RECHECK_MS);

  return new Response(sse.stream, { status: 200, headers: SSE_HEADERS });
}

export const GET = withAuthAvailability(handleGET);
