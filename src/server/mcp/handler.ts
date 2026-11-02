import 'server-only';

// src/server/mcp/handler.ts
//
// The Lumitra Sites MCP endpoint (plan docs/plans/2026-11-02-lumitra-sites-agent-plugin.md,
// build step 4), modelled on Lumitra Booking's tested handler
// (lumitra-booking apps/web/src/server/mcp.ts): the Model Context Protocol over
// Streamable HTTP with no server-side session. `initialize`, `ping`,
// `tools/list` and `tools/call`; protocol versions 2025-06-18, 2025-03-26 and
// 2024-11-05; batches of 1 to 20 messages; a body size cap; GET and DELETE 405.
//
// THE KEY IS CHECKED HERE, on every request. The middleware only lets a bearer
// reach /api/mcp (and strips the cookie); it never verifies a key. A request
// without a bearer is a 401 before anything is read, and a request whose bearer
// does not verify gets machineAuthDenial's answer: 401 with WWW-Authenticate,
// 403 with the reason, 429 (the refused-key throttle) or 503 with retry-after.
//
// The one place this endpoint answers a stream: a tool that needs the person's
// yes (publish, rollback) called by a client that declared elicitation at
// initialize (read back from the signed session id, ./session.ts). The answer is
// then text/event-stream: the elicitation request, keepalive comments, and the
// tool's result. The client's answer to the question arrives as its own POST and
// is matched in ./elicitation.ts. Every other answer is plain JSON.

import { authorizeKeyAction, machineAuthDenial, redactSecrets, verifyCompanyKey, type CompanyKey, type VerifiedKey } from '@/lib/auth-machine';
import { carriesBearer, presentedBearer } from '@/lib/bearer';
import { createPageGenRateLimiter, type PageGenRateLimiter } from '@/lib/ai/pageGen/rateLimit';
import type { SiteOpsDeps } from '@/server/siteOps';
import type { SiteOpsCaller } from '@/lib/siteOps/types';
import { ConfirmationStore, type ConfirmFn } from './confirmations';
import { ask, deliver, isClientResponse } from './elicitation';
import { issueSessionId, keyFingerprint, readSessionId } from './session';
import { findTool, IMAGE_RATE, LISTED_TOOLS, runTool, WRITE_RATE, type ToolContext, type ToolResult } from './tools';
import { SERVER_INSTRUCTIONS } from './instructions';

const SERVER_INFO = { name: 'lumitra-sites', title: 'Lumitra Sites', version: '1.0.0' };
/** The protocol versions this endpoint speaks, newest first. */
export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
/** Elicitation exists from this protocol version on. */
const ELICITATION_SINCE = '2025-06-18';

/**
 * The largest request body, in bytes. One batch may hold MAX_BATCH_OPS operations,
 * and an insertNodes tree is bounded by the generator's own limit
 * (GENERATION_LIMITS.maxGenerationChars, 1,000,000 characters); 2 MiB leaves room
 * for a batch at that size and its envelope, and refuses anything larger before
 * it is parsed.
 */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
export const MAX_MESSAGES = 20;
/** How often a waiting stream sends a comment, so proxies do not close it as idle. */
const KEEPALIVE_MS = 15_000;

type JsonRpcId = string | number | null;
type JsonRpcRequest = { jsonrpc: '2.0'; id?: JsonRpcId; method: string; params?: Record<string, unknown> };

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

const rpcResult = (id: JsonRpcId, result: unknown) => ({ jsonrpc: '2.0' as const, id, result });
const rpcError = (id: JsonRpcId, code: number, message: string) => ({ jsonrpc: '2.0' as const, id, error: { code, message } });

function isRequest(value: unknown): value is JsonRpcRequest {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Record<string, unknown>;
  const idOk = c.id === undefined || c.id === null || typeof c.id === 'string' || typeof c.id === 'number';
  return (
    c.jsonrpc === '2.0' &&
    typeof c.method === 'string' &&
    idOk &&
    (c.params === undefined || (typeof c.params === 'object' && c.params !== null && !Array.isArray(c.params)))
  );
}

const JSON_HEADERS = { 'cache-control': 'no-store', 'content-type': 'application/json' };

