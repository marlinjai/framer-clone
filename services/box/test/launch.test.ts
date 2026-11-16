import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_INFISICAL_DOMAIN, EXIT_CONFIG, EXIT_LOGIN, isAcceptableDomain, launch, readLaunchConfig, redact } from '../src/launch';

// The image's entrypoint, against a stand-in for the Infisical client and a
// stand-in for the box, both small node scripts written to a scratch directory
// at run time. Every process they start is a real one, so what is checked is
// what another process could see: each one's command line and environment, as
// each one records them. Nothing here reaches Infisical: the real client on
// this machine's PATH is never looked up, the stand-in is called by its path.
// Every credential is made from random bytes when the test runs.

const FAKE_INFISICAL = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const dir = __dirname;
const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({ name: args[0], pid: process.pid, argv: process.argv.slice(1), env: process.env }) + '\\n');
if (args[0] === 'login') {
  if (cfg.login === 'hang') setInterval(() => {}, 1000);
  else if (cfg.login === 'fail') {
    process.stderr.write('refused the client ' + process.env.INFISICAL_UNIVERSAL_AUTH_CLIENT_ID + ' with ' + process.env.INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET + '\\n');
    process.exit(1);
  } else if (cfg.login === 'empty') process.exit(0);
  else if (process.env.INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET !== cfg.clientSecret || process.env.INFISICAL_UNIVERSAL_AUTH_CLIENT_ID !== cfg.clientId) {
    process.stderr.write('wrong credentials\\n');
    process.exit(1);
  } else {
    process.stdout.write(cfg.token + '\\n');
    process.exit(0);
  }
} else if (args[0] === 'run') {
  if (process.env.INFISICAL_TOKEN !== cfg.token) {
    process.stderr.write('no token\\n');
    process.exit(1);
  }
  if (cfg.runDies) process.kill(process.pid, cfg.runDies);
  if (cfg.runFails) {
    process.stderr.write('could not fetch the secrets with ' + process.env.INFISICAL_TOKEN + '\\n');
    process.exit(1);
  }
  const command = args.slice(args.indexOf('--') + 1);
  const child = spawn(command[0], command.slice(1), { stdio: 'inherit', env: { ...process.env, BOX_DATABASE_URL: cfg.databaseUrl } });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
  child.on('exit', (code) => process.exit(code === null ? 1 : code));
}
`;

const FAKE_BOX = `
const fs = require('fs');
const path = require('path');
const dir = path.dirname(process.argv[1]);
const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
// The handlers first, then the record the test waits for: a signal can never come before the handler.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({ name: 'box-signal', signal }) + '\\n');
    process.exit(0);
  });
}
process.stderr.write('box: started\\n');
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({ name: 'box', pid: process.pid, argv: process.argv.slice(1), execArgv: process.execArgv, env: process.env }) + '\\n');
if (typeof cfg.boxExit === 'number') process.exit(cfg.boxExit);
setInterval(() => {}, 1000);
`;

interface Call {
  name: string;
  pid?: number;
  argv?: string[];
  execArgv?: string[];
  env?: Record<string, string>;
  signal?: string;
}

const hex = () => randomBytes(16).toString('hex');

let dir: string;
let credentials: { clientId: string; clientSecret: string; token: string; databaseUrl: string };

function writeConfig(extra: Record<string, unknown> = {}) {
  writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ ...credentials, ...extra }));
}

function calls(): Call[] {
  const file = path.join(dir, 'calls.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Call);
}

function baseEnv(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    PATH: process.env.PATH,
    HOME: dir,
    INFISICAL_UNIVERSAL_AUTH_CLIENT_ID: credentials.clientId,
    INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET: credentials.clientSecret,
    INFISICAL_PROJECT_ID: 'test-project',
    INFISICAL_ENVIRONMENT: 'prod',
    BOX_EDITOR_HOST: 'app.example.test',
    CUSTOM_CODE_DISABLED: '0',
    ...extra,
  };
}

function start(env: Record<string, string | undefined>, options: { loginTimeoutMs?: number; isRoot?: boolean } = {}) {
  const lines: string[] = [];
  const stderr: string[] = [];
  let signalHandler: ((signal: NodeJS.Signals) => void) | null = null;
  const done = launch({
    env,
    paths: { infisical: path.join(dir, 'infisical'), env: '/usr/bin/env', node: process.execPath, box: path.join(dir, 'box.cjs') },
    log: (line) => lines.push(line),
    stderr: (text) => stderr.push(text),
    onSignal: (handler) => {
      signalHandler = handler;
    },
    isRoot: options.isRoot ?? false,
    loginTimeoutMs: options.loginTimeoutMs,
  });
  return {
    done,
    lines,
    stderr,
    signal: (signal: NodeJS.Signals) => {
      if (!signalHandler) throw new Error('no signal handler was registered');
      signalHandler(signal);
    },
  };
}

/** The value a promise settles with, or 'still running' after a while: a test that waits on the start must fail on an expectation, never hang. */
async function within<T>(promise: Promise<T>, ms = 8_000): Promise<T | 'still running'> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<'still running'>((resolve) => {
    timer = setTimeout(() => resolve('still running'), ms);
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

async function until(check: () => boolean, what: string, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Every value no command line, log line or box environment may hold. */
function forbidden(): string[] {
  return [credentials.clientId, credentials.clientSecret, credentials.token];
}

function expectNoCredentialIn(text: string, where: string) {
  for (const value of forbidden()) expect(text.includes(value), `${where} holds a credential`).toBe(false);
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'box-launch-'));
  credentials = {
    clientId: `test-client-${hex()}`,
    clientSecret: `test-client-secret-${hex()}`,
    token: `test-token-${hex()}`,
    databaseUrl: `postgres://box_reader:test-password-${hex()}@pg:5432/postgres`,
  };
  writeFileSync(path.join(dir, 'infisical'), FAKE_INFISICAL);
  chmodSync(path.join(dir, 'infisical'), 0o755);
  writeFileSync(path.join(dir, 'box.cjs'), FAKE_BOX);
  writeConfig();
});

