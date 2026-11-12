// services/box/src/main.ts
//
// Starts the box. It refuses to start as root, without its configuration, or
// with any value it cannot check, and it says which variable was wrong, never
// what the variable held.

import { clientAddressOf, isTrustedPeer } from './clientAddress';
import { ConfigError, isKillSwitchOn, readConfig } from './config';
import { createBoxHandler } from './handler';
import { createBoxServer } from './server';
import { createPostgresStore } from './store';

function fail(message: string): never {
  process.stderr.write(`box: ${message}\n`);
  process.exit(78);
}

function main(): void {
  if (typeof process.getuid === 'function' && process.getuid() === 0) fail('refusing to run as root');

  let config;
  try {
    config = readConfig(process.env);
  } catch (error) {
    fail(error instanceof ConfigError ? error.message : 'the configuration could not be read');
  }

  const store = createPostgresStore(config.databaseUrl);
  const handle = createBoxHandler({ config, store, killSwitchOn: () => isKillSwitchOn(process.env) });
  const proxies = config.trustedProxies;
  const server = createBoxServer({
    handle,
    log: (line) => process.stdout.write(`${JSON.stringify(line)}\n`),
    // Every visitor comes through a configured proxy, so its connections are not counted as one peer's.
    connectionKeyOf: (remoteAddress) => (isTrustedPeer(remoteAddress, proxies) ? null : clientAddressOf(remoteAddress, undefined, []).key),
  });

  server.on('error', (error: NodeJS.ErrnoException) => fail(`cannot listen: ${error.code ?? 'error'}`));
  server.listen(config.port, config.listenHost, () => {
    process.stdout.write(
      // `trustedProxies: 0` behind a proxy means every visitor is counted as that one proxy: said at start, so it is seen.
      `${JSON.stringify({ t: new Date().toISOString(), event: 'listening', port: config.port, serving: !isKillSwitchOn(process.env), trustedProxies: proxies.length })}\n`,
    );
  });

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    setTimeout(() => process.exit(0), 5000).unref();
    server.close(() => {
      store.close().then(
        () => process.exit(0),
        () => process.exit(0),
      );
    });
    server.closeIdleConnections();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  // A fault nobody caught ends the process; the container is started again. Only the kind of fault is written.
  process.on('uncaughtException', (error) => fail(`uncaught ${error instanceof Error ? error.name : 'error'}`));
  process.on('unhandledRejection', () => fail('unhandled rejection'));
}

main();
