// scripts/docker-host.ts
//
// Shared by the integration globalSetup (vitest.integration.setup.ts) and the
// codegen script (scripts/commerce-codegen.ts): both boot a throwaway Postgres
// through testcontainers and need to find the Docker daemon the same way.
// Dependency-free on purpose (node built-ins only), because the globalSetup runs
// as plain Node.

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';

/**
 * Make testcontainers find the Docker daemon WITHOUT the caller having to export
 * DOCKER_HOST. testcontainers-node only probes a fixed set of socket paths
 * (`/var/run/docker.sock` + a few rootless paths); it does NOT consult the
 * `docker` CLI's active context. On a machine whose Docker runs under colima (or
 * any non-default runtime), that default probing fails with "Could not find a
 * working container runtime strategy" even though `docker` works fine.
 *
 * So, when DOCKER_HOST is unset, resolve a working endpoint ourselves: prefer the
 * active `docker context` endpoint, then fall back to well-known socket paths,
 * accepting only a unix socket that actually exists. This runs in globalSetup
 * BEFORE any container starts, and the env it sets is inherited by the forked
 * test workers (which boot their own containers in `.itest.ts` files), so the
 * whole integration suite self-configures. It is best-effort and never throws: a
 * properly-configured CI env (DOCKER_HOST already set) is left untouched.
 */
export function ensureDockerHost(): void {
  if (process.env.DOCKER_HOST) return;

  const candidates: string[] = [];

  // 1) The active docker CLI context's endpoint (covers colima / Docker Desktop /
  //    Rancher / remote contexts the default socket probing misses).
  try {
    const endpoint = execSync(
      "docker context inspect --format '{{.Endpoints.docker.Host}}'",
      { stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 },
    )
      .toString()
      .trim();
    if (endpoint) candidates.push(endpoint);
  } catch {
    // No docker CLI / no context: fall through to socket-path probing.
  }

  // 2) Well-known unix socket paths, in preference order.
  const home = os.homedir();
  for (const path of [
    `${home}/.colima/default/docker.sock`,
    `${home}/.rd/docker.sock`,
    `${home}/.docker/run/docker.sock`,
    '/var/run/docker.sock',
  ]) {
    candidates.push(`unix://${path}`);
  }

  for (const candidate of candidates) {
    const socketPath = candidate.startsWith('unix://')
      ? candidate.slice('unix://'.length)
      : null;
    // A unix-socket candidate must actually exist on disk; a tcp:// endpoint
    // (e.g. a remote context) is taken as-is.
    if (socketPath && !existsSync(socketPath)) continue;
    process.env.DOCKER_HOST = candidate;
    // The ryuk reaper bind-mounts the daemon socket into a container; a
    // non-default runtime (e.g. colima) cannot mount its own runtime socket
    // ("operation not supported"), which fails startup. The canonical
    // `/var/run/docker.sock` mounts fine, so leave the reaper EXACTLY as default
    // testcontainers runs it there; disable it ONLY for a non-standard
    // discovered socket. Safe: every container this harness starts is explicitly
    // `.stop()`'d in teardown / each `.itest.ts` afterAll, so the reaper is
    // redundant here. This is the only non-DOCKER_HOST env it touches, and it is
    // reached solely on the no-DOCKER_HOST fallback path.
    if (socketPath && socketPath !== '/var/run/docker.sock') {
      process.env.TESTCONTAINERS_RYUK_DISABLED ??= 'true';
    }
    break;
  }
}