afterEach(() => {
  // A test that failed may leave a stand-in running; none outlives its test.
  for (const call of calls()) {
    try {
      if (call.pid) process.kill(call.pid, 'SIGKILL');
    } catch {
      // Already ended.
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('the configuration it reads', { timeout: 20_000 }, () => {
  it.each([
    ['INFISICAL_UNIVERSAL_AUTH_CLIENT_ID', undefined],
    ['INFISICAL_UNIVERSAL_AUTH_CLIENT_ID', ''],
    ['INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET', undefined],
    ['INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET', '  '],
    ['INFISICAL_PROJECT_ID', undefined],
    ['INFISICAL_ENVIRONMENT', undefined],
  ])('stops with status 78 and the name of %s when it is %j, and starts nothing', async (name, value) => {
    const run = start(baseEnv({ [name]: value }));
    expect(await run.done).toBe(EXIT_CONFIG);
    expect(run.lines).toEqual([`box-launch: ${name} is not set`]);
    expect(calls()).toEqual([]);
  });

  it.each([
    ['a project id with a slash', { INFISICAL_PROJECT_ID: 'a/b' }, 'INFISICAL_PROJECT_ID'],
    ['an environment with a space', { INFISICAL_ENVIRONMENT: 'pro d' }, 'INFISICAL_ENVIRONMENT'],
    ['an http address on the internet', { INFISICAL_DOMAIN: 'http://infisical.example.test' }, 'INFISICAL_DOMAIN'],
    ['an address with a path', { INFISICAL_DOMAIN: 'https://infisical.example.test/api' }, 'INFISICAL_DOMAIN'],
    ['an address with credentials', { INFISICAL_DOMAIN: 'https://user:pass@infisical.example.test' }, 'INFISICAL_DOMAIN'],
    ['the database address in the container environment', { BOX_DATABASE_URL: 'postgres://box_reader:x@pg:5432/postgres' }, 'BOX_DATABASE_URL'],
    ['the database address set but empty', { BOX_DATABASE_URL: '' }, 'BOX_DATABASE_URL'],
  ])('stops with status 78 for %s, naming the variable, and starts nothing', async (_what, extra, name) => {
    const run = start(baseEnv(extra));
    expect(await run.done).toBe(EXIT_CONFIG);
    expect(run.lines).toHaveLength(1);
    expect(run.lines[0]).toMatch(new RegExp(`^box-launch: ${name} `));
    expect(run.lines[0]).not.toContain('pass');
    expect(calls()).toEqual([]);
  });

  it('refuses to run as root before it reads anything', async () => {
    const run = start(baseEnv(), { isRoot: true });
    expect(await run.done).toBe(EXIT_CONFIG);
    expect(run.lines).toEqual(['box-launch: refusing to run as root']);
    expect(calls()).toEqual([]);
  });

  it('uses the stack instance unless told otherwise, and takes a trailing slash off', () => {
    expect(readLaunchConfig(baseEnv()).domain).toBe(DEFAULT_INFISICAL_DOMAIN);
    expect(readLaunchConfig(baseEnv({ INFISICAL_DOMAIN: 'https://infisical.example.test/' })).domain).toBe('https://infisical.example.test');
  });

  it('accepts plain http only for a host without a dot', () => {
    expect(isAcceptableDomain('http://fake-infisical:8081')).toBe(true);
    expect(isAcceptableDomain('http://fake-infisical.example.test')).toBe(false);
    expect(isAcceptableDomain('http://127.0.0.1:8081')).toBe(false);
    expect(isAcceptableDomain('ftp://infisical.example.test')).toBe(false);
    expect(isAcceptableDomain('https://infisical.example.test?x=1')).toBe(false);
    expect(isAcceptableDomain('https://infisical.example.test#x')).toBe(false);
  });

  it('redacts every credential and anything shaped like a signed token', () => {
    const secret = `s-${hex()}`;
    const jwtLike = ['eyJ', 'hbGciOiJIUzI1NiJ9', '.', 'e30', '.', 'c2lnbmF0dXJl'].join('');
    expect(redact(`a ${secret} b ${jwtLike} c`, [secret])).toBe('a [redacted] b [redacted] c');
  });
});

describe('the login', { timeout: 20_000 }, () => {
  it('stops with status 69 when the login fails, and passes on what the client said without a credential', async () => {
    writeConfig({ login: 'fail' });
    const run = start(baseEnv());
    expect(await run.done).toBe(EXIT_LOGIN);
    expect(run.lines).toHaveLength(1);
    expect(run.lines[0]).toMatch(/^box-launch: the Infisical login failed \(status 1\): refused the client \[redacted\] with \[redacted\]$/);
    expectNoCredentialIn(run.lines.join('\n'), 'the log');
    expect(calls().map((call) => call.name)).toEqual(['login']);
  });

  it('stops with status 69 when the login gives no token', async () => {
    writeConfig({ login: 'empty' });
    const run = start(baseEnv());
    expect(await run.done).toBe(EXIT_LOGIN);
    expect(run.lines).toEqual(['box-launch: the Infisical login gave no usable token']);
    expect(calls().map((call) => call.name)).toEqual(['login']);
  });

  it('gives up on a login that does not finish', async () => {
    writeConfig({ login: 'hang' });
    const run = start(baseEnv(), { loginTimeoutMs: 3_000 });
    expect(await run.done).toBe(EXIT_LOGIN);
    expect(run.lines).toEqual(['box-launch: the Infisical login did not finish within 3 s']);
    expect(calls().map((call) => call.name)).toEqual(['login']);
  });

  it('stops with status 69 when the client is not there', async () => {
    rmSync(path.join(dir, 'infisical'));
    const run = start(baseEnv());
    expect(await run.done).toBe(EXIT_LOGIN);
    expect(run.lines).toEqual(['box-launch: the Infisical client could not be started (ENOENT)']);
  });

  it('ends on SIGTERM during the login, with 143, and starts no box', async () => {
    writeConfig({ login: 'hang' });
    const run = start(baseEnv());
    await until(() => calls().length === 1, 'the login to start');
    run.signal('SIGTERM');
    expect(await within(run.done)).toBe(143);
    expect(run.lines).toEqual(['box-launch: stopped by SIGTERM during the login']);
    expect(calls().map((call) => call.name)).toEqual(['login']);
  });
});

describe('the box, run inside infisical run', { timeout: 20_000 }, () => {
  async function startedBox() {
    const run = start(baseEnv());
    await until(() => calls().some((call) => call.name === 'box'), 'the box to start');
    return run;
  }

  it('hands the credentials only through environments, never on a command line, and the box none of them', async () => {
    const run = await startedBox();
    run.signal('SIGTERM');
    expect(await within(run.done)).toBe(0);
    const [login, runCall, box] = calls();

    // The login: the client credentials in its environment, nothing secret on its command line.
    expect(login?.name).toBe('login');
    expect(login?.argv?.slice(1)).toEqual(['login', '--method=universal-auth', '--silent', '--plain', `--domain=${DEFAULT_INFISICAL_DOMAIN}`]);
    expect(login?.env?.INFISICAL_UNIVERSAL_AUTH_CLIENT_ID).toBe(credentials.clientId);
    expect(login?.env?.INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET).toBe(credentials.clientSecret);
    // Only what the client needs: not the box's settings, and no telemetry.
    expect(login?.env?.BOX_EDITOR_HOST).toBeUndefined();
    expect(login?.env?.INFISICAL_DISABLE_TELEMETRY).toBe('true');

    // infisical run: the token in its environment, the client credentials nowhere.
    expect(runCall?.name).toBe('run');
    expect(runCall?.env?.INFISICAL_TOKEN).toBe(credentials.token);
    expect(runCall?.env?.INFISICAL_UNIVERSAL_AUTH_CLIENT_ID).toBeUndefined();
    expect(runCall?.env?.INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET).toBeUndefined();
    expect(runCall?.env?.INFISICAL_DISABLE_TELEMETRY).toBe('true');
    expect(runCall?.argv?.slice(1, 7)).toEqual(['run', '--silent', `--domain=${DEFAULT_INFISICAL_DOMAIN}`, '--projectId=test-project', '--env=prod', '--path=/']);
    expect(runCall?.argv?.some((arg) => arg.startsWith('--token'))).toBe(false);

    // The box: its settings and the one secret, and no credential and no INFISICAL_ variable at all.
    expect(box?.name).toBe('box');
    expect(box?.env?.BOX_DATABASE_URL).toBe(credentials.databaseUrl);
    expect(box?.env?.BOX_EDITOR_HOST).toBe('app.example.test');
    expect(box?.env?.CUSTOM_CODE_DISABLED).toBe('0');
    expect(Object.keys(box?.env ?? {}).filter((name) => name.startsWith('INFISICAL_'))).toEqual([]);
    expect(box?.env?.GOMAXPROCS).toBeUndefined();
    expectNoCredentialIn(Object.values(box?.env ?? {}).join('\n'), "the box's environment");
    expect(box?.execArgv).toEqual(['--disallow-code-generation-from-strings']);

    for (const call of calls()) expectNoCredentialIn((call.argv ?? []).join(' '), `the command line of ${call.name}`);
    expectNoCredentialIn(run.lines.join('\n'), 'the log');
    // What the box writes to standard error is passed on.
    expect(run.stderr.join('')).toBe('box: started\n');
  });

  it('passes on what infisical run says when it cannot fetch the secrets, without the token, and ends with its status', async () => {
    writeConfig({ runFails: true });
    const run = start(baseEnv());
    expect(await within(run.done)).toBe(1);
    expect(run.stderr.join('')).toBe('could not fetch the secrets with [redacted]\n');
    expect(run.lines).toEqual(['box-launch: infisical run ended with status 1']);
    expectNoCredentialIn(run.stderr.join(''), 'standard error');
    expect(calls().map((call) => call.name)).toEqual(['login', 'run']);
  });

  it.each(['SIGTERM', 'SIGINT'] as const)('passes %s to the box and ends with its status', async (signal) => {
    const run = await startedBox();
    run.signal(signal);
    expect(await within(run.done)).toBe(0);
    expect(calls().filter((call) => call.name === 'box-signal')).toEqual([{ name: 'box-signal', signal }]);
    expect(run.lines).toEqual([]);
  });

  it('ends with the status the run ended with, and says so', async () => {
    writeConfig({ boxExit: 3 });
    const run = start(baseEnv());
    expect(await within(run.done)).toBe(3);
    expect(run.lines).toEqual(['box-launch: infisical run ended with status 3']);
  });

  it('ends with 128 plus the number of a signal that ended the run', async () => {
    writeConfig({ runDies: 'SIGKILL' });
    const run = start(baseEnv());
    expect(await within(run.done)).toBe(137);
    expect(run.lines).toEqual(['box-launch: infisical run ended with status 137']);
  });

  it('does not take INFISICAL_ variables of the container on to the client or the box', async () => {
    const run = start(baseEnv({ INFISICAL_API_URL: 'https://elsewhere.example.test', INFISICAL_TOKEN: 'test-planted-token-value' }));
    await until(() => calls().some((call) => call.name === 'box'), 'the box to start');
    run.signal('SIGTERM');
    expect(await within(run.done)).toBe(0);
    const [login, runCall, box] = calls();
    expect(login?.env?.INFISICAL_API_URL).toBeUndefined();
    expect(runCall?.env?.INFISICAL_API_URL).toBeUndefined();
    expect(runCall?.env?.INFISICAL_TOKEN).toBe(credentials.token);
    expect(box?.env?.INFISICAL_TOKEN).toBeUndefined();
  });
});
