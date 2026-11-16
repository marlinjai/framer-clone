---
type: readme
title: "The box: the service that serves sandboxed custom code"
summary: "What the box is, what it refuses, how it is configured, started, deployed and tested. Its image logs in to Infisical and its workflow can publish and deploy it, but stays inert until the operator step O1 has created the infrastructure."
---

# The box

The box is the small service that serves a *custom code block* of a site built in Lumitra Sites: the author's own HTML and JavaScript, as one document, to be run in an isolated frame. It is slice C1a of the [sandboxed custom code plan](../../docs/plans/2026-11-02-sandboxed-custom-code.md), which holds the design and every decision.

**State: ready to deploy, deployed nowhere yet.** The image starts by logging in to Infisical, and `.github/workflows/box.yml` can push it and deploy it (the repository half of step O1, built 2026-11-17), but it does neither until the operator has created the box's infrastructure and set two repository secrets (see "Deploying" below). Nothing in the application imports the box or its contract. The database objects it needs exist in this repository (slice C1b): the function `box_document` in the migration `prisma/migrations/20261115000000_custom_code`, which a deployment applies at its start, and the role `box_reader` in `prisma/sql/box-reader.sql`, which the operator applies separately (see `deploy/README.md`, "Sandboxed custom code"). The box's integration suite builds its database from those files.

## What it is made of

- Plain Node 22 on `node:http`, no web framework. One runtime dependency, `postgres`, bundled into a single file, so the image holds no `node_modules`.
- One connection to the database. The box opens that socket itself (`src/socketGate.ts`): after a connection that did not last it pauses before opening another, and it closes a silent one for real.
- The contract both sides share (headers, the shell, the hash, the address) is `src/lib/customCode/contract.ts` in the application's source. The box bundles it from there, so the two cannot drift. It imports nothing.
- A start program, `src/launch.ts`, bundled on its own: it logs in to Infisical and runs the box inside `infisical run` (see "How it starts").

## What it answers

| Request | Answer |
|---|---|
| `GET /box/<siteId>/<sha256>` as a cross-site frame | The document: the constant shell, then the author's document |
| The same without `Sec-Fetch-Dest: iframe` and `Sec-Fetch-Site: cross-site` | 403 |
| Any query string | 400 |
| A malformed pair, an unknown hash, another site naming a real hash | 404 |
| The site switched off, the blob blocked, the kill switch on | 410 |
| Past 60 requests a minute for one path and address, or 600 for one address | 429 |
| The database cannot be asked, or does not answer within 3 seconds | 503, with no word of the error. A database that went silent has its connections closed and replaced, so service returns by itself; one that is only busy keeps them. After a connection that did not last, new calls fail at once for a short pause (up to two seconds) |
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
| `BOX_DATABASE_URL` | yes | Comes from Infisical, never from the container (the start program refuses to start when the container sets it). The connection string of the role `box_reader`. The only secret the box holds. One host by name or IPv4 address, a role, a database, and no parameter but `sslmode=disable`. This version speaks to the database without encryption, over a private network the two share, and does not start with an address that asks for it (plan, decision D23) |
| `BOX_EDITOR_HOST` | yes | The editor's host, such as `app.lumitra.co`: named in `frame-ancestors` and in the report address |
| `BOX_SITES_BASE_HOST` | yes | The host platform subdomains live under, such as `sites.lumitra.co` |
| `CUSTOM_CODE_DISABLED` | | `0` to serve. Everything else is the kill switch being on |
| `BOX_TRUSTED_PROXIES` | | Comma-separated addresses or networks whose `X-Forwarded-For` is believed. Not wider than `/8` |
| `BOX_PORT`, `BOX_LISTEN_HOST` | | Default `8080` on `0.0.0.0` (inside the container). The listen host must be an address |
| `BOX_ABUSE_CONTACT`, `BOX_SECURITY_CONTACT`, `BOX_TAKEDOWN_URL`, `BOX_SECURITY_TXT_EXPIRES` | | What the plain page and `security.txt` show |

The box's settings (every variable above but `BOX_DATABASE_URL`) are not secrets and are set on the Coolify application. A variable of the same name in the Infisical project would override the container's value inside `infisical run`, so the project holds `BOX_DATABASE_URL` and nothing else.

## How it starts

The image's entrypoint is `tini`, then `node /opt/box/launch.cjs` (the bundled `src/launch.ts`, decision D45 of the plan). The start program:

1. refuses to run as root, and checks its own variables (below). A missing or malformed one stops it with status 78 and a line naming the variable, never its value, before anything is started;
2. logs in with the box's machine identity: `infisical login --method=universal-auth --silent --plain`, with the client id and secret in the client's environment, never on its command line, and the token read from a pipe and never written. A refused or hanging login (30 seconds) stops it with status 69 and the client's own message, with every credential taken out;
3. runs `infisical run` for the box's project and environment, with the token in its environment, never as an argument, and the box under it through `env -u INFISICAL_TOKEN`, so the box's environment holds `BOX_DATABASE_URL` and no credential;
4. passes on everything `infisical run` and the box write to standard error, a line at a time with every credential taken out (the client holds the token while it runs), and the box's request log on standard output as it is;
5. passes SIGTERM and SIGINT on and ends with the status `infisical run` ends with, saying so when it is not 0. `infisical run` reports a child that failed as status 1, so a box that refuses its configuration (78) ends the container with 1, and so does a fetch of the secrets that Infisical refuses; the box's own line or the client's reason says which (decision D46).

| Variable | Required | Meaning |
|---|---|---|
| `INFISICAL_UNIVERSAL_AUTH_CLIENT_ID`, `INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET` | yes | The box's own machine identity, which can read the box's project and nothing else (decision D12) |
| `INFISICAL_PROJECT_ID` | yes | The id of the Infisical project `framer-clone-box`. Not a secret |
| `INFISICAL_ENVIRONMENT` | yes | The environment slug in that project, `prod` |
| `INFISICAL_DOMAIN` | | Default `https://infisical.lumitra.co`. https and a host only; plain http only for a host without a dot (a container name, which the image test uses) |

Every other `INFISICAL_` variable of the container is dropped before the client starts. The client sends no telemetry and writes nothing: it runs on the read-only root file system with no writable home, as the image test proves.

## Deploying

What the operator sets in step O1 (the ordered steps are in the infra repository's runbook; `deploy/README.md` in the application has the same list):

- **Infisical:** a project `framer-clone-box` with one secret, `BOX_DATABASE_URL` (the `box_reader` connection string, on the private network the box shares with the database, `sslmode=disable` or none: decision D23), in the environment `prod`, at the path `/`. A machine identity with universal auth that may read that project and no other.
- **Coolify:** an application `framer-clone-box` from the image `ghcr.io/marlinjai/framer-clone-box:latest`, on the network of the application's Postgres, port 8080, health check `GET /health` on 127.0.0.1, read-only root file system, every capability dropped, no new privileges, 0.5 CPU, 256 megabytes and a process limit of at least 64 (decision D11). No volume and no temporary file system: the box writes nothing. Its environment: the four `INFISICAL_` variables above and the box's settings (`BOX_EDITOR_HOST`, `BOX_SITES_BASE_HOST`, `BOX_TRUSTED_PROXIES`, the contacts, and `CUSTOM_CODE_DISABLED=0` once serving is decided).
- **GitHub:** the repository secrets `COOLIFY_BOX_WEBHOOK` (the box application's deploy webhook) and `COOLIFY_TOKEN` (the Coolify API token the application's deploy already uses). Until both are set, the workflow pushes no image and deploys nothing, and says so in a notice. If the package `framer-clone-box` on GHCR stays private, Coolify needs a registry login for it.

Then a push to main that touches the box, or a manual run of the `box` workflow on main, tests the image, pushes exactly that image (tags: the commit and `latest`), calls the webhook and waits until `https://run.lumitrausercontent.com/health/db` answers (decisions D48 and D49).

## Testing

```sh
cd services/box
pnpm install --ignore-workspace
pnpm typecheck
pnpm lint
pnpm test               # no database, no container
pnpm test:integration   # needs Docker: a scratch Postgres and the built image, on 127.0.0.1 only
```

The integration suite starts its own containers with random names and random passwords and removes them. It runs the image the way it is meant to run: read-only root file system, every capability dropped, no new privileges, memory and process limits, and every box starts through the real entrypoint and the real Infisical client against a stand-in for Infisical (`test/integration/fakeInfisical.ts`) on the suite's private network, which hands out the scratch database's address. `test/launch.test.ts` holds the start program's rules with stand-ins for the client and the box.

The database is the application's own, built from the committed files in production's order: `prisma/sql/commerce-roles.sql`, every migration in `prisma/migrations` in order, then `prisma/sql/box-reader.sql` (`applicationSchema` in `test/integration/docker.ts`). It is the state of a first build: `commerce-roles.sql` is not applied again after the first start, so `commerce_ddl` still holds CREATE on `public` there, which the test that plants a `public.to_json` relies on. So a change to a migration or a role file that breaks the box fails here; `.github/workflows/box.yml` runs on changes to both folders.

The application's type check, lint and image leave `services/` out, so `pnpm typecheck` and `pnpm lint` here, run by `.github/workflows/box.yml`, are the box's only ones. The contract module lives in the application's source and is checked on both sides.

The image is the application's digest-pinned Node base with every shell and package manager removed. It adds the service (`/app/box.cjs`, alone in its directory), the start program (`/opt/box/launch.cjs`), the Infisical client and `tini` (each pinned by version and SHA-256 in `Dockerfile.box`), and Debian's certificate authorities for the client's https.