function rpcResponse(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...extra } });
}

/** The site operations caller for a verified key: its scope and company from the verification, never from the request. */
export function keyCaller(key: VerifiedKey): SiteOpsCaller {
  return {
    scope: { ...key.scope },
    companyId: key.tenantId,
    companySlug: key.companySlug,
    actor: { kind: 'key', id: key.keyId },
    actorDetail: { serviceAccountId: key.serviceAccountId },
    can: (action) => authorizeKeyAction(key, action),
  };
}

export interface McpDeps {
  verifyKey: (request: Request) => Promise<CompanyKey>;
  siteOps?: SiteOpsDeps;
  confirmations?: ConfirmationStore;
  limits?: { writes: PageGenRateLimiter; images: PageGenRateLimiter };
  /** How long a confirmation dialog may stay open (tests shorten it). */
  elicitationTimeoutMs?: number;
}

/** Read the body up to MAX_BODY_BYTES; null when it is larger. */
async function readBounded(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export function createMcpHandler(deps: McpDeps) {
  const confirmations = deps.confirmations ?? new ConfirmationStore();
  const limits = deps.limits ?? { writes: createPageGenRateLimiter(WRITE_RATE), images: createPageGenRateLimiter(IMAGE_RATE) };

  function context(request: Request, key: VerifiedKey, confirm?: ConfirmFn): ToolContext {
    return {
      caller: keyCaller(key),
      key: { keyId: key.keyId, tenantId: key.tenantId },
      deps: deps.siteOps ?? {},
      confirm,
      confirmations,
      limits,
      signal: request.signal,
    };
  }

  function initialize(id: JsonRpcId, params: Record<string, unknown>, fingerprint: string) {
    const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const version = (PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : PROTOCOL_VERSIONS[0];
    const capabilities = (params.capabilities ?? {}) as Record<string, unknown>;
    const elicitation = version >= ELICITATION_SINCE && typeof capabilities.elicitation === 'object' && capabilities.elicitation !== null;
    return {
      reply: rpcResult(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: SERVER_INSTRUCTIONS,
      }),
      sessionId: issueSessionId({ protocolVersion: version, elicitation }, fingerprint),
    };
  }

  /** A JSON-RPC answer to one request, or null for a notification. */
  async function answer(request: Request, key: VerifiedKey, message: JsonRpcRequest, fingerprint: string): Promise<{ reply: unknown; sessionId?: string } | null> {
    const id = message.id ?? null;
    const notification = message.id === undefined;
    const params = message.params ?? {};
    switch (message.method) {
      case 'initialize':
        return notification ? null : initialize(id, params, fingerprint);
      case 'ping':
        return notification ? null : { reply: rpcResult(id, {}) };
      case 'tools/list':
        return notification ? null : { reply: rpcResult(id, { tools: LISTED_TOOLS }) };
      case 'tools/call': {
        if (notification) return null;
        const tool = findTool(params.name);
        if (!tool) return { reply: rpcError(id, INVALID_PARAMS, `unknown tool: ${redactSecrets(String(params.name))}`) };
        const result = await runTool(tool, params.arguments, context(request, key));
        return { reply: rpcResult(id, result) };
      }
      default:
        // A notification (such as `notifications/initialized`) needs no answer, whatever it is.
        if (notification) return null;
        return { reply: rpcError(id, METHOD_NOT_FOUND, `unknown method: ${redactSecrets(message.method)}`) };
    }
  }

  /**
   * A confirming tool call for a client that can show a dialog: the answer is a
   * stream carrying the elicitation request and, once the person answered (or the
   * dialog timed out and the tool fell back to a token), the tool's result.
   */
  function streamedCall(request: Request, key: VerifiedKey, message: JsonRpcRequest, fingerprint: string): Response {
    const encoder = new TextEncoder();
    const id = message.id ?? null;
    const params = message.params ?? {};
    const tool = findTool(params.name)!;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let open = true;
        const write = (text: string) => {
          if (!open) return;
          try {
            controller.enqueue(encoder.encode(text));
          } catch {
            open = false;
          }
        };
        const event = (body: unknown) => write(`event: message\ndata: ${JSON.stringify(body)}\n\n`);
        const keepalive = setInterval(() => write(': keepalive\n\n'), KEEPALIVE_MS);
        const confirm: ConfirmFn = (summary) => ask(fingerprint, summary, event, request.signal, deps.elicitationTimeoutMs);
        void (async () => {
          let result: ToolResult;
          try {
            result = await runTool(tool, params.arguments, context(request, key, confirm));
          } catch {
            result = { content: [{ type: 'text', text: 'the tool failed unexpectedly' }], structuredContent: { error: { code: 'internal_error', message: 'the tool failed unexpectedly' } }, isError: true };
          }
          clearInterval(keepalive);
          event(rpcResult(id, result));
          open = false;
          try {
            controller.close();
          } catch {
            // The client went away; nothing to close.
          }
        })();
      },
    });
    return new Response(stream, { status: 200, headers: { 'cache-control': 'no-store', 'content-type': 'text/event-stream', connection: 'keep-alive' } });
  }

  async function POST(request: Request): Promise<Response> {
    // The key first, on every request: a call without one learns nothing, and a
    // session cookie is never a way in here.
    if (!carriesBearer(request)) return machineAuthDenial({ kind: 'refused' });
    const verified = await deps.verifyKey(request);
    if (verified.kind !== 'key') return machineAuthDenial(verified);
    const fingerprint = keyFingerprint(presentedBearer(request) ?? '');

    let parsed: unknown;
    const text = await readBounded(request);
    if (text === null) return rpcResponse(rpcError(null, INVALID_REQUEST, `the request is larger than ${MAX_BODY_BYTES} bytes`), 413);
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return rpcResponse(rpcError(null, PARSE_ERROR, 'the body is not JSON'), 400);
    }
    const batch = Array.isArray(parsed);
    const messages = batch ? (parsed as unknown[]) : [parsed];
    if (messages.length === 0 || messages.length > MAX_MESSAGES) {
      return rpcResponse(rpcError(null, INVALID_REQUEST, `send one to ${MAX_MESSAGES} messages`), 400);
    }

    const session = readSessionId(request.headers.get('mcp-session-id'), fingerprint);
    // A single confirming tool call from a client with a dialog: answered as a stream.
    const acceptsStream = (request.headers.get('accept') ?? '').includes('text/event-stream');
    if (!batch && acceptsStream && isRequest(parsed) && parsed.method === 'tools/call' && parsed.id !== undefined && session?.elicitation) {
      const tool = findTool(parsed.params?.name);
      if (tool?.confirms) return streamedCall(request, verified, parsed, fingerprint);
    }

    const answers: unknown[] = [];
    let sessionId: string | undefined;
    let delivered = 0;
    for (const message of messages) {
      if (isClientResponse(message)) {
        // The client's answer to a confirmation question: matched to the call waiting on its stream.
        if (deliver(fingerprint, message)) delivered += 1;
        else answers.push(rpcError(null, INVALID_REQUEST, 'no open question of this key has that id (answered, expired, or never asked)'));
        continue;
      }
      if (!isRequest(message)) {
        answers.push(rpcError(null, INVALID_REQUEST, 'not a JSON-RPC 2.0 request'));
        continue;
      }
      const reply = await answer(request, verified, message, fingerprint);
      if (reply === null) continue;
      if (reply.sessionId) sessionId = reply.sessionId;
      answers.push(reply.reply);
    }
    // Only notifications or delivered answers: accepted, nothing to say.
    if (answers.length === 0) return new Response(null, { status: 202, headers: { 'cache-control': 'no-store' } });
    if (!batch && delivered === 0 && answers.length === 1 && isClientResponse(messages[0])) {
      return rpcResponse(answers[0], 400);
    }
    return rpcResponse(batch ? answers : answers[0], 200, sessionId ? { 'mcp-session-id': sessionId } : {});
  }

  /** This endpoint keeps no stream open for listening and no session to end. */
  function notAllowed(): Response {
    return new Response(null, { status: 405, headers: { allow: 'POST', 'cache-control': 'no-store' } });
  }

  return { POST, GET: notAllowed, DELETE: notAllowed };
}

export const mcp = createMcpHandler({ verifyKey: verifyCompanyKey });
