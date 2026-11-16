// services/box/src/launch.ts
//
// How the box is started in its image (plan, decision D45): log in to
// Infisical with the box's own machine identity, then run the box inside
// `infisical run`, which puts the one secret, BOX_DATABASE_URL, into the box's
// environment. The image has no shell, so this is a small node program in
// place of the application's entrypoint.sh.
//
// What it guarantees, each held by a test in test/launch.test.ts:
// - The client id, the client secret and the access token are never on a
//   command line (any process can read another's argv). The client
//   credentials reach `infisical login` only through its environment, the
//   token reaches `infisical run` only through its environment, and the box's
//   own environment holds neither.
// - Nothing it writes holds a credential: the token is read from a pipe and
//   never written, and what `infisical login` says on failure is passed on
//   with every credential taken out.
// - A missing or malformed variable, or a failed login, stops it with a line
//   naming what is wrong, and a non-zero status, before anything is started.
// - SIGTERM and SIGINT are passed to the child, and it ends with the child's
//   status (128 plus the signal's number when the child was ended by one).

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { constants as osConstants } from 'node:os';

/** The status for a configuration it cannot use (sysexits EX_CONFIG, as the box itself uses). */
export const EXIT_CONFIG = 78;
/** The status for a login that did not give a token (sysexits EX_UNAVAILABLE). */
export const EXIT_LOGIN = 69;

/** The Infisical instance of the stack. INFISICAL_DOMAIN may name another (decision D47). */
export const DEFAULT_INFISICAL_DOMAIN = 'https://infisical.lumitra.co';

/** How long a login may take before it is given up on. */
export const LOGIN_TIMEOUT_MS = 30_000;

type Env = Readonly<Record<string, string | undefined>>;

export interface LaunchPaths {
  /** The Infisical command line client, by absolute path, never looked up on PATH. */
  infisical: string;
  /** `env`, used to take the token out of the box's environment. */
  env: string;
  /** The node binary. */
  node: string;
  /** The box's bundled server. */
  box: string;
}

export interface LaunchDeps {
  env: Env;
  paths: LaunchPaths;
  /** Where its own lines go. Nothing written here may hold a credential. */
  log: (line: string) => void;
  /** Subscribes to SIGTERM and SIGINT sent to this process. */
  onSignal: (handler: (signal: NodeJS.Signals) => void) => void;
  /** Whether this process runs as root. */
  isRoot: boolean;
  spawn?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  loginTimeoutMs?: number;
}

export interface LaunchConfig {
  clientId: string;
  clientSecret: string;
  projectId: string;
  environment: string;
  domain: string;
}

export class LaunchConfigError extends Error {}

function required(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') throw new LaunchConfigError(`${name} is not set`);
  return value;
}

/** Infisical's project ids and environment slugs: letters, digits, dashes, underscores. */
const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/**
 * The address of Infisical: https, a host, nothing else. Plain http only for a
 * host without a dot, which is a name on a private container network and
 * never one on the internet (the image test's stand-in for Infisical is one).
 */
export function isAcceptableDomain(value: string): boolean {
  if (value.length > 256 || /[\s"'<>\\]/.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return false;
  if (url.pathname !== '/' && url.pathname !== '') return false;
  if (url.protocol === 'https:') return url.hostname !== '';
  return url.protocol === 'http:' && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(url.hostname);
}

export function readLaunchConfig(env: Env): LaunchConfig {
  const clientId = required(env, 'INFISICAL_UNIVERSAL_AUTH_CLIENT_ID');
  const clientSecret = required(env, 'INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET');
  const projectId = required(env, 'INFISICAL_PROJECT_ID');
  if (!SLUG.test(projectId)) throw new LaunchConfigError('INFISICAL_PROJECT_ID must be a project id');
  const environment = required(env, 'INFISICAL_ENVIRONMENT');
  if (!SLUG.test(environment)) throw new LaunchConfigError('INFISICAL_ENVIRONMENT must be an environment slug');
  const domainText = env.INFISICAL_DOMAIN;
  const domain = domainText === undefined || domainText === '' ? DEFAULT_INFISICAL_DOMAIN : domainText;
  if (!isAcceptableDomain(domain)) throw new LaunchConfigError('INFISICAL_DOMAIN must be an https address with nothing after the host');
  // The one secret comes from Infisical only (decision D12). A copy in the container's own environment
  // would be a second place to rotate it, and the one that is forgotten.
  if (env.BOX_DATABASE_URL !== undefined) throw new LaunchConfigError('BOX_DATABASE_URL must not be set on the container: it comes from Infisical');
  return { clientId, clientSecret, projectId, environment, domain: domain.replace(/\/+$/, '') };
}

/** The environment of every Infisical call: no telemetry, a bounded number of threads, and nothing from the container that could steer it. */
function cliBaseEnv(env: Env): Record<string, string> {
  return {
    PATH: env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: env.HOME ?? '/home/node',
    INFISICAL_DISABLE_TELEMETRY: 'true',
    DO_NOT_TRACK: '1',
    // The client is a Go program, and Go starts a thread per core; the container has a process limit.
    GOMAXPROCS: '2',
  };
}

/** Takes every credential, and anything shaped like a token, out of a text before it is written. */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) if (secret.length >= 4) out = out.split(secret).join('[redacted]');
  return out.replace(/eyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+){1,2}/g, '[redacted]');
}

/** A token as `infisical login --plain` prints it: one line of token characters. */
const TOKEN_PATTERN = /^[A-Za-z0-9._~+/=-]{16,8192}$/;

