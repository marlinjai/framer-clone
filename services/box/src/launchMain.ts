// services/box/src/launchMain.ts
//
// The image's entrypoint (Dockerfile.box), behind tini: logs in to Infisical
// and runs the box inside `infisical run` (src/launch.ts, decision D45).

import { EXIT_LOGIN, launch } from './launch';

const PATHS = {
  infisical: '/usr/local/bin/infisical',
  env: '/usr/bin/env',
  node: process.execPath,
  box: '/app/box.cjs',
};

launch({
  env: process.env,
  paths: PATHS,
  log: (line) => process.stderr.write(`${line}\n`),
  stderr: (text) => process.stderr.write(text),
  onSignal: (handler) => {
    process.on('SIGTERM', handler);
    process.on('SIGINT', handler);
  },
  isRoot: typeof process.getuid === 'function' && process.getuid() === 0,
}).then(
  (status) => process.exit(status),
  () => {
    process.stderr.write('box-launch: the start failed\n');
    process.exit(EXIT_LOGIN);
  },
);
