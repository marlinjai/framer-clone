---
type: readme
title: "The box: the service that serves sandboxed custom code"
summary: "What the box is, what it refuses, how it is configured and how to test it. Built and tested only: it is deployed nowhere and connected to nothing."
---

# The box

The box is the small service that serves a *custom code block* of a site built in Lumitra Sites: the author's own HTML and JavaScript, as one document, to be run in an isolated frame. It is slice C1a of the [sandboxed custom code plan](../../docs/plans/2026-11-02-sandboxed-custom-code.md), which holds the design and every decision.

**State: built and tested only.** The box is deployed nowhere, its image is pushed nowhere, and nothing in the application imports it or its contract. The database objects it needs (the function `box_document` and the role `box_reader`) do not exist in the application yet: they are slice C1b, which waits for Marlin's yes to a production migration. Until then the tests run against a fixture.

## What it is made of

- Plain Node 22 on `node:http`, no web framework. One runtime dependency, `postgres`, bundled into a single file, so the image holds no `node_modules`.
- The contract both sides share (headers, the shell, the hash, the address) is `src/lib/customCode/contract.ts` in the application's source. The box bundles it from there, so the two cannot drift. It imports nothing.

## What it answers

| Request | Answer |
|---|---|
| `GET /box/<siteId>/<sha256>` as a cross-site frame | The document: the constant shell, then the author's document |
| The same without `Sec-Fetch-Dest: iframe` and `Sec-Fetch-Site: cross-site` | 403 |
| Any query string | 400 |
| A malformed pair, an unknown hash, another site naming a real hash | 404 |
| The site switched off, the blob blocked, the kill switch on | 410 |
| Past 60 requests a minute for one path and address, or 600 for one address | 429 |
| The database cannot be asked, or does not answer within 3 seconds | 503, with no word of the error. The connection pool is replaced, so service returns by itself |
| `GET /health` | `ok` |
| `GET /health/db` | `ok` after one call of the function, otherwise 503 and one word (`connect`, `timeout`, `denied`, `query`) |
| `GET /` | A plain page saying what the domain is, with the contacts that are configured |
| `GET /.well-known/security.txt` | Only when a security contact and an expiry are configured |
| Anything else | 404, no body. Every method but `GET` and `HEAD`: 405 |

Every answer the box writes, whatever its status, carries a Content Security Policy (CSP) and never a `Set-Cookie`. A request it does not answer at all (not HTTP, too large, too slow, an `Expect` header, a protocol upgrade, more than four requests waiting on one connection) has its connection closed. A direct visit, a flood and a malformed address are refused before the database is asked. A document is `private`, kept by the visitor's browser for five minutes, and varies by the two fetch metadata headers.

## Restrictive defaults

- **It does not serve unless told to.** A block is served only while `CUSTOM_CODE_DISABLED` is exactly `0`. Unset or anything else, every block answers 410. Changing it takes a restart of the box.
- **It does not start without its configuration,** or as root. It names the variable that is wrong, never its value.
- **`frame-ancestors` holds exact host names only.** A wildcard, a scheme, a port or any other spelling from the database is dropped, never repaired. A branch preview host (`preview-...`) is dropped even when exact, so a block shows its fallback on a preview link.
- **`X-Forwarded-For` is read only from a configured proxy,** from the right. With no proxy configured it is never read, and every visitor behind a proxy then shares one rate limit: the start line says how many proxies are believed (`trustedProxies`).
- **It reads no request body** and closes a slow, oversized or non-HTTP connection without an answer. A connection on which nothing moves for 15 seconds is closed, also when the client is the one not reading, and one peer that is not a configured proxy holds at most 64 connections.
- **It can list nothing in the database.** Its role may call one function that answers for one pair, and has no right on any table or view.
- **The log holds** a status, a route name, a duration, a network prefix and, for a well-formed pair, the site id. No path, no whole address, no user agent, no referrer.

## Configuration

| Variable | Required | Meaning |
|---|---|---|
| `BOX_DATABASE_URL` | yes | The connection string of the role `box_reader`. The only secret the box holds |
| `BOX_EDITOR_HOST` | yes | The editor's host, such as `app.lumitra.co`: named in `frame-ancestors` and in the report address |
| `BOX_SITES_BASE_HOST` | yes | The host platform subdomains live under, such as `sites.lumitra.co` |
| `CUSTOM_CODE_DISABLED` | | `0` to serve. Everything else is the kill switch being on |
| `BOX_TRUSTED_PROXIES` | | Comma-separated addresses or networks whose `X-Forwarded-For` is believed. Not wider than `/8` |
| `BOX_PORT`, `BOX_LISTEN_HOST` | | Default `8080` on `0.0.0.0` (inside the container). The listen host must be an address |
| `BOX_ABUSE_CONTACT`, `BOX_SECURITY_CONTACT`, `BOX_TAKEDOWN_URL`, `BOX_SECURITY_TXT_EXPIRES` | | What the plain page and `security.txt` show |

## Testing

```sh
cd services/box
pnpm install --ignore-workspace
pnpm typecheck
pnpm lint
pnpm test               # no database, no container
pnpm test:integration   # needs Docker: a scratch Postgres and the built image, on 127.0.0.1 only
```

The integration suite starts its own containers with random names and random passwords and removes them. It runs the image the way it is meant to run: read-only root file system, every capability dropped, no new privileges, memory and process limits.

`test/integration/fixture.sql` is a test fixture, not a migration. It also states the contract the application's migration has to meet: the function, its columns and what the role may do.

The application's type check, lint and image leave `services/` out, so `pnpm typecheck` and `pnpm lint` here, run by `.github/workflows/box.yml`, are the box's only ones. The contract module lives in the application's source and is checked on both sides.

The image is the application's digest-pinned Node base with every shell and package manager removed, and holds one file, `/app/box.cjs`.