function statusOf(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  if (signal !== null) return 128 + (osConstants.signals[signal] ?? 0);
  return 1;
}

export async function launch(deps: LaunchDeps): Promise<number> {
  const spawn = deps.spawn ?? nodeSpawn;
  const log = (message: string) => deps.log(`box-launch: ${message}`);

  if (deps.isRoot) {
    log('refusing to run as root');
    return EXIT_CONFIG;
  }

  let config: LaunchConfig;
  try {
    config = readLaunchConfig(deps.env);
  } catch (error) {
    log(error instanceof LaunchConfigError ? error.message : 'the configuration could not be read');
    return EXIT_CONFIG;
  }
  const secrets = [config.clientSecret, config.clientId];

  // One child at a time; a signal goes to whichever is running. A signal before the box runs ends the start.
  let current: ChildProcess | null = null;
  let stopSignal: NodeJS.Signals | null = null;
  deps.onSignal((signal) => {
    if (stopSignal === null) stopSignal = signal;
    if (current && current.exitCode === null && current.signalCode === null) current.kill(signal);
  });

  // 1. Log in. The client id and secret are read by the client from its environment (it reads
  // INFISICAL_UNIVERSAL_AUTH_CLIENT_ID and _SECRET when the flags are absent), never from argv.
  const loginEnv = {
    ...cliBaseEnv(deps.env),
    INFISICAL_UNIVERSAL_AUTH_CLIENT_ID: config.clientId,
    INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET: config.clientSecret,
  };
  const login = spawn(deps.paths.infisical, ['login', '--method=universal-auth', '--silent', '--plain', `--domain=${config.domain}`], {
    env: loginEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  current = login;
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  let outBytes = 0;
  let errBytes = 0;
  login.stdout?.on('data', (chunk: Buffer) => {
    outBytes += chunk.length;
    if (outBytes <= 65_536) out.push(chunk);
  });
  login.stderr?.on('data', (chunk: Buffer) => {
    errBytes += chunk.length;
    if (errBytes <= 8_192) err.push(chunk);
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    login.kill('SIGKILL');
  }, deps.loginTimeoutMs ?? LOGIN_TIMEOUT_MS);
  const loginResult = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>((resolve) => {
    login.on('error', (error) => resolve({ code: null, signal: null, error }));
    login.on('close', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  current = null;

  const token = Buffer.concat(out).toString('utf8').trim();
  const said = redact(Buffer.concat(err).toString('utf8'), [...secrets, token]).trim();

  if (stopSignal !== null) {
    log(`stopped by ${stopSignal} during the login`);
    return statusOf(null, stopSignal);
  }
  if (loginResult.error) {
    log(`the Infisical client could not be started (${(loginResult.error as NodeJS.ErrnoException).code ?? 'error'})`);
    return EXIT_LOGIN;
  }
  if (timedOut) {
    log(`the Infisical login did not finish within ${Math.max(1, Math.round((deps.loginTimeoutMs ?? LOGIN_TIMEOUT_MS) / 1000))} s`);
    return EXIT_LOGIN;
  }
  if (loginResult.code !== 0) {
    log(`the Infisical login failed (status ${statusOf(loginResult.code, loginResult.signal)})${said ? `: ${said.slice(0, 2_000)}` : ''}`);
    return EXIT_LOGIN;
  }
  if (outBytes > 65_536 || !TOKEN_PATTERN.test(token)) {
    log('the Infisical login gave no usable token');
    return EXIT_LOGIN;
  }

  if (stopSignal !== null) {
    log(`stopped by ${stopSignal} before the box was started`);
    return statusOf(null, stopSignal);
  }

  // 2. Run the box inside `infisical run`. The container's environment goes on to the box (its BOX_*
  // settings), less every INFISICAL_ variable; the token is added for `infisical run` only, and `env -u`
  // takes it out again before the box starts, so the box's environment holds no credential.
  const runEnv: Record<string, string> = {};
  for (const [name, value] of Object.entries(deps.env)) {
    if (value === undefined || name.startsWith('INFISICAL_') || name === 'GOMAXPROCS' || name === 'DO_NOT_TRACK') continue;
    runEnv[name] = value;
  }
  Object.assign(runEnv, cliBaseEnv(deps.env), { INFISICAL_TOKEN: token });
  const runArgs = [
    'run',
    '--silent',
    `--domain=${config.domain}`,
    `--projectId=${config.projectId}`,
    `--env=${config.environment}`,
    '--path=/',
    '--',
    deps.paths.env,
    '-u',
    'INFISICAL_TOKEN',
    '-u',
    'INFISICAL_DISABLE_TELEMETRY',
    '-u',
    'DO_NOT_TRACK',
    '-u',
    'GOMAXPROCS',
    deps.paths.node,
    '--disallow-code-generation-from-strings',
    deps.paths.box,
  ];
  const run = spawn(deps.paths.infisical, runArgs, { env: runEnv, stdio: ['ignore', 'inherit', 'inherit'] });
  current = run;
  const runResult = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>((resolve) => {
    run.on('error', (error) => resolve({ code: null, signal: null, error }));
    run.on('exit', (code, signal) => resolve({ code, signal }));
  });
  current = null;
  if (runResult.error) {
    log(`the Infisical client could not be started (${(runResult.error as NodeJS.ErrnoException).code ?? 'error'})`);
    return EXIT_LOGIN;
  }
  const status = statusOf(runResult.code, runResult.signal);
  if (status !== 0) log(`the box ended with status ${status}`);
  return status;
}
